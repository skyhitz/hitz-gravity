/**
 * swap.ts — Physics helpers + shared units.
 *
 * All routing/quoting logic lives in `./aggregator.ts` (pure split search) and
 * `./aqua.ts` (on-chain simulation and XDR build). This file stays dumb: it
 * owns the Event-Horizon math and the token-amount utilities, so both the
 * aggregator and the UI can import from one place without pulling in the
 * stellar-sdk when they just need to do arithmetic.
 */

// ─── Event Horizon physics ────────────────────────────────────────────────────

/**
 * Returns true if (currentBalance + expectedOutput) > eventHorizon.
 * Matches the on-chain check: `balance_after > L` triggers vaulting.
 */
export function willCrossEventHorizon(
  currentBalance: bigint,
  expectedOutput: bigint,
  eventHorizon: bigint
): boolean {
  return currentBalance + expectedOutput > eventHorizon;
}

/** Ratio of (balance + output) / L, expressed as a percentage (0–∞). */
export function pressureRatio(
  currentBalance: bigint,
  expectedOutput: bigint,
  eventHorizon: bigint
): number {
  if (eventHorizon <= 0n) return 0;
  const numerator = Number(currentBalance + expectedOutput);
  const denominator = Number(eventHorizon);
  return (numerator / denominator) * 100;
}

// ─── Stroop utilities ─────────────────────────────────────────────────────────

/** Converts a human amount (e.g. "1.5") to stroops (7-decimal fixed-point). */
export function parseAmount(human: string, decimals = 7): bigint {
  const trimmed = human.trim();
  if (!trimmed) return 0n;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded || "0");
}

/** Legacy alias — kept for any caller that already imports `parseXlm`. */
export const parseXlm = parseAmount;

/** Formats stroops to a human-readable string, trimming trailing zeros. */
export function formatStroops(stroops: bigint, decimals = 7): string {
  const divisor = BigInt(10 ** decimals);
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / divisor;
  const frac = abs % divisor;
  const prefix = negative ? "-" : "";
  if (frac === 0n) return prefix + whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${prefix}${whole.toLocaleString()}.${fracStr}`;
}

/** Applies slippage-in-bps to an expected output and returns the minOut floor. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return amount;
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.floor(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}
