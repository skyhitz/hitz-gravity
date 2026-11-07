// HITZ/USD price model — pure functions shared by the Worker cron
// (_lib/ingest.ts) and the one-time local backfill
// (scripts/backfill-prices.mjs, run with --experimental-strip-types).
// Keep this file dependency-free and limited to erasable TypeScript so
// Node can load it directly.
//
// Model, per hour h:
//   for every registered pool pairing HITZ with a priced quote token,
//     p_i = quoteReserve / hitzReserve × quoteUsd(h)
//     w_i = quoteReserve × quoteUsd(h)          (the pool's USD liquidity)
//   P(h) = Σ w_i·p_i / Σ w_i
// Reserves are the pool's last reserve point at or before the end of the
// hour; quote prices are the hour's volume-weighted average (both
// forward-filled).
// HITZ and every classic-asset SAC use 7 decimals, so raw reserves divide
// directly with no decimal adjustment.
//
// Two kinds of pool feed the model:
//   - Sovereign Vault pools (since 2026-11-04): one per listed asset inside
//     the vault contract, keyed `<vault>:<asset>`. Reserve points come from
//     the vault's own events: `seeded` (starting reserves), `hop` (reserves
//     after each trade) and `deposit` (added to the previous point).
//   - AMM pools keyed by their own address, with reserves from their
//     `update_reserves` events: the Aquarius HITZ/XLM and HITZ/USDC pools
//     until they were removed from the registry on 2026-11-03. Their rows
//     stay in D1, inactive, and carry the price history before the vault.

export const HOUR = 3600;

export type QuoteKind = "usd" | "native" | "classic" | "unpriced";

export interface PoolMeta {
  /** The pool's key: an AMM's own address, or `<vault>:<asset>` (see `vaultPoolKey`). */
  address: string;
  /** Position of HITZ in the pool's `get_tokens()` (0 or 1); 0 for vault pools. */
  hitzIndex: number;
  quoteKind: QuoteKind;
  /** Key into the quote price series (e.g. "XLM", "AQUA:G…"); null for usd/unpriced. */
  quoteId: string | null;
  /** e.g. "HITZ/XLM". */
  label: string;
}

export interface ReservePoint {
  pool: string;
  /** Unix seconds. */
  ts: number;
  /** Sortable event id — orders points that share a timestamp. */
  eventId: string;
  hitz: bigint;
  quote: bigint;
}

export interface HourPoint {
  hour: number;
  price: number;
  /** Pool address → share of the blend (0..1). */
  weights: Record<string, number>;
  /** USD value of the quote side across priced pools (TVL is twice this). */
  quoteSideUsd: number;
}

export interface PriceSnapshot {
  asOf: string;
  pools: { address: string; pair: string; quote: QuoteKind; weight: number }[];
  /** [hour (unix seconds), HITZ price in USD]. */
  points: [number, number][];
}

export function hourOf(tsSeconds: number): number {
  return Math.floor(tsSeconds / HOUR) * HOUR;
}

/** The key of the vault's pool for `asset`. */
export function vaultPoolKey(vault: string, asset: string): string {
  return `${vault}:${asset}`;
}

/** The contract holding a pool: the vault for vault pools, else the pool itself. */
export function poolContract(key: string): string {
  return key.split(":")[0];
}

export function isVaultPool(key: string): boolean {
  return key.includes(":");
}

/**
 * The fee a trade between two consecutive reserve states left in the pool,
 * in the token it was withheld from. The vault withholds its fee from the
 * hop's output, so the output fell short of the constant-product output
 * for the input that came in: fee = y0·a/(x0 + a) − out. Zero for anything
 * that isn't a swap (both reserves moving the same way is a deposit).
 */
export function impliedFee(
  prev: { hitz: bigint; quote: bigint },
  next: { hitz: bigint; quote: bigint }
): { hitz: bigint; quote: bigint } {
  const dH = next.hitz - prev.hitz;
  const dQ = next.quote - prev.quote;
  if (dQ > 0n && dH < 0n) {
    const gross = (prev.hitz * dQ) / (prev.quote + dQ);
    const fee = gross + dH; // gross − out, out = −dH
    return { hitz: fee > 0n ? fee : 0n, quote: 0n };
  }
  if (dH > 0n && dQ < 0n) {
    const gross = (prev.quote * dH) / (prev.hitz + dH);
    const fee = gross + dQ;
    return { hitz: 0n, quote: fee > 0n ? fee : 0n };
  }
  return { hitz: 0n, quote: 0n };
}

