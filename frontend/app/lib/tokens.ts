/**
 * tokens.ts: display metadata and balances for HITZ and the vault's assets.
 *
 * Symbols and decimals are read from each token contract at runtime
 * (`symbol()` / `decimals()`), so an asset the vault lists later renders
 * without a code change. Stellar asset contracts report `CODE:ISSUER`; we
 * keep the code, and the native one ("native") shows as XLM.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { CONTRACT_ID, simulate } from "./stellar";

export const HITZ_ADDRESS = CONTRACT_ID;
/** Stellar asset contract of native XLM on mainnet. */
export const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
/** Stellar asset contract of Circle's USDC on mainnet. */
export const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

export interface TokenInfo {
  address: string;
  /** Short symbol, `:ISSUER` suffix trimmed. */
  symbol: string;
  decimals: number;
  /** CSS color for dots and labels; stable per address. */
  color: string;
}

const FIXED: Record<string, Omit<TokenInfo, "address">> = {
  [HITZ_ADDRESS]: { symbol: "HITZ", decimals: 7, color: "var(--purple)" },
  [XLM_SAC]: { symbol: "XLM", decimals: 7, color: "var(--accent)" },
  [USDC_SAC]: { symbol: "USDC", decimals: 7, color: "var(--green)" },
};

const PALETTE = ["var(--yellow)", "var(--orange)", "var(--green)", "var(--accent)"];

function colorFor(address: string): string {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const cache = new Map<string, Promise<TokenInfo | null>>();

/** Known tokens resolve without a network call; others ask the contract once. */
export function knownToken(address: string): TokenInfo | null {
  const f = FIXED[address];
  return f ? { address, ...f } : null;
}

export function getTokenInfo(address: string): Promise<TokenInfo | null> {
  const known = knownToken(address);
  if (known) return Promise.resolve(known);
  let p = cache.get(address);
  if (!p) {
    p = (async () => {
      try {
        const [sym, dec] = await Promise.all([simulate(address, "symbol"), simulate(address, "decimals")]);
        const raw = String(StellarSdk.scValToNative(sym));
        const code = raw.split(":")[0].trim() || raw;
        const decimals = Number(StellarSdk.scValToNative(dec));
        return {
          address,
          symbol: code === "native" ? "XLM" : code,
          decimals: Number.isFinite(decimals) ? decimals : 7,
          color: colorFor(address),
        };
      } catch {
        cache.delete(address); // retry on the next call
        return null;
      }
    })();
    cache.set(address, p);
  }
  return p;
}

/** Metadata for many tokens; ones that don't resolve are left out. */
export async function getTokenInfos(addresses: string[]): Promise<Map<string, TokenInfo>> {
  const unique = [...new Set(addresses)];
  const infos = await Promise.all(unique.map(getTokenInfo));
  const out = new Map<string, TokenInfo>();
  unique.forEach((a, i) => {
    const info = infos[i];
    if (info) out.set(a, info);
  });
  return out;
}

export type BalanceRead =
  | { status: "ok"; amount: bigint }
  /** A classic account without a trustline to this asset: it can't receive it yet. */
  | { status: "no-trustline" }
  | { status: "error"; error: string };

/**
 * `balance(account)` on a token contract. For a Stellar asset contract and a
 * classic account without the trustline, the call fails; we report that
 * separately because receiving the asset would fail the same way.
 */
export async function readBalance(token: string, account: string): Promise<BalanceRead> {
  try {
    const v = await simulate(token, "balance", [StellarSdk.Address.fromString(account).toScVal()]);
    return { status: "ok", amount: BigInt(StellarSdk.scValToNative(v) as bigint | number | string) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The asset contract's TrustlineMissingError is contract error #13.
    if (/trustline|Error\(Contract, #13\)/i.test(msg)) return { status: "no-trustline" };
    return { status: "error", error: msg };
  }
}
