/** Number and time formats for the HITZ Terminal. House style: no em-dashes. */

export const usd = (v: number | null | undefined, digits = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(digits)}k`;
  return `$${v.toFixed(a >= 100 ? 0 : 2)}`;
};

export const xlm = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
};

export const pct = (v: number | null | undefined, digits = 2, signed = true): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};

/** A fraction (0.05) as a percent. */
export const frac = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined ? "n/a" : pct(v * 100, digits));

export const price = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `$${v.toFixed(v >= 1 ? 3 : 4)}`);

const hm = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const mdhm = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const md = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export const timeUtc = (ms: number | string | null | undefined): string => (ms === null || ms === undefined ? "n/a" : hm.format(new Date(ms)));
export const stamp = (ms: number | string | null | undefined): string => (ms === null || ms === undefined ? "n/a" : `${mdhm.format(new Date(ms))} UTC`);
export const day = (ms: number | string | null | undefined): string => (ms === null || ms === undefined ? "n/a" : md.format(new Date(typeof ms === "string" && ms.length === 10 ? `${ms}T00:00:00Z` : ms)));

/** Green for up, red for down, muted for flat or unknown. */
export const tone = (v: number | null | undefined): string => (v === null || v === undefined || v === 0 ? "text-muted" : v > 0 ? "text-green" : "text-red");

export const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "n/a");
