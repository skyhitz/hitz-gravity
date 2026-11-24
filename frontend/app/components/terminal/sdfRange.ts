/**
 * The HITZ Terminal's SDF supply ranges: the tabs, the days each one shows, and whether the viewer's
 * plan cut the history short. The panel fetches the whole history once and filters it here, like the
 * vault liquidity card; what a plan gets is still decided by the server (functions/_lib/terminal/gate.ts).
 *
 * Pure and erasable TypeScript, run in Node by tests/terminal-sdf-range.test.mjs. House style: no em-dashes.
 */

export const SDF_RANGES = [
  { key: "90D", days: 90 },
  { key: "1Y", days: 365 },
  { key: "3Y", days: 1095 },
  { key: "All", days: null },
] as const;
export type SdfRangeKey = (typeof SDF_RANGES)[number]["key"];

/** The first day any daily series can have (gate.ts FIRST_DAY): asking from it asks for all of it. */
export const SDF_ALL_FROM = "2015-01-01";

const DAY_MS = 86_400_000;

/** The first day a range shows: `days` days through the newest one. Null for All. */
export function rangeStart(lastDay: string, days: number | null): string | null {
  if (days === null) return null;
  return new Date(Date.parse(`${lastDay}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** The rows a range shows, from ascending rows of ISO days. */
export function inRange<T extends { day: string }>(rows: readonly T[], days: number | null): T[] {
  const start = rows.length ? rangeStart(rows[rows.length - 1].day, days) : null;
  return start === null ? rows.slice() : rows.filter((r) => r.day >= start);
}

/**
 * Whether the viewer's plan, not the data, cut a range short: the server narrowed the window
 * (`meta.limited`), the answer starts where that window does, and the range asks for earlier days.
 */
export function cutByPlan(rows: readonly { day: string }[], days: number | null, meta: { limited?: string[]; from?: string }): boolean {
  if (!meta.limited?.length || !rows.length) return false;
  if (meta.from !== undefined && rows[0].day > meta.from) return false;
  const start = rangeStart(rows[rows.length - 1].day, days);
  return start === null || rows[0].day > start;
}
