/**
 * liquidity.ts — HITZ pool liquidity for the Monitor tab's liquidity card.
 *
 * The Worker cron summarizes every registered HITZ pool from its on-chain
 * reserve history (see `summarizeLiquidity` in functions/_lib/price-model.ts,
 * which also owns these types): depth, ±2% depth, cross-pool spread, swap
 * volume and fees, and an hourly TVL series over the last 30 days.
 */

import type { LiquiditySnapshot, PoolLiquidity } from "../../functions/_lib/price-model";
import { fetchSnapshot } from "./api";

export type { LiquiditySnapshot, PoolLiquidity };

/** Resolves null while the snapshot is still being indexed. */
export function fetchLiquidity(): Promise<LiquiditySnapshot | null> {
  return fetchSnapshot<LiquiditySnapshot>("/api/liquidity");
}

/**
 * The pools as one constant-product curve. With prices aligned across pools,
 * an optimal split of a trade behaves like a single pool holding their
 * combined reserves, so this models best execution across all of them.
 */
function combined(pools: PoolLiquidity[]) {
  const usdSide = pools.reduce((s, p) => s + p.quoteReserve * p.quoteUsd, 0);
  const hitz = pools.reduce((s, p) => s + p.hitz, 0);
  const feeBps = pools.reduce((s, p) => s + (p.feeBps ?? 0) * p.share, 0);
  return { x: usdSide, y: hitz, f: 1 - feeBps / 10_000 };
}

/** Price impact (fee-inclusive) of spending `usd` on HITZ: +0.09 = paying 9% over spot. */
export function buyImpact(pools: PoolLiquidity[], usd: number): number | null {
  if (!pools.length) return null;
  const { x, y, f } = combined(pools);
  const out = (y * usd * f) / (x + usd * f);
  return usd / out / (x / y) - 1;
}

/** Price impact (fee-inclusive) of selling `usd` worth of HITZ at spot: −0.09 = receiving 9% under spot. */
export function sellImpact(pools: PoolLiquidity[], usd: number): number | null {
  if (!pools.length) return null;
  const { x, y, f } = combined(pools);
  const spot = x / y;
  const hitzIn = usd / spot;
  const out = (x * hitzIn * f) / (y + hitzIn * f);
  return out / hitzIn / spot - 1;
}
