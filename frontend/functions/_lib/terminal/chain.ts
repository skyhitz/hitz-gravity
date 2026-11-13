// The terminal's view of the chain for payments (checkout.ts's Chain), on the vault API: build the
// payment swap, relay it, read it back. Not run in Node tests (vault-api.ts is bundled by Wrangler);
// checkout.ts is tested against a fake of this interface.

import * as StellarSdk from "@stellar/stellar-sdk";
import { ApiError, buildSwap, hitzView, rpcServer, submitTransaction, usdPrices, vaultCallOf, VAULT_ID } from "../vault-api";
import type { Env } from "../types";
import { CheckoutError, type Chain, type PaidTx } from "./checkout.ts";
import type { PayAsset } from "./plans.ts";
import type { Market } from "./routes.ts";

/** A checkout's swap tolerates this much price movement before it fails (3%). */
const SLIPPAGE_BPS = 300;
/** And stays valid this long (10 minutes). */
const VALID_FOR_S = 600;
const PRICE_FRESH_MS = 15 * 60_000;

let treasuryCache: { at: number; address: string } | null = null;

export function liveChain(env: Env, market: Market | null): Chain {
  const passphrase = env.NETWORK_PASSPHRASE;
  const contractOf = (asset: PayAsset) =>
    asset === "XLM" ? StellarSdk.Asset.native().contractId(passphrase) : new StellarSdk.Asset("USDC", env.USDC_ISSUER).contractId(passphrase);
  const inner = (xdr: string) => {
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, passphrase);
    return tx instanceof StellarSdk.FeeBumpTransaction ? tx.innerTransaction : tx;
  };

  return {
    vaultId: VAULT_ID,
    hitzContract: env.HITZ_CONTRACT_ID,
    contractOf,

    async treasury() {
      if (treasuryCache && Date.now() - treasuryCache.at < 10 * 60_000) return treasuryCache.address;
      const configured = env.TERMINAL_TREASURY?.trim();
      const address = configured || ((await hitzView(env, "admin")) as string | null) || "";
      if (!address) throw new CheckoutError(503, "payments_off", "Payments are not open: no treasury is set.");
      // A payment to an account that is not a registered pool would vault it; refuse instead.
      if ((await hitzView(env, "is_pool", address)) !== true) throw new CheckoutError(503, "payments_off", "Payments are paused: the treasury is not a registered pool.");
      treasuryCache = { at: Date.now(), address };
      return address;
    },

    async xlmUsd() {
      try {
        const o = (await market?.terminalOverview({})) as { price?: { usd?: number; at?: number } | null } | undefined;
        if (o?.price?.usd && o.price.at && Date.now() - o.price.at < PRICE_FRESH_MS) return o.price.usd;
      } catch (err) {
        console.warn("[terminal] price from the data worker", err instanceof Error ? err.message : String(err));
      }
      const usd = await usdPrices(env);
      return usd?.assets.get(contractOf("XLM")) ?? null;
    },

    async buildSwap({ account, sell, amount, to }) {
      const r = await buildSwap(env, { account, sell, buy: "HITZ", amount, to, slippage_bps: SLIPPAGE_BPS, valid_for: VALID_FOR_S });
      const tx = inner(r.xdr) as StellarSdk.Transaction;
      const call = vaultCallOf(tx);
      if (!call) throw new ApiError(502, "upstream_unavailable", "The payment swap could not be built.");
      return {
        xdr: r.xdr,
        hash: tx.hash().toString("hex"),
        validUntil: r.valid_until ? Date.parse(r.valid_until) : null,
        expectedHitz: r.buy.expected.amount,
        argsXdr: call.args.map((a) => a.toXDR("base64")),
      };
    },

    async submit(xdr) {
      const r = await submitTransaction(env, xdr);
      return { hash: r.hash };
    },

    hashOf(xdr) {
      try {
        return inner(xdr).hash().toString("hex");
      } catch {
        throw new CheckoutError(400, "invalid_xdr", "xdr is not a Stellar transaction envelope.");
      }
    },

    async readTx(hash): Promise<PaidTx | null> {
      const res = await rpcServer(env).getTransaction(hash);
      if (res.status === "NOT_FOUND") return null;
      const envelope = res.envelopeXdr;
      const tx =
        envelope.switch().name === "envelopeTypeTxFeeBump"
          ? new StellarSdk.FeeBumpTransaction(envelope, passphrase).innerTransaction
          : new StellarSdk.Transaction(envelope, passphrase);
      const call = vaultCallOf(tx);
      let swap: PaidTx["call"] = null;
      if (call && call.method === "swap" && call.args.length === 6) {
        const [from, to, tokenIn, tokenOut, amountIn, minOut] = call.args.map((a) => StellarSdk.scValToNative(a));
        swap = { from: String(from), to: String(to), tokenIn: String(tokenIn), tokenOut: String(tokenOut), amountIn: BigInt(amountIn as bigint), minOut: BigInt(minOut as bigint) };
      }
      const ok = res.status === "SUCCESS";
      return {
        hash,
        status: ok ? "SUCCESS" : "FAILED",
        closedAt: Number(res.createdAt) * 1000,
        call: swap,
        bought: ok && res.returnValue ? BigInt(StellarSdk.scValToNative(res.returnValue) as bigint) : null,
      };
    },
  };
}
