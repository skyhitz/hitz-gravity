/**
 * aggregator.ts — Multi-path liquidity aggregator.
 *
 * Strategy
 * ────────
 *   1. Enumerate every direct + 2-hop path from `tokenIn` to `tokenOut`
 *      using only the pools the caller passes in. The pool graph itself
 *      decides which intermediate tokens can act as bridges — any token
 *      that appears in pools touching both `tokenIn` and `tokenOut`
 *      qualifies. There is no hardcoded bridge list.
 *   2. Ask the Aqua router (via `aqua.getAmountsOut`, bound to the same
 *      pool graph) for the expected output of each path at 100% size —
 *      this is the "single-path quote".
 *   3. Keep the top K paths by output, then search for the optimal split
 *      between the top 2 using 10% increments (0/100, 10/90, … 100/0).
 *      The split that maximises total output wins.
 *   4. Return the aggregate plan, including per-path percentages, absolute
 *      outputs, price impact, and a "savings vs best single path" number.
 *
 * Paths and pools are addressed by raw contract address everywhere —
 * symbols are a UI concern resolved separately via `getTokenInfo`.
 */

import { getAmountsOut, findPool, type PoolInfo } from "./aqua";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A path is an ordered list of token addresses, length ≥ 2. */
export interface Path {
  /** Address list: [tokenIn, ...bridges, tokenOut]. */
  hops: string[];
  /** Pool addresses touched, length = hops.length - 1. */
  pools: string[];
  /** "direct" for 2-hop, "bridged" for 3-hop. */
  kind: "direct" | "bridged";
}

export interface PathQuote {
  path: Path;
  /** Input amount in stroops routed through this path. */
  amountIn: bigint;
  /** Expected output in stroops for this path at its allocated amountIn. */
  amountOut: bigint;
}

export interface Distribution {
  /** Allocations whose percentages sum to 100 (integers). */
  legs: { path: Path; percent: number; amountIn: bigint; amountOut: bigint }[];
  /** Sum of all leg outputs. */
  totalOut: bigint;
}

export interface AggregationResult {
  /** The chosen distribution (always at least one leg). */
  distribution: Distribution;
  /** The single-best path output (for "savings" comparison + execution fallback). */
  bestSinglePathOut: bigint;
  /** Stroops saved vs best single path (≥ 0). */
  savings: bigint;
  /** True if the distribution spreads across more than one path. */
  isSplit: boolean;
  /** Approximate overall price impact, in percent. */
  priceImpactPct: number;
}

// ─── Path generation ─────────────────────────────────────────────────────────

/**
 * Builds every usable path from `tokenIn` to `tokenOut` using only the
 * provided pool graph:
 *
 *   • A direct `[tokenIn, tokenOut]` if a pool exists.
 *   • Every 2-hop `[tokenIn, X, tokenOut]` where X is any token that
 *     appears in a pool with `tokenIn` *and* a pool with `tokenOut`.
 *
 * Bridges are derived from the registered graph; we never assume a
 * specific intermediate token (XLM, USDC, etc.) is available.
 */
export function generatePaths(
  tokenIn: string,
  tokenOut: string,
  pools: PoolInfo[]
): Path[] {
  if (tokenIn === tokenOut) return [];
  const paths: Path[] = [];

  // Direct
  const direct = findPool(pools, tokenIn, tokenOut);
  if (direct) {
    paths.push({
      hops: [tokenIn, tokenOut],
      pools: [direct.address],
      kind: "direct",
    });
  }

  // 2-hop via any token that shares a pool with tokenIn and another with tokenOut.
  const bridgeCandidates = new Set<string>();
  for (const p of pools) {
    if (p.tokenA === tokenIn) bridgeCandidates.add(p.tokenB);
    else if (p.tokenB === tokenIn) bridgeCandidates.add(p.tokenA);
  }
  for (const bridge of bridgeCandidates) {
    if (bridge === tokenOut) continue;
    const leg1 = findPool(pools, tokenIn, bridge);
    const leg2 = findPool(pools, bridge, tokenOut);
    if (!leg1 || !leg2) continue;
    paths.push({
      hops: [tokenIn, bridge, tokenOut],
      pools: [leg1.address, leg2.address],
      kind: "bridged",
    });
  }

  return paths;
}

// ─── Quoting (injectable for testability) ────────────────────────────────────

export type QuotePathFn = (path: string[], amountIn: bigint) => Promise<bigint | null>;

/**
 * Build a `QuotePathFn` bound to a specific pool graph. Every quote —
 * single-path baseline, split candidate, and price-impact probe —
 * walks exactly these pools, the same set the route-map displays.
 */
export function makeQuotePath(pools: PoolInfo[]): QuotePathFn {
  return async (path, amountIn) => {
    const amounts = await getAmountsOut(path, amountIn, pools);
    if (!amounts) return null;
    return amounts[amounts.length - 1];
  };
}

// ─── Split-search engine ─────────────────────────────────────────────────────

/** Percent increments for the split search. 10% → 11 candidates per pair. */
const SPLIT_STEP_PCT = 10;

