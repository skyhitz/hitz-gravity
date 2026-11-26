/**
 * The HITZ Terminal's CEX vs DEX ranges: the tabs, the window and bins each one asks the server for, how
 * often it refreshes, and whether the viewer's plan cut a window short. Unlike SDF, the history can't
 * come in one answer (a row a minute per venue since Jun 2026), so each tab asks for its own window, in
 * daily bins past 30 days; the long tabs refresh every 15 minutes, since one refresh of All reads about
 * 1.3M rows. What a plan gets is still decided by the server (functions/_lib/terminal/gate.ts).
 *
 * Pure and erasable TypeScript, run in Node by tests/terminal-spread-range.test.mjs. House style: no em-dashes.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BIN_MS = { "5m": 5 * MIN, "1h": HOUR, "1d": DAY } as const;

export const SPREAD_RANGES = [
  { key: "1D", days: 1 },
  { key: "7D", days: 7 },
  { key: "30D", days: 30 },
  { key: "90D", days: 90 },
  { key: "All", days: null },
] as const;
export type SpreadRangeKey = (typeof SPREAD_RANGES)[number]["key"];

/** The first day any series can have (gate.ts FIRST_DAY): asking from it asks for all of it. */
export const SPREAD_ALL_FROM = "2015-01-01";

/** The tab a viewer starts on, today's view: a paid plan's day in 5-minute bins, Free's hourly week. */
export const spreadDefault = (fine: boolean): SpreadRangeKey => (fine ? "1D" : "7D");

export interface SpreadQuery {
  params: { resolution: "5m" | "1h" | "1d"; from?: string };
  /** The window back from now; none for All, which asks from SPREAD_ALL_FROM. */
  spanMs?: number;
  everyMs: number;
  binMs: number;
}

/** What a tab asks for: 5-minute bins on a paid 1D (hourly on Free), hourly to 30D, daily beyond. */
export function spreadQuery(key: SpreadRangeKey, fine: boolean): SpreadQuery {
  const days = SPREAD_RANGES.find((r) => r.key === key)!.days;
  const resolution = days === null || days > 30 ? "1d" : days === 1 && fine ? "5m" : "1h";
  const everyMs = days !== null && days <= 7 ? MIN : 15 * MIN;
  const binMs = BIN_MS[resolution];
  if (days === null) return { params: { resolution, from: SPREAD_ALL_FROM }, everyMs, binMs };
  return { params: { resolution }, spanMs: days * DAY, everyMs, binMs };
}

/**
 * Whether the viewer's plan cut a tab's window short: the server narrowed it (`meta.limited`), the data
 * reaches back to where the narrowed window starts (the plan, not the data, set the start), and that
 * start is more than an hour after what the tab asked for (`as_of` minus its span), so a browser clock
 * a few seconds off the server's is no cut. Anything unreadable is no cut.
 */
export function spreadCut(rows: readonly { t: number }[], q: { spanMs?: number; binMs: number }, meta: { limited?: string[]; from?: string; as_of?: string }): boolean {
  if (!meta.limited?.length || !rows.length || meta.from === undefined) return false;
  const from = Date.parse(meta.from);
  if (!Number.isFinite(from) || rows[0].t > from + q.binMs) return false;
  const asked = q.spanMs === undefined ? -Infinity : Date.parse(meta.as_of ?? "") - q.spanMs;
  return from - asked > HOUR;
}
