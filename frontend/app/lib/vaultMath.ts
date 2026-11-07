// Exact integer port of the Sovereign Vault's swap math
// (contracts/sovereign-vault/src/lib.rs), for quoting in the browser.
//
// Mirrors research/vault-backtest/vaultmath.py operation by operation:
// BigInt division truncates toward zero like Rust's i128 division, ceilings
// round up where the contract does, pow_sat saturates the same way, and ln
// and exp use the same series. scripts/check-vault-math.mjs replays the
// contract's golden vectors against this file and must match exactly.
//
// Kept dependency-free and limited to erasable TypeScript so Node can load
// it directly (node --experimental-strip-types).

export const ONE = 1_000_000_000n; // 1.0 for fee rates and exchange rates
export const WAD = 1_000_000_000_000_000_000n; // 1.0 for natural logs
export const FEE_FLOOR = 10_000_000n; // 1%
export const FEE_CAP = 100_000_000n; // 10%
export const STEEPNESS = 100n;
export const DECAY_PER_SEC = 999_861_121n; // e^(-1/7200): a 2-hour average
export const REFERENCE_DEPTH_RATIO = 8n;
export const MAX_ASSETS = 16;
export const UPGRADE_DELAY_SECS = 7n * 24n * 60n * 60n;

const LN2_WAD = 693_147_180_559_945_309n;
const LN_CAP_OVER_FLOOR_WAD = 2_302_585_092_994_045_684n; // ln 10
const HITZ = "HITZ";

export class VaultMathError extends Error {}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

// ── Fixed-point math ─────────────────────────────────────────────────────────

export function powSat(base: bigint, exp: bigint, cap: bigint): bigint {
  let b = base > cap ? cap : base;
  let e = exp;
  let acc = ONE;
  for (;;) {
    if (e & 1n) {
      acc = (acc * b) / ONE;
      if (acc >= cap) return cap;
    }
    e >>= 1n;
    if (e === 0n || acc === 0n) return acc;
    b = (b * b) / ONE;
    if (b > cap) b = cap;
  }
}

function bitLength(x: bigint): number {
  return x.toString(2).length;
}

function log2Parts(x: bigint): [bigint, bigint] {
  const n = bitLength(x) - 1;
  const top = n >= 60 ? x >> BigInt(n - 60) : x << BigInt(60 - n);
  return [BigInt(n), (top * WAD) >> 60n];
}

function lnNearOne(r: bigint): bigint {
  const z = ((r - WAD) * WAD) / (r + WAD);
  const z2 = (z * z) / WAD;
  let term = z;
  let total = 0n;
  let k = 1n;
  while (term !== 0n) {
    total += term / k;
    term = (term * z2) / WAD;
    k += 2n;
  }
  return 2n * total;
}

/** ln(a / b) in 18 decimals, for a, b > 0. */
export function lnRatio(a: bigint, b: bigint): bigint {
  const [na, ma] = log2Parts(a);
  const [nb, mb] = log2Parts(b);
  return (na - nb) * LN2_WAD + lnNearOne((ma * WAD) / mb);
}

/** e^x in 18 decimals for x >= 0, rounded up. */
export function expWad(x: bigint): bigint {
  if (x === 0n) return WAD;
  const n = x / LN2_WAD;
  const r = x - n * LN2_WAD;
  let term = WAD;
  let total = WAD;
  let k = 1n;
  while (term > 0n) {
    term = (term * r) / (k * WAD);
    total += term;
    k += 1n;
  }
  return (total + k) << n;
}

export function decayed(deviation: bigint, elapsed: bigint): bigint {
  if (elapsed === 0n || deviation === 0n) return deviation;
  return (deviation * powSat(DECAY_PER_SEC, elapsed, ONE)) / ONE;
}

/** The fee a hop pays for dislocation D (9 decimals: 10_000_000 = 1%). */
export function feeForDislocation(dislocation: bigint): bigint {
  const x = abs(dislocation) * STEEPNESS;
  if (x >= LN_CAP_OVER_FLOOR_WAD) return FEE_CAP;
  const fee = (FEE_FLOOR * expWad(x) + WAD - 1n) / WAD;
  return fee > FEE_CAP ? FEE_CAP : fee;
}

function lnPriceChange(hitz0: bigint, reserve0: bigint, hitz1: bigint, reserve1: bigint): bigint {
  return lnRatio(reserve1, reserve0) + lnRatio(hitz0, hitz1);
}

// ── Pools ────────────────────────────────────────────────────────────────────

/** A pool as the contract stores it. `asset` is a contract address (or a test name). */
export interface Pool {
  asset: string;
  hitz: bigint;
  reserve: bigint;
  /** ln(reserve / hitz) minus its average, 18 decimals, as of `updated`. */
  deviation: bigint;
  /** Ledger time `deviation` refers to (seconds). */
  updated: bigint;
}

