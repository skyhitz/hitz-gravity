// A simulated Stellar network for the arbitrage bot's tests: Horizon and
// Soroban RPC behind `fetch`, backed by the vault's exact math
// (app/lib/vaultMath.ts), a two-sided SDEX price and account balances.
//
// It applies the transactions the bot really builds, decoded from their XDR,
// with the checks the network makes: the source's signature, the sequence
// number, time bounds, one pending transaction per account, balances and
// reserves, a path payment's dest_min and the vault's min_out. Answers have
// the shape of the real ones (Horizon's JSON, RPC's base64 XDR), so the
// bot's own parsing runs too. Time only moves when the bot sleeps: ledgers
// close every 5 seconds of that clock.

import * as StellarSdk from "@stellar/stellar-sdk";
import { poolState, swap, VaultMathError } from "../../app/lib/vaultMath.ts";

const { xdr } = StellarSdk;

export const PASSPHRASE = StellarSdk.Networks.PUBLIC;
export const VAULT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";
export const HITZ = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
export const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const USDC = new StellarSdk.Asset("USDC", USDC_ISSUER);
export const XLM_SAC = StellarSdk.Asset.native().contractId(PASSPHRASE);
export const USDC_SAC = USDC.contractId(PASSPHRASE);

/** The vault as it stood on mainnet on Nov 11, 2026: 1 XLM = 0.15957 USDC, nothing dislocated. */
export const MAINNET_POOLS = [
  { asset: XLM_SAC, hitz: 509_693_908_169_577n, reserve: 108_600_829_318n, deviation: 0n },
  { asset: USDC_SAC, hitz: 374_510_844_986_055n, reserve: 12_733_312_125n, deviation: 0n },
];

const UNIT = 10_000_000n;
const BASE_RESERVE = 5_000_000n;
const CLASSIC_FEE = 100n;
const LEDGER_SECONDS = 5;

export const units = (decimal) => {
  const [w, f = ""] = String(decimal).split(".");
  return BigInt(w) * UNIT + BigInt((f + "0000000").slice(0, 7));
};
export const decimal = (raw) => {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  return `${neg ? "-" : ""}${abs / UNIT}.${(abs % UNIT).toString().padStart(7, "0")}`;
};

const i128 = (v) => StellarSdk.nativeToScVal(v, { type: "i128" });
const mapEntry = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function txResult(feeCharged, body) {
  return new xdr.TransactionResult({ feeCharged: new xdr.Int64(feeCharged.toString()), result: body, ext: new xdr.TransactionResultExt(0) }).toXDR("base64");
}

function sorobanMeta(returnValue) {
  return new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMetaV2({ ext: new xdr.SorobanTransactionMetaExt(0), returnValue }),
      events: [],
      diagnosticEvents: [],
    })
  ).toXDR("base64");
}

/**
 * @param {{ bid: number, ask: number, pools?: typeof MAINNET_POOLS, time?: number, resourceFee?: bigint }} options
 *   `bid` / `ask`: USDC per XLM on the SDEX when selling / buying XLM.
 *   `resourceFee`: what a vault swap's simulation asks for, in stroops (0.0021452 XLM, as on mainnet).
 */
