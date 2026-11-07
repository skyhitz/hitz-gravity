/**
 * vault.ts: client for the HITZ Sovereign Vault, HITZ's own exchange.
 *
 * One constant-product pool per trusted asset (XLM and USDC at launch), each
 * against HITZ. HITZ ↔ asset is one hop; asset ↔ asset is two hops through
 * HITZ, in one `swap` call. The fee is 1% when the vault is calm and rises
 * while a trade dislocates one asset against another, up to 10%.
 *
 * Quotes are computed locally from `pools()` with the exact port of the
 * contract math (vaultMath.ts), which also gives the per-hop fees; the
 * on-chain `quote` simulation stays the authority for the amount we sign.
 * Contract reference: contracts/sovereign-vault/INTEGRATION.md.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { simulate } from "./stellar";
import { HITZ_ADDRESS } from "./tokens";
import { applySlippage } from "./swap";
import type { PoolState } from "./vaultMath";

export const VAULT_ID = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";

const addr = (a: string) => StellarSdk.Address.fromString(a).toScVal();
const i128 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "i128" });
const big = (v: unknown): bigint => BigInt(v as bigint | number | string);

/** Every pool, in listing order, brought up to the current ledger time. */
export async function readPools(): Promise<PoolState[]> {
  const raw = StellarSdk.scValToNative(await simulate(VAULT_ID, "pools")) as Record<string, unknown>[];
  return raw.map((p) => ({
    asset: String(p.asset),
    hitz: big(p.hitz),
    reserve: big(p.reserve),
    deviation: big(p.deviation),
    dislocation: big(p.dislocation),
    fee: big(p.fee),
  }));
}

/** What `swap` would pay out right now (the contract's own `quote`). */
export async function quoteOnChain(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
  return big(StellarSdk.scValToNative(await simulate(VAULT_ID, "quote", [addr(tokenIn), addr(tokenOut), i128(amountIn)])));
}

export interface VaultStatus {
  admin: string | null;
  /** False once `renounce_upgrades` or `renounce` has run. */
  upgradable: boolean;
  pendingUpgrade: { wasmHash: string; eta: number } | null;
  pendingListing: { asset: string; eta: number } | null;
}

export async function readVaultStatus(): Promise<VaultStatus> {
  const [admin, upgradable, upgrade, listing] = await Promise.all(
    ["admin", "upgradable", "pending_upgrade", "pending_listing"].map(async (m) =>
      StellarSdk.scValToNative(await simulate(VAULT_ID, m))
    )
  );
  const u = upgrade as { wasm_hash: Uint8Array; eta: bigint } | null | undefined;
  const l = listing as { asset: string; eta: bigint } | null | undefined;
  return {
    admin: (admin as string | null | undefined) ?? null,
    upgradable: upgradable === true,
    pendingUpgrade: u ? { wasmHash: Buffer.from(u.wasm_hash).toString("hex"), eta: Number(u.eta) } : null,
    pendingListing: l ? { asset: String(l.asset), eta: Number(l.eta) } : null,
  };
}

/** A contract call ready for `callContract` (wallet signing or the email gateway). */
export interface ContractCall {
  contractId: string;
  method: string;
  args: StellarSdk.xdr.ScVal[];
}

/** `swap(from, to, token_in, token_out, amount_in, min_out)`, paying out to the signer. */
export function swapCall(args: {
  account: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** The quoted output; `min_out` is this minus the slippage budget. */
  expectedOut: bigint;
  slippageBps: number;
}): ContractCall {
  const minOut = applySlippage(args.expectedOut, args.slippageBps);
  return {
    contractId: VAULT_ID,
    method: "swap",
    args: [addr(args.account), addr(args.account), addr(args.tokenIn), addr(args.tokenOut), i128(args.amountIn), i128(minOut)],
  };
}

/**
 * `deposit(from, asset, hitz, min_amount, max_amount)`: add liquidity to an
 * asset's pool at its current ratio. Anyone can; there are no shares and no
 * withdrawals. The bounds cap the price the deposit accepts.
 */
export function depositCall(args: {
  account: string;
  asset: string;
  hitz: bigint;
  minAmount: bigint;
  maxAmount: bigint;
}): ContractCall {
  return {
    contractId: VAULT_ID,
    method: "deposit",
    args: [addr(args.account), addr(args.asset), i128(args.hitz), i128(args.minAmount), i128(args.maxAmount)],
  };
}

/** The asset a deposit of `hitz` adds at the pool's ratio (rounded up, as the contract does). */
export function depositAmount(pool: PoolState, hitz: bigint): bigint {
  return (hitz * pool.reserve + pool.hitz - 1n) / pool.hitz;
}

/** The pool's HITZ price in its asset (asset units per HITZ, as a float). */
export function poolPrice(pool: PoolState): number {
  return Number(pool.reserve) / Number(pool.hitz);
}

export { HITZ_ADDRESS };

/** Contract error codes (INTEGRATION.md), for readable failures. */
export const VAULT_ERRORS: Record<number, string> = {
  1: "InvalidAmount",
  2: "UnsupportedPair",
  3: "Slippage: the price moved past your tolerance",
  4: "NotSeeded",
  6: "PriceOutOfRange",
  7: "InvalidAddress",
  9: "InvalidPool",
  10: "TradeTooSmall: the output rounds to zero after the fee",
  11: "Overflow",
};

/**
 * Turn a simulation or submission error into something a person can read.
 * Token failures come first (their codes overlap the vault's: the asset
 * contracts' #10 is an insufficient balance), then the vault's own errors,
 * matched only on an error event the vault itself raised.
 */
export function explainVaultError(message: string): string {
  if (/balance is not sufficient|insufficient balance/i.test(message)) return "Insufficient balance for this trade.";
  if (/trustline/i.test(message)) {
    return "Your account has no trustline for an asset in this trade. Add it in your wallet first.";
  }
  if (/Account is vaulted/i.test(message)) {
    return "Your account is vaulted: it can only send HITZ to a registered pool, such as the vault.";
  }
  const own = new RegExp(`contract:${VAULT_ID}, topics:\\[error, Error\\(Contract, #(\\d+)\\)\\]`).exec(message);
  const name = own ? VAULT_ERRORS[Number(own[1])] : undefined;
  return name ? `Vault: ${name}` : message;
}