/**
 * Sovereign Vault hop fee: 1% × e^(100·D), capped at 10%. A trade that
 * moves one pool's price by 2% against calm references leaves D = ln 1.02,
 * so the vault's ±2% depth is priced at that fee, not the 1% floor.
 */
export function vaultFee(dislocation: number): number {
  return Math.min(0.1, 0.01 * Math.exp(100 * Math.abs(dislocation)));
}

/**
 * Normalize a Soroban event id to the zero-padded `TOID-index` form Soroban
 * RPC uses (`0268528403388227584-0000000008`), so ids from Stellar Expert
 * (`267511711614545921-0003`) sort correctly as strings.
 */
export function canonicalEventId(id: string): string {
  const [toid, index = "0"] = id.split("-");
  return `${BigInt(toid).toString().padStart(19, "0")}-${BigInt(index).toString().padStart(10, "0")}`;
}

/**
 * Decode an Aqua `update_reserves` event body: ScVal::Vec(Some([U128, U128])).
 * XDR layout (big-endian): tag 16 (vec) · present 1 · len 2 · then twice
 * { tag 10 (u128) · hi u64 · lo u64 } — 52 bytes. Hand-decoded so the cron
 * doesn't spend its CPU budget on the full XDR machinery. Returns the two
 * reserves in `get_tokens()` order, or null for any other shape.
 */
export function decodeReservesBody(bodyXdrBase64: string): [bigint, bigint] | null {
  let bytes: Uint8Array;
  try {
    const bin = atob(bodyXdrBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length !== 52) return null;
  const view = new DataView(bytes.buffer);
  if (view.getUint32(0) !== 16 || view.getUint32(4) !== 1 || view.getUint32(8) !== 2) return null;
  const u128 = (offset: number): bigint | null => {
    if (view.getUint32(offset) !== 10) return null;
    return (view.getBigUint64(offset + 4) << 64n) | view.getBigUint64(offset + 12);
  };
  const a = u128(12);
  const b = u128(32);
  return a === null || b === null ? null : [a, b];
}

/**
 * Classify a pool's quote token from its SAC `name()`: `native` is XLM,
 * `USDC:<Circle issuer>` is USD, any other `CODE:ISSUER` is a classic asset
 * we can price against USDC on the Stellar DEX. Anything else is a pure
 * Soroban token with no USD market we can read, so it's left unpriced.
 */
export function classifyQuoteName(
  name: string,
  usdcIssuer: string
): { kind: QuoteKind; quoteId: string | null; symbol: string } {
  if (name === "native") return { kind: "native", quoteId: "XLM", symbol: "XLM" };
  const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  if (!m) return { kind: "unpriced", quoteId: null, symbol: name };
  const [, code, issuer] = m;
  if (code === "USDC" && issuer === usdcIssuer) return { kind: "usd", quoteId: null, symbol: "USDC" };
  return { kind: "classic", quoteId: `${code}:${issuer}`, symbol: code };
}

/** Map `get_tokens()`-ordered reserves to (hitz, quote). */
export function orientReserves(pair: [bigint, bigint], hitzIndex: number): { hitz: bigint; quote: bigint } {
  return hitzIndex === 0 ? { hitz: pair[0], quote: pair[1] } : { hitz: pair[1], quote: pair[0] };
}

/**
 * Hourly blended prices for every hour in [fromHour, toHour].
 *
 * `seedReserves` / `seedQuotes` carry each pool's reserves and each quote's
 * price from *before* `fromHour`, so forward-fill is correct at the window
 * start; `reserves` / `quotes` hold everything from `fromHour` on. Hours
 * where no pool has both reserves and a quote price produce no point.
 */
export function computeHours(args: {
  pools: PoolMeta[];
  fromHour: number;
  toHour: number;
  reserves: ReservePoint[];
  seedReserves: Map<string, { hitz: bigint; quote: bigint }>;
  quotes: Map<string, [number, number][]>;
  seedQuotes: Map<string, number>;
}): HourPoint[] {
  const priced = args.pools.filter((p) => p.quoteKind !== "unpriced");
  const reserves = [...args.reserves].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
  );
  const quotes = new Map<string, [number, number][]>();
  for (const [id, series] of args.quotes) quotes.set(id, [...series].sort((a, b) => a[0] - b[0]));

  const state = new Map(args.seedReserves);
  const quoteState = new Map(args.seedQuotes);
  const quoteCursor = new Map<string, number>();
  let r = 0;
  const out: HourPoint[] = [];

  for (let h = args.fromHour; h <= args.toHour; h += HOUR) {
    const end = h + HOUR;
    while (r < reserves.length && reserves[r].ts < end) {
      const p = reserves[r++];
      state.set(p.pool, { hitz: p.hitz, quote: p.quote });
    }
    for (const [id, series] of quotes) {
      let i = quoteCursor.get(id) ?? 0;
      while (i < series.length && series[i][0] <= h) quoteState.set(id, series[i++][1]);
      quoteCursor.set(id, i);
    }

    let num = 0;
    let den = 0;
    const raw: Record<string, number> = {};
    for (const pool of priced) {
      const res = state.get(pool.address);
      if (!res || res.hitz <= 0n || res.quote <= 0n) continue;
      const usd = pool.quoteKind === "usd" ? 1 : quoteState.get(pool.quoteId ?? "");
      if (!usd) continue;
      const quoteAmount = Number(res.quote) / 1e7;
      const price = (quoteAmount / (Number(res.hitz) / 1e7)) * usd;
      const weight = quoteAmount * usd;
      num += price * weight;
      den += weight;
      raw[pool.address] = weight;
    }
    if (den <= 0) continue;
    const weights: Record<string, number> = {};
    for (const [addr, w] of Object.entries(raw)) weights[addr] = Number((w / den).toFixed(4));
    out.push({ hour: h, price: num / den, weights, quoteSideUsd: den });
  }
  return out;
}

