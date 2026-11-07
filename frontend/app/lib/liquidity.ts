/**
 * liquidity.ts: the Sovereign Vault's liquidity for the Monitor tab.
 *
 * The Worker cron summarizes every active HITZ pool (today, the vault's
 * pools) from its on-chain reserve history (see `summarizeLiquidity` in
 * functions/_lib/price-model.ts, which also owns these types): depth, ±2%
 * depth, the price gap between pools, swap volume and fees, and an hourly
 * TVL series over the last 30 days. Live fees, depth and impact are
 * computed in the card from the vault itself.
 */

import type { LiquiditySnapshot, PoolLiquidity } from "../../functions/_lib/price-model";
import { fetchSnapshot } from "./api";

export type { LiquiditySnapshot, PoolLiquidity };

/** Resolves null while the snapshot is still being indexed. */
export function fetchLiquidity(): Promise<LiquiditySnapshot | null> {
  return fetchSnapshot<LiquiditySnapshot>("/api/liquidity");
}