/** A pool as the views report it: brought up to the current ledger time. */
export interface PoolState {
  asset: string;
  hitz: bigint;
  reserve: bigint;
  deviation: bigint;
  /** Largest |dislocation| against its references now (18 decimals). */
  dislocation: bigint;
  /** Fee a very small hop pays now (9 decimals). */
  fee: bigint;
}

export interface Hop {
  pool: number;
  asset: string;
  hitzIn: boolean;
  amountIn: bigint;
  amountOut: bigint;
  /** The D the fee was priced at (18 decimals). */
  dislocation: bigint;
  /** 9 decimals. */
  feeRate: bigint;
  /** In the hop's output token; stays in the pool. */
  feeAmount: bigint;
}

const seeded = (p: Pool): boolean => p.hitz > 0n && p.reserve > 0n;

export function indexOf(pools: readonly Pool[], asset: string): number {
  const i = pools.findIndex((p) => p.asset === asset);
  if (i < 0) throw new VaultMathError("InvalidPool");
  return i;
}

function replaceAt(pools: readonly Pool[], i: number, p: Pool): Pool[] {
  const next = pools.slice();
  next[i] = p;
  return next;
}

/**
 * Pools as the `pools()` view returned them, ready to quote at the same
 * ledger time: each view deviation is already decayed to "now", so `updated`
 * is set to `now` and every elapsed time below is zero.
 */
export function poolsFromStates(states: readonly PoolState[], now = 0n): Pool[] {
  return states.map((s) => ({ asset: s.asset, hitz: s.hitz, reserve: s.reserve, deviation: s.deviation, updated: now }));
}

export function newVault(assets: readonly string[], now: bigint): Pool[] {
  if (!assets.length || assets.length > MAX_ASSETS || assets.includes(HITZ) || new Set(assets).size !== assets.length) {
    throw new VaultMathError("bad asset list");
  }
  return assets.map((asset) => ({ asset, hitz: 0n, reserve: 0n, deviation: 0n, updated: now }));
}

export function listAsset(pools: readonly Pool[], asset: string, now: bigint): Pool[] {
  if (asset === HITZ || pools.some((p) => p.asset === asset)) throw new VaultMathError("DuplicateToken");
  if (pools.length >= MAX_ASSETS) throw new VaultMathError("TooManyAssets");
  return [...pools, { asset, hitz: 0n, reserve: 0n, deviation: 0n, updated: now }];
}

function averageDeviation(pools: readonly Pool[], now: bigint): bigint {
  let weighted = 0n;
  let weight = 0n;
  for (const p of pools) {
    if (!seeded(p)) continue;
    weighted += decayed(p.deviation, now - p.updated) * p.hitz;
    weight += p.hitz;
  }
  return weight ? weighted / weight : 0n;
}

export function seed(pools: readonly Pool[], asset: string, hitz: bigint, amount: bigint, now: bigint): Pool[] {
  if (hitz <= 0n || amount <= 0n) throw new VaultMathError("InvalidAmount");
  const i = indexOf(pools, asset);
  if (pools[i].hitz || pools[i].reserve) throw new VaultMathError("AlreadySeeded");
  return replaceAt(pools, i, { asset, hitz, reserve: amount, deviation: averageDeviation(pools, now), updated: now });
}

/** D for pool i: its largest |dislocation| against a reference pool. */
function worstDislocation(pools: readonly Pool[], i: number, hitz: bigint, deviation: bigint, now: bigint): bigint {
  let worst = 0n;
  pools.forEach((p, j) => {
    if (j === i || !seeded(p)) return;
    if (p.hitz * REFERENCE_DEPTH_RATIO < hitz) return;
    const gap = abs(deviation - decayed(p.deviation, now - p.updated));
    if (gap > worst) worst = gap;
  });
  return worst;
}

function sides(hitzIn: boolean, newIn: bigint, newOut: bigint): [bigint, bigint] {
  return hitzIn ? [newIn, newOut] : [newOut, newIn];
}

/** One constant-product leg through pool i. */
export function hop(
  pools: readonly Pool[],
  i: number,
  hitzIn: boolean,
  amountIn: bigint,
  now: bigint
): { pools: Pool[]; hop: Hop } {
  const p = pools[i];
  const [rIn, rOut] = hitzIn ? [p.hitz, p.reserve] : [p.reserve, p.hitz];
  const newIn = rIn + amountIn;
  const gross = (rOut * amountIn) / newIn;
  const deviationNow = decayed(p.deviation, now - p.updated);
  const [hEnd, qEnd] = sides(hitzIn, newIn, rOut - gross);
  const deviationEnd = deviationNow + lnPriceChange(p.hitz, p.reserve, hEnd, qEnd);
  const dislocation = worstDislocation(pools, i, hEnd, deviationEnd, now);
  const feeRate = feeForDislocation(dislocation);
  const feeAmount = (gross * feeRate + ONE - 1n) / ONE;
  const out = gross - feeAmount;
  if (out <= 0n) throw new VaultMathError("TradeTooSmall");
  const [h, q] = sides(hitzIn, newIn, rOut - out);
  const next: Pool = { asset: p.asset, hitz: h, reserve: q, deviation: deviationNow + lnPriceChange(p.hitz, p.reserve, h, q), updated: now };
  return {
    pools: replaceAt(pools, i, next),
    hop: { pool: i, asset: p.asset, hitzIn, amountIn, amountOut: out, dislocation, feeRate, feeAmount },
  };
}