/** Six significant digits keeps the payload small with no visible loss. */
function round(price: number): number {
  return Number(price.toPrecision(6));
}

/**
 * Merge recomputed hours into the served snapshot: every existing point at
 * or after the first recomputed hour is replaced.
 */
export function mergeSnapshot(
  prev: PriceSnapshot | null,
  updated: HourPoint[],
  pools: PoolMeta[],
  asOf: string
): PriceSnapshot {
  const from = updated.length ? updated[0].hour : Infinity;
  const kept = (prev?.points ?? []).filter(([h]) => h < from);
  const points: [number, number][] = [...kept, ...updated.map((p): [number, number] => [p.hour, round(p.price)])];
  const latest = updated.at(-1)?.weights;
  const prevWeights = new Map((prev?.pools ?? []).map((p) => [p.address, p.weight]));
  return {
    asOf,
    pools: pools.map((p) => ({
      address: p.address,
      pair: p.label,
      quote: p.quoteKind,
      weight: latest ? latest[p.address] ?? 0 : prevWeights.get(p.address) ?? 0,
    })),
    points,
  };
}

// ─── Liquidity ───────────────────────────────────────────────────────────────
//
// Everything below is derived from the same reserve history as the price:
// each `update_reserves` point is either a swap (the two reserves move in
// opposite directions) or a liquidity add/remove (both move the same way).
// Only swaps count as volume, so re-seeds and LP deposits never inflate it.

export interface PoolLiquidity {
  /** The pool's key (see PoolMeta.address). */
  address: string;
  /** The contract to link to: the vault, or the AMM pool itself. */
  contract: string;
  venue: "vault" | "amm";
  pair: string;
  quote: QuoteKind;
  /** HITZ reserve (whole tokens). */
  hitz: number;
  /** Quote reserve (whole units of the quote token). */
  quoteReserve: number;
  /** USD per quote unit at snapshot time. */
  quoteUsd: number;
  /** Both sides in USD (twice the quote side for a balanced constant-product pool). */
  tvlUsd: number;
  priceUsd: number;
  /** Share of total TVL (0..1). */
  share: number;
  /**
   * Swap fee in basis points: for a vault pool, what a very small hop pays
   * right now (`pools()`, 100 = the 1% floor); for an AMM, its fixed fee.
   */
  feeBps: number | null;
  /** Vault pools: the pool's dislocation now, in percent (log terms). */
  dislocationPct: number | null;
  /** USD a buyer must spend to move this pool's price up 2% (fee-inclusive). */
  depthUp2Usd: number;
  /** USD value of HITZ a seller can sell before price drops 2% (fee-inclusive). */
  depthDown2Usd: number;
}