export function makeLedger({ bid, ask, pools = MAINNET_POOLS, time = 1_794_420_000, resourceFee: RESOURCE_FEE = 21_452n }) {
  const accounts = new Map();
  const transactions = new Map();
  let pending = [];
  let ledgerSeq = 65_427_000;

  const ledger = {
    time,
    /** The SDEX: set to null for "no route". */
    sdex: { bid, ask },
    pools: pools.map((p) => ({ ...p, updated: BigInt(Math.floor(time)) })),
    /** Every HTTP request the bot made: "horizon /accounts", "rpc sendTransaction", ... */
    calls: [],
    /** Every transaction accepted for inclusion, in order, with what became of it. */
    submitted: [],
    /** Test hooks. */
    onSubmit: null, // (entry) => void, right after a transaction is accepted
    onApplied: null, // (entry) => void, right after a transaction is applied
    drop: null, // (entry) => boolean: accepted, then never included
    rpcDown: null, // (method) => boolean: answer that RPC call with HTTP 503
    horizonDown: null, // (path) => boolean
    tryAgainLater: 0, // answer this many sendTransaction calls with TRY_AGAIN_LATER
    omitMeta: false, // getTransaction without resultMetaXdr

    fund(address, { xlm = "0", usdc = null, sequence = 1000n } = {}) {
      accounts.set(address, { xlm: units(xlm), usdc: usdc === null ? null : units(usdc), sequence: BigInt(sequence), subentries: usdc === null ? 0 : 1 });
      return ledger;
    },
    account(address) {
      const a = accounts.get(address);
      return a ? { ...a } : null;
    },
    now() {
      return BigInt(Math.floor(ledger.time));
    },
    /** The vault's XLM price in USDC, before fees. */
    vaultRate() {
      const [x, u] = ledger.pools;
      return Number(u.reserve) / Number(u.hitz) / (Number(x.reserve) / Number(x.hitz));
    },
    /** Someone else's swap, applied at once. */
    swapAsOther(tokenIn, tokenOut, amount) {
      const r = swap(ledger.pools, tokenIn, tokenOut, units(amount), ledger.now(), HITZ);
      ledger.pools = r.pools;
      return r.amountOut;
    },
    sdexOut(sellNative, amount) {
      if (!ledger.sdex) return null;
      return sellNative ? BigInt(Math.floor(Number(amount) * ledger.sdex.bid)) : BigInt(Math.floor(Number(amount) / ledger.sdex.ask));
    },
    io: {
      fetch: (input, init) => handle(String(input), init),
      sleep: async (ms) => {
        ledger.time += ms / 1000;
      },
      now: () => Math.floor(ledger.time * 1000),
    },
  };

  const head = () => ({ latestLedger: ledgerSeq, latestLedgerCloseTime: String(Math.floor(ledger.time)), oldestLedger: ledgerSeq - 120_960, oldestLedgerCloseTime: String(Math.floor(ledger.time) - 604_800) });

  function minBalance(a) {
    return (2n + BigInt(a.subentries)) * BASE_RESERVE;
  }

  /** Close the ledgers the clock has passed, applying what is due. */
  function tick() {
    const due = pending.filter((e) => e.applyAt <= ledger.time);
    pending = pending.filter((e) => e.applyAt > ledger.time);
    for (const entry of due) {
      ledgerSeq++;
      if (ledger.drop?.(entry) || Number(entry.tx.timeBounds.maxTime) < entry.applyAt) {
        entry.status = "DROPPED";
        continue;
      }
      apply(entry);
      ledger.onApplied?.(entry);
    }
  }

  function apply(entry) {
    const { tx, op } = entry;
    const source = accounts.get(tx.source);
    source.sequence += 1n;
    const done = (status, feeCharged, resultXdr, extra = {}) => {
      source.xlm -= feeCharged;
      entry.status = status;
      entry.feeCharged = feeCharged;
      transactions.set(entry.hash, { status, resultXdr, envelopeXdr: tx.toXDR(), ledger: ledgerSeq, createdAt: Math.floor(entry.applyAt), applicationOrder: 1, feeBump: false, ...extra });
    };
    const failed = (fee, opResult) => done("FAILED", fee, txResult(fee, xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(opResult)])));
    const succeeded = (fee, opResult, extra) => done("SUCCESS", fee, txResult(fee, xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(opResult)])), extra);

    if (op.type === "pathPaymentStrictSend") {
      const tr = (r) => xdr.OperationResultTr.pathPaymentStrictSend(r);
      const sellNative = op.sendAsset.isNative();
      const amount = units(op.sendAmount);
      const out = ledger.sdexOut(sellNative, amount);
      const spendable = sellNative ? source.xlm - minBalance(source) - CLASSIC_FEE : source.usdc ?? 0n;
      if (!sellNative && source.usdc === null) return failed(CLASSIC_FEE, tr(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendSrcNoTrust()));
      if (amount > spendable) return failed(CLASSIC_FEE, tr(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendUnderfunded()));
      if (out === null) return failed(CLASSIC_FEE, tr(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendTooFewOffers()));
      if (out < units(op.destMin)) return failed(CLASSIC_FEE, tr(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendUnderDestmin()));
      const dest = accounts.get(op.destination);
      if (sellNative) {
        source.xlm -= amount;
        dest.usdc += out;
      } else {
        source.usdc -= amount;
        dest.xlm += out;
      }
      entry.received = out;
      const last = new xdr.SimplePaymentResult({
        destination: StellarSdk.Keypair.fromPublicKey(op.destination).xdrAccountId(),
        asset: op.destAsset.toXDRObject(),
        amount: new xdr.Int64(out.toString()),
      });
      return succeeded(CLASSIC_FEE, tr(xdr.PathPaymentStrictSendResult.pathPaymentStrictSendSuccess(new xdr.PathPaymentStrictSendResultSuccess({ offers: [], last }))));
    }

    if (op.type === "changeTrust") {
      if (source.usdc === null) {
        source.usdc = 0n;
        source.subentries += 1;
      }
      return succeeded(CLASSIC_FEE, xdr.OperationResultTr.changeTrust(xdr.ChangeTrustResult.changeTrustSuccess()));
    }

    // The vault: swap(from, to, token_in, token_out, amount_in, min_out).
    const fee = RESOURCE_FEE + 200n;
    const tr = (r) => xdr.OperationResultTr.invokeHostFunction(r);
    const call = swapCall(tx);
    const result = call ? runSwap(call) : { error: "not a vault swap" };
    if (result.error) {
      entry.error = result.error;
      return failed(fee, tr(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()));
    }
    ledger.pools = result.pools;
    credit(source, call.tokenIn, -call.amountIn);
    credit(accounts.get(call.to), call.tokenOut, result.amountOut);
    entry.received = result.amountOut;
    return succeeded(fee, tr(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(Buffer.alloc(32))), ledger.omitMeta ? {} : { resultMetaXdr: sorobanMeta(i128(result.amountOut)) });
  }

  function credit(account, token, amount) {
    if (token === XLM_SAC) account.xlm += amount;
    else account.usdc += amount;
  }

  function swapCall(tx) {
    const op = tx.operations[0];
    if (op.type !== "invokeHostFunction" || op.func.switch().name !== "hostFunctionTypeInvokeContract") return null;
    const invoke = op.func.invokeContract();
    if (StellarSdk.Address.fromScAddress(invoke.contractAddress()).toString() !== VAULT) return null;
    const name = invoke.functionName().toString();
    const args = invoke.args().map((a) => StellarSdk.scValToNative(a));
    if (name !== "swap") return { name };
    const [from, to, tokenIn, tokenOut, amountIn, minOut] = args;
    return { name, source: tx.source, from, to, tokenIn, tokenOut, amountIn: BigInt(amountIn), minOut: BigInt(minOut) };
  }

  /** The contract's checks, in its order: auth, amounts, the math, min_out, the transfer in. */
  function runSwap(call) {
    if (call.from !== call.source) return { error: "HostError: Error(Auth, InvalidAction)" };
    if (call.amountIn <= 0n || call.minOut < 0n) return { error: "HostError: Error(Contract, #1)" };
    let r;
    try {
      r = swap(ledger.pools, call.tokenIn, call.tokenOut, call.amountIn, ledger.now(), HITZ);
    } catch (err) {
      if (err instanceof VaultMathError) return { error: `HostError: Error(Contract, ${err.message})` };
      throw err;
    }
    if (r.amountOut < call.minOut) return { error: "HostError: Error(Contract, #3)" };
    const from = accounts.get(call.from);
    const to = accounts.get(call.to);
    if (!from || !to) return { error: "HostError: Error(Storage, MissingValue)" };
    const have = call.tokenIn === XLM_SAC ? from.xlm - minBalance(from) : from.usdc ?? -1n;
    if (have < call.amountIn) return { error: "HostError: Error(Contract, #10)" };
    if (call.tokenOut === USDC_SAC && to.usdc === null) return { error: "HostError: Error(Contract, #13)" };
    return r;
  }

  // ─── Soroban RPC ───────────────────────────────────────────────────────────

  function rpc(method, params) {
    ledger.calls.push(`rpc ${method}`);
    if (ledger.rpcDown?.(method)) return new Response("unavailable", { status: 503 });
    tick();
    const ok = (result) => json({ jsonrpc: "2.0", id: 1, result });

    if (method === "simulateTransaction") {
      const tx = StellarSdk.TransactionBuilder.fromXDR(params.transaction, PASSPHRASE);
      const call = swapCall(tx);
      const success = (retval) =>
        ok({
          latestLedger: ledgerSeq,
          minResourceFee: RESOURCE_FEE.toString(),
          results: [{ auth: [], xdr: retval.toXDR("base64") }],
          transactionData: new StellarSdk.SorobanDataBuilder().setResourceFee(RESOURCE_FEE.toString()).build().toXDR("base64"),
          events: [],
        });
      if (call?.name === "pools") {
        const now = ledger.now();
        return success(
          xdr.ScVal.scvVec(
            ledger.pools.map((_, i) => {
              const s = poolState(ledger.pools, i, now);
              return xdr.ScVal.scvMap([
                mapEntry("asset", StellarSdk.Address.fromString(s.asset).toScVal()),
                mapEntry("deviation", i128(s.deviation)),
                mapEntry("dislocation", i128(s.dislocation)),
                mapEntry("fee", i128(s.fee)),
                mapEntry("hitz", i128(s.hitz)),
                mapEntry("reserve", i128(s.reserve)),
              ]);
            })
          )
        );
      }
      if (call?.name === "swap") {
        const r = runSwap(call);
        return r.error ? ok({ error: `${r.error}\n\nEvent log (newest first):\n   0: [Diagnostic Event] ...`, latestLedger: ledgerSeq, events: [] }) : success(i128(r.amountOut));
      }
      return ok({ error: "HostError: Error(WasmVm, MissingValue)", latestLedger: ledgerSeq, events: [] });
    }

    if (method === "sendTransaction") {
      const tx = StellarSdk.TransactionBuilder.fromXDR(params.transaction, PASSPHRASE);
      const hash = tx.hash().toString("hex");
      const reject = (code) => ok({ status: "ERROR", hash, errorResultXdr: txResult(0n, xdr.TransactionResultResult[code]()), ...head() });
      const source = accounts.get(tx.source);
      if (!source) return reject("txNoAccount");
      if (ledger.tryAgainLater > 0 || pending.some((e) => e.tx.source === tx.source)) {
        if (ledger.tryAgainLater > 0) ledger.tryAgainLater--;
        return ok({ status: "TRY_AGAIN_LATER", hash, ...head() });
      }
      const signed = tx.signatures.some((s) => StellarSdk.Keypair.fromPublicKey(tx.source).verify(tx.hash(), s.signature()));
      if (!signed) return reject("txBadAuth");
      if (BigInt(tx.sequence) !== source.sequence + 1n) return reject("txBadSeq");
      if (!tx.timeBounds || Number(tx.timeBounds.maxTime) < ledger.time) return reject("txTooLate");
      const op = tx.operations[0];
      const soroban = op.type === "invokeHostFunction";
      if (tx.operations.length !== 1) return reject("txMalformed");
      if (soroban && !tx.toEnvelope().v1().tx().ext().sorobanData()) return reject("txSorobanInvalid");
      if (BigInt(tx.fee) < (soroban ? RESOURCE_FEE + 100n : CLASSIC_FEE)) return reject("txInsufficientFee");
      const entry = { hash, tx, op, type: soroban ? swapCall(tx)?.name ?? "invoke" : op.type, call: soroban ? swapCall(tx) : null, status: "PENDING", applyAt: (Math.floor(ledger.time / LEDGER_SECONDS) + 1) * LEDGER_SECONDS };
      pending.push(entry);
      ledger.submitted.push(entry);
      ledger.onSubmit?.(entry);
      return ok({ status: "PENDING", hash, ...head() });
    }

    if (method === "getTransaction") {
      const found = transactions.get(params.hash);
      return ok(found ? { ...head(), txHash: params.hash, ...found } : { ...head(), status: "NOT_FOUND", txHash: params.hash });
    }
    return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
  }

  // ─── Horizon ───────────────────────────────────────────────────────────────

  function horizon(url) {
    const path = url.pathname;
    ledger.calls.push(`horizon ${path.startsWith("/accounts/") ? "/accounts" : path}`);
    if (ledger.horizonDown?.(path)) return new Response("unavailable", { status: 503 });
    tick();
    if (path.startsWith("/accounts/")) {
      const id = path.slice("/accounts/".length);
      const a = accounts.get(id);
      if (!a) return json({ type: "https://stellar.org/horizon-errors/not_found", title: "Resource Missing", status: 404 }, 404);
      const zero = "0.0000000";
      return json({
        id,
        account_id: id,
        sequence: a.sequence.toString(),
        subentry_count: a.subentries,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          ...(a.usdc === null
            ? []
            : [{ balance: decimal(a.usdc), limit: "922337203685.4775807", buying_liabilities: zero, selling_liabilities: zero, is_authorized: true, asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER }]),
          { balance: decimal(a.xlm), buying_liabilities: zero, selling_liabilities: zero, asset_type: "native" },
        ],
      });
    }
    if (path === "/paths/strict-send") {
      const q = url.searchParams;
      const sellNative = q.get("source_asset_type") === "native";
      const amount = units(q.get("source_amount"));
      const out = ledger.sdexOut(sellNative, amount);
      const side = (prefix, native) => (native ? { [`${prefix}_asset_type`]: "native" } : { [`${prefix}_asset_type`]: "credit_alphanum4", [`${prefix}_asset_code`]: "USDC", [`${prefix}_asset_issuer`]: USDC_ISSUER });
      const records = out === null || out <= 0n ? [] : [{ ...side("source", sellNative), source_amount: decimal(amount), ...side("destination", !sellNative), destination_amount: decimal(out), path: [] }];
      return json({ _embedded: { records } });
    }
    return json({ status: 404 }, 404);
  }

  async function handle(input, init) {
    const url = new URL(input);
    if (url.host === "rpc.test") {
      const { method, params } = JSON.parse(init.body);
      return rpc(method, params);
    }
    if (url.host === "horizon.test") return horizon(url);
    throw new Error(`the bot called an unexpected host: ${url.host}`);
  }

  return ledger;
}

/** The bot's configuration against a simulated ledger. */
export function botConfig(ledger, keypair, overrides = {}) {
  return {
    rpcUrl: "https://rpc.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: PASSPHRASE,
    vault: VAULT,
    hitz: HITZ,
    usdcIssuer: USDC_ISSUER,
    address: keypair.publicKey(),
    keypair,
    live: true,
    minProfitXlm: 0.02,
    minProfitBps: 30,
    maxTradeXlm: 150,
    feeBufferXlm: 5,
    io: ledger.io,
    ...overrides,
  };
}