/** The legs of a swap: (pool index, HITZ is the input). */
export function route(pools: readonly Pool[], tokenIn: string, tokenOut: string, hitz = HITZ): [number, boolean][] {
  const find = (t: string): number => {
    const i = pools.findIndex((p) => p.asset === t);
    if (i < 0) throw new VaultMathError("UnsupportedPair");
    return i;
  };
  let legs: [number, boolean][];
  if (tokenIn === hitz && tokenOut !== hitz) legs = [[find(tokenOut), true]];
  else if (tokenOut === hitz && tokenIn !== hitz) legs = [[find(tokenIn), false]];
  else if (tokenIn !== tokenOut && tokenIn !== hitz) legs = [[find(tokenIn), false], [find(tokenOut), true]];
  else throw new VaultMathError("UnsupportedPair");
  for (const [i] of legs) if (!seeded(pools[i])) throw new VaultMathError("NotSeeded");
  return legs;
}

export interface SwapResult {
  pools: Pool[];
  amountOut: bigint;
  hops: Hop[];
}

/** `swap` (keeping the new pools) and `quote` (ignoring them). `hitz` names the HITZ token. */
export function swap(
  pools: readonly Pool[],
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  now: bigint,
  hitz = HITZ
): SwapResult {
  if (amountIn <= 0n) throw new VaultMathError("InvalidAmount");
  const hops: Hop[] = [];
  let state: Pool[] = pools.slice();
  let amount = amountIn;
  for (const [i, hitzIn] of route(pools, tokenIn, tokenOut, hitz)) {
    const r = hop(state, i, hitzIn, amount, now);
    state = r.pools;
    hops.push(r.hop);
    amount = r.hop.amountOut;
  }
  return { pools: state, amountOut: amount, hops };
}

// ── Views ────────────────────────────────────────────────────────────────────

export function poolState(pools: readonly Pool[], i: number, now: bigint): PoolState {
  const p = pools[i];
  const deviation = decayed(p.deviation, now - p.updated);
  const dislocation = seeded(p) ? worstDislocation(pools, i, p.hitz, deviation, now) : 0n;
  return { asset: p.asset, hitz: p.hitz, reserve: p.reserve, deviation, dislocation, fee: feeForDislocation(dislocation) };
}

/** How much `quote` one `base` is worth in the vault (9 decimals, raw units). */
export function rate(pools: readonly Pool[], base: string, quote: string): bigint {
  const b = pools[indexOf(pools, base)];
  const q = pools[indexOf(pools, quote)];
  return (q.reserve * b.hitz * ONE) / (q.hitz * b.reserve);
}

/** ln(rate(base, quote) ÷ its average), 18 decimals. */
export function dislocation(pools: readonly Pool[], base: string, quote: string, now: bigint): bigint {
  const b = pools[indexOf(pools, base)];
  const q = pools[indexOf(pools, quote)];
  return decayed(q.deviation, now - q.updated) - decayed(b.deviation, now - b.updated);
}

// ── Sizing ───────────────────────────────────────────────────────────────────

/**
 * The smallest exact input that pays out at least `amountOut`, by bisection
 * on the exact quote (outputs grow with the input). Null when the pools
 * can't pay that much.
 */
export function inputForOutput(
  pools: readonly Pool[],
  tokenIn: string,
  tokenOut: string,
  amountOut: bigint,
  now: bigint,
  hitz = HITZ
): bigint | null {
  if (amountOut <= 0n) return null;
  const legs = route(pools, tokenIn, tokenOut, hitz);
  const [lastPool, lastHitzIn] = legs[legs.length - 1];
  const reserveOut = lastHitzIn ? pools[lastPool].reserve : pools[lastPool].hitz;
  // A constant-product pool never pays out its whole reserve.
  if (amountOut >= reserveOut) return null;
  const out = (a: bigint): bigint => {
    try {
      return swap(pools, tokenIn, tokenOut, a, now, hitz).amountOut;
    } catch (err) {
      if (err instanceof VaultMathError && err.message === "TradeTooSmall") return 0n;
      throw err;
    }
  };
  let lo = 0n;
  let hi = 1n;
  // Grow until the output covers the target; past 2^127 the contract's i128 overflows.
  for (let i = 0; out(hi) < amountOut; i++) {
    if (i >= 127) return null;
    lo = hi;
    hi *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (out(mid) >= amountOut) hi = mid;
    else lo = mid;
  }
  return hi;
}
