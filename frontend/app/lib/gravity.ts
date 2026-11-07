/**
 * gravity.ts: the token's Event Horizon math, for previews.
 *
 * L = isqrt(S × 10^7), where S (Total Mass) is the HITZ held by registered
 * pools: the Sovereign Vault and the treasury account. HITZ moving into a
 * pool raises S; HITZ leaving one lowers it. The token syncs the receiver's
 * vault flag after it has updated S, so a purchase from the vault is judged
 * against the L that the purchase itself leaves behind.
 */

/** Integer square root over BigInt (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** The token's safety limit for a Total Mass, both in 7-decimal units. */
export function limitFor(totalMass: bigint): bigint {
  return totalMass > 0n ? isqrt(totalMass * 10_000_000n) : 0n;
}

/**
 * The smallest amount of HITZ that, moved from the account into a registered
 * pool (sold into the vault, or sacrificed), leaves `balance − x ≤ L(S + x)`.
 * Null if even the whole balance wouldn't do; 0 if the account is already free.
 */
export function minimumToRelease(balance: bigint, totalMass: bigint): bigint | null {
  if (balance <= 0n) return null;
  const free = (x: bigint) => balance - x <= limitFor(totalMass + x);
  if (!free(balance)) return null;
  if (free(0n)) return 0n;
  let lo = 0n;
  let hi = balance;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (free(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