export interface VolumeWindow {
  usd: number;
  trades: number;
  feesUsd: number;
}

export interface LiquiditySnapshot {
  asOf: string;
  pools: PoolLiquidity[];
  totals: {
    tvlUsd: number;
    hitzInPools: number;
    /**
     * (max − min) / mean of per-pool HITZ prices in USD. For the vault this
     * is how far its exchange rate between two assets sits from the market.
     */
    spreadPct: number;
    depthUp2Usd: number;
    depthDown2Usd: number;
  };
  volume: { h24: VolumeWindow; d7: VolumeWindow; d30: VolumeWindow };
  /** [hour (unix seconds), TVL in USD], hourly over the window. */
  history: [number, number][];
}

/** Quote USD price in effect at `ts` (latest hourly value at or before its hour). */
function quoteUsdAt(series: [number, number][], seed: number | undefined, ts: number): number | undefined {
  const h = hourOf(ts);
  let lo = 0;
  let hi = series.length - 1;
  let found: number | undefined = seed;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= h) {
      found = series[mid][1];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function emptyWindow(): VolumeWindow {
  return { usd: 0, trades: 0, feesUsd: 0 };
}

/**
 * Liquidity snapshot for the window [fromHour, now]: current per-pool depth,
 * swap volume and fees for 24h / 7d / 30d, ±2% depth, cross-pool spread and
 * an hourly TVL series. Same inputs as `computeHours`, plus each pool's fee.
 */
export function summarizeLiquidity(args: {
  pools: PoolMeta[];
  fromHour: number;
  nowTs: number;
  reserves: ReservePoint[];
  seedReserves: Map<string, { hitz: bigint; quote: bigint }>;
  quotes: Map<string, [number, number][]>;
  seedQuotes: Map<string, number>;
  /** Current fee per pool, basis points. */
  feeBps: Map<string, number>;
  /** Vault pools' current dislocation, as a fraction (0.01 = 1%). */
  dislocation?: Map<string, number>;
  asOf: string;
}): LiquiditySnapshot {
  const priced = args.pools.filter((p) => p.quoteKind !== "unpriced");
  const pricedSet = new Set(priced.map((p) => p.address));
  const byAddress = new Map(priced.map((p) => [p.address, p]));
  const reserves = args.reserves
    .filter((r) => pricedSet.has(r.pool))
    .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  const quotes = new Map<string, [number, number][]>();
  for (const [id, series] of args.quotes) quotes.set(id, [...series].sort((a, b) => a[0] - b[0]));
  const usdAt = (pool: PoolMeta, ts: number): number | undefined =>
    pool.quoteKind === "usd"
      ? 1
      : quoteUsdAt(quotes.get(pool.quoteId ?? "") ?? [], args.seedQuotes.get(pool.quoteId ?? ""), ts);

  // Volume: classify every reserve change against the pool's previous state.
  const volume = { h24: emptyWindow(), d7: emptyWindow(), d30: emptyWindow() };
  const windows: [VolumeWindow, number][] = [
    [volume.h24, args.nowTs - 86_400],
    [volume.d7, args.nowTs - 7 * 86_400],
    [volume.d30, args.nowTs - 30 * 86_400],
  ];
  const state = new Map(args.seedReserves);
  for (const r of reserves) {
    const prev = state.get(r.pool);
    state.set(r.pool, { hitz: r.hitz, quote: r.quote });
    if (!prev) continue;
    const dH = r.hitz - prev.hitz;
    const dQ = r.quote - prev.quote;
    const isSwap = (dH > 0n && dQ < 0n) || (dH < 0n && dQ > 0n);
    if (!isSwap) continue;
    const pool = byAddress.get(r.pool)!;
    const usd = usdAt(pool, r.ts);
    if (!usd) continue;
    const tradeUsd = (Number(dQ < 0n ? -dQ : dQ) / 1e7) * usd;
    // Vault pools: the fee each hop actually left in the pool, read off the
    // reserves (it moves with the dislocation). AMMs: their fixed rate.
    let fee: number;
    if (isVaultPool(r.pool)) {
      const f = impliedFee(prev, r);
      const priceUsd = (Number(r.quote) / Number(r.hitz)) * usd;
      fee = (Number(f.quote) / 1e7) * usd + (Number(f.hitz) / 1e7) * priceUsd;
    } else {
      fee = tradeUsd * ((args.feeBps.get(r.pool) ?? 0) / 10_000);
    }
    for (const [w, since] of windows) {
      if (r.ts < since) continue;
      w.usd += tradeUsd;
      w.trades += 1;
      w.feesUsd += fee;
    }
  }

  // Current state per pool (the loop above left `state` at the latest reserves).
  const up = Math.sqrt(1.02) - 1;
  const down = 1 / Math.sqrt(0.98) - 1;
  const pools: PoolLiquidity[] = [];
  for (const pool of priced) {
    const res = state.get(pool.address);
    const usd = usdAt(pool, args.nowTs);
    if (!res || !usd || res.hitz <= 0n || res.quote <= 0n) continue;
    const hitz = Number(res.hitz) / 1e7;
    const quoteReserve = Number(res.quote) / 1e7;
    const priceUsd = (quoteReserve / hitz) * usd;
    const feeBps = args.feeBps.get(pool.address) ?? null;
    const vault = isVaultPool(pool.address);
    const disl = args.dislocation?.get(pool.address) ?? null;
    // A 2% move in a vault pool pays the fee for the dislocation it leaves.
    const depthFee = vault ? vaultFee(Math.log(1.02) + Math.abs(disl ?? 0)) : (feeBps ?? 0) / 10_000;
    const gross = 1 / (1 - depthFee);
    pools.push({
      address: pool.address,
      contract: poolContract(pool.address),
      venue: vault ? "vault" : "amm",
      pair: pool.label,
      quote: pool.quoteKind,
      hitz,
      quoteReserve,
      quoteUsd: usd,
      tvlUsd: 2 * quoteReserve * usd,
      priceUsd,
      share: 0,
      feeBps,
      dislocationPct: disl === null ? null : Number((disl * 100).toFixed(4)),
      depthUp2Usd: quoteReserve * up * gross * usd,
      depthDown2Usd: hitz * down * gross * priceUsd,
    });
  }
  const tvlUsd = pools.reduce((s, p) => s + p.tvlUsd, 0);
  for (const p of pools) p.share = tvlUsd > 0 ? p.tvlUsd / tvlUsd : 0;
  const prices = pools.map((p) => p.priceUsd);
  const mean = prices.reduce((s, v) => s + v, 0) / (prices.length || 1);
  const spreadPct = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / mean) * 100 : 0;

  const hours = computeHours({
    pools: priced,
    fromHour: args.fromHour,
    toHour: hourOf(args.nowTs),
    reserves,
    seedReserves: args.seedReserves,
    quotes,
    seedQuotes: args.seedQuotes,
  });

  const money = (v: number) => Number(v.toFixed(2));
  const win = (w: VolumeWindow): VolumeWindow => ({ usd: money(w.usd), trades: w.trades, feesUsd: Number(w.feesUsd.toFixed(4)) });
  return {
    asOf: args.asOf,
    pools: pools
      .map((p) => ({
        ...p,
        tvlUsd: money(p.tvlUsd),
        priceUsd: round(p.priceUsd),
        share: Number(p.share.toFixed(4)),
        depthUp2Usd: money(p.depthUp2Usd),
        depthDown2Usd: money(p.depthDown2Usd),
      }))
      .sort((a, b) => b.tvlUsd - a.tvlUsd),
    totals: {
      tvlUsd: money(tvlUsd),
      hitzInPools: Math.round(pools.reduce((s, p) => s + p.hitz, 0)),
      spreadPct: Number(spreadPct.toFixed(3)),
      depthUp2Usd: money(pools.reduce((s, p) => s + p.depthUp2Usd, 0)),
      depthDown2Usd: money(pools.reduce((s, p) => s + p.depthDown2Usd, 0)),
    },
    volume: { h24: win(volume.h24), d7: win(volume.d7), d30: win(volume.d30) },
    history: hours.map((h): [number, number] => [h.hour, money(2 * h.quoteSideUsd)]),
  };
}
