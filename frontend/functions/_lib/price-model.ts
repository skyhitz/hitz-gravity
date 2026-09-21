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
// Reserves are the pool's last `update_reserves` at or before the end of
// the hour; quote prices are the hour's volume-weighted average (both
// forward-filled).
// HITZ and every classic-asset SAC use 7 decimals, so raw reserves divide
// directly with no decimal adjustment.

export const HOUR = 3600;

export type QuoteKind = "usd" | "native" | "classic" | "unpriced";

export interface PoolMeta {
  address: string;
  /** Position of HITZ in the pool's `get_tokens()` (0 or 1). */
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
    out.push({ hour: h, price: num / den, weights });
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
