/**
 * Time labels for the shared chart (TimeSeriesChart.tsx): the Monitor cards and the HITZ Terminal's
 * panels. Times are Unix seconds, shown in UTC.
 *
 * Pure and erasable TypeScript, run in Node by tests/chart-time.test.mjs.
 */

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** `Sep 21` (UTC). */
export const fmtDate = (unixSeconds: number) => dateFmt.format(unixSeconds * 1000);
/** `Sep 21, 14:00 UTC`. */
export const fmtDateTime = (unixSeconds: number) => `${dateTimeFmt.format(unixSeconds * 1000)} UTC`;
/** `Sep 21, 2026` (UTC): a day, with its year. */
export const fmtDay = (unixSeconds: number) => dayFmt.format(unixSeconds * 1000);

/** Spans longer than this many seconds name the month and year on the axis. */
export const LONG_SPAN_S = 300 * 86_400;

/** The axis label for a tick at `t` on a chart spanning `spanS` seconds with `count` points. */
export function axisLabel(t: number, spanS: number, count: number): string {
  if (spanS > LONG_SPAN_S) return monthFmt.format(t * 1000);
  if (count > 48 || spanS > 2 * 86_400) return fmtDate(t);
  return dateTimeFmt.format(t * 1000);
}