/**
 * Given an input amount and a set of paths, find the distribution that
 * maximises total output. Searches:
 *   • 100% through each single path.
 *   • For the top-2 paths by single-route output: every 10% split between them.
 *
 * Expanding to ≥3-way splits is straightforward (nested loops) but in practice
 * two-way splits capture >99% of the gain on AMM curves, and keep the RPC
 * simulation budget predictable.
 */
export async function getOptimalDistribution(
  amountIn: bigint,
  paths: Path[],
  quotePath: QuotePathFn
): Promise<Distribution> {
  if (paths.length === 0) {
    throw new Error("No paths to route through");
  }
  if (amountIn <= 0n) {
    return { legs: [], totalOut: 0n };
  }

  // ── 1. Single-path baselines (parallel) ─────────────────────────────────
  const singleQuotes = await Promise.all(
    paths.map(async (path) => ({
      path,
      out: (await quotePath(path.hops, amountIn)) ?? 0n,
    }))
  );

  // Filter dead routes, sort best-first.
  const live = singleQuotes.filter((q) => q.out > 0n).sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));

  if (live.length === 0) {
    throw new Error("No live liquidity on any path");
  }

  // One path → no split possible.
  if (live.length === 1) {
    return {
      legs: [{ path: live[0].path, percent: 100, amountIn, amountOut: live[0].out }],
      totalOut: live[0].out,
    };
  }

  // ── 2. Two-way split search between the top-2 ───────────────────────────
  const [topA, topB] = live;
  let best: Distribution = {
    legs: [{ path: topA.path, percent: 100, amountIn, amountOut: topA.out }],
    totalOut: topA.out,
  };

  for (let pctA = 100 - SPLIT_STEP_PCT; pctA >= SPLIT_STEP_PCT; pctA -= SPLIT_STEP_PCT) {
    const pctB = 100 - pctA;
    const amtA = (amountIn * BigInt(pctA)) / 100n;
    const amtB = amountIn - amtA;
    if (amtA <= 0n || amtB <= 0n) continue;

    const [outA, outB] = await Promise.all([
      quotePath(topA.path.hops, amtA),
      quotePath(topB.path.hops, amtB),
    ]);
    if (outA === null || outB === null) continue;

    const total = outA + outB;
    if (total > best.totalOut) {
      best = {
        legs: [
          { path: topA.path, percent: pctA, amountIn: amtA, amountOut: outA },
          { path: topB.path, percent: pctB, amountIn: amtB, amountOut: outB },
        ],
        totalOut: total,
      };
    }
  }

  return best;
}

// ─── Top-level aggregation ───────────────────────────────────────────────────

/**
 * End-to-end: generate paths from the supplied pool graph → find optimal
 * distribution → compute savings + impact for UI consumption.
 */
export async function aggregate(args: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  pools: PoolInfo[];
  /** Probe amount used to compute price impact ("infinitesimal" reference). */
  probeAmount?: bigint;
  quotePath?: QuotePathFn;
}): Promise<AggregationResult> {
  const quote = args.quotePath ?? makeQuotePath(args.pools);
  const paths = generatePaths(args.tokenIn, args.tokenOut, args.pools);
  if (paths.length === 0) {
    throw new Error(`No paths from ${args.tokenIn} to ${args.tokenOut}`);
  }

  const distribution = await getOptimalDistribution(args.amountIn, paths, quote);

  // Single-path baseline = best leg at 100% through its path (already computed
  // inside the optimiser, but we extract it cleanly for the savings number).
  const singleQuotes = await Promise.all(
    paths.map(async (p) => ({
      path: p,
      out: (await quote(p.hops, args.amountIn)) ?? 0n,
    }))
  );
  const bestSinglePathOut = singleQuotes.reduce((m, q) => (q.out > m ? q.out : m), 0n);

  const savings =
    distribution.totalOut > bestSinglePathOut
      ? distribution.totalOut - bestSinglePathOut
      : 0n;

  // Price impact via a small probe: infinitesimal-size output × scale factor.
  const probeAmount =
    args.probeAmount ?? (args.amountIn / 1000n > 0n ? args.amountIn / 1000n : 1n);
  const probeQuotes = await Promise.all(
    paths.map(async (p) => (await quote(p.hops, probeAmount)) ?? 0n)
  );
  const bestProbeOut = probeQuotes.reduce<bigint>((m, v) => (v > m ? v : m), 0n);

  let priceImpactPct = 0;
  if (bestProbeOut > 0n && probeAmount > 0n && distribution.totalOut > 0n) {
    // Ideal output if we could execute at the marginal (probe) price.
    const idealOut =
      (bestProbeOut * args.amountIn) / probeAmount; // linear extrapolation
    if (idealOut > distribution.totalOut) {
      const lossStroops = idealOut - distribution.totalOut;
      priceImpactPct = Number((lossStroops * 10_000n) / idealOut) / 100; // 2dp
    }
  }

  return {
    distribution,
    bestSinglePathOut,
    savings,
    isSplit: distribution.legs.length > 1,
    priceImpactPct: Math.max(0, priceImpactPct),
  };
}
