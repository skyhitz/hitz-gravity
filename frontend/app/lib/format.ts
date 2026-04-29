/**
 * format.ts — thin UI helpers.
 *
 * `formatStroops` in swap.ts trims trailing zeros, which is the right default
 * for the Smart Swap amount field (users type `1.0000000` but want to see
 * `1`). The redesign's Pulse bar / Monitor stats / sacrifice meter want
 * stable column widths — i.e. always 2 or 4 decimals. `fmtFixed` gives us
 * that without recomputing the divisor bigint in every caller.
 */

/**
 * Format a bigint stroop amount to a locale-aware string with exactly
 * `digits` fractional digits. Token decimals default to 7 (HITZ).
 */
export function fmtFixed(
  stroops: bigint | null | undefined,
  digits = 4,
  decimals = 7
): string {
  if (stroops === null || stroops === undefined) return "—";
  const divisor = BigInt(10 ** decimals);
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, digits);
  // Insert thousands separators in the whole part.
  const wholeStr = whole.toLocaleString();
  const prefix = negative ? "-" : "";
  return digits === 0 ? `${prefix}${wholeStr}` : `${prefix}${wholeStr}.${fracStr}`;
}

/** Short address like `CABCD…XYZ01`. */
export function truncAddr(a: string, head = 6, tail = 6): string {
  if (!a) return "";
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/**
 * Ratio (0..inf) of (balance + expected) / L, as a plain JS number (percent).
 * Returns 0 when L is 0 (pre-launch or total-mass-empty). Safe with bigints:
 * we divide under BigInt first (scaled by 10_000 for 2-dp) and then cast.
 */
export function pressureRatioPct(
  balance: bigint | null,
  expected: bigint,
  eventHorizon: bigint
): number {
  if (eventHorizon <= 0n) return 0;
  const bal = balance ?? 0n;
  const scaled = ((bal + expected) * 10_000n) / eventHorizon;
  return Number(scaled) / 100;
}
