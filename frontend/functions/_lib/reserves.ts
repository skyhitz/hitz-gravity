// How much XLM an account can spend: its balance minus the reserves it has
// to hold, including the ones it sponsors for other accounts.
//
// The gas sponsor's balance is almost all of the second kind, so whatever
// asks "can the sponsor pay?" (the low-balance alert, the operating floor)
// has to go by the spendable part. The total says nothing about it.
//
// Pure and erasable TypeScript, so tests/reserves.test.mjs runs it in Node.

/** Mainnet's base reserve, in stroops (0.5 XLM). */
export const BASE_RESERVE = 5_000_000n;

/** The part of a Horizon account record the reserve math needs. */
export interface AccountRecord {
  balances: { asset_type: string; balance: string; selling_liabilities?: string }[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

export interface NativeFunds {
  /** Stroops. */
  total: bigint;
  /** Held as reserve: (2 + subentries + sponsoring − sponsored) base reserves. */
  locked: bigint;
  /** What can be paid out or spent on fees. */
  spendable: bigint;
}

/** Horizon's decimal strings (7 places at most) → stroops. */
export function toStroops(decimal: string): bigint {
  const [whole, frac = ""] = decimal.split(".");
  return BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
}

/** Stroops → a decimal string with seven places, as Stellar amounts are written. */
export function fromStroops(stroops: bigint): string {
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  return `${sign}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, "0")}`;
}

export function nativeFunds(account: AccountRecord): NativeFunds {
  const line = account.balances.find((b) => b.asset_type === "native");
  const total = line ? toStroops(line.balance) : 0n;
  const entries =
    2n + BigInt(account.subentry_count) + BigInt(account.num_sponsoring ?? 0) - BigInt(account.num_sponsored ?? 0);
  const locked = (entries > 0n ? entries : 0n) * BASE_RESERVE;
  const free = total - locked - toStroops(line?.selling_liabilities ?? "0");
  return { total, locked, spendable: free > 0n ? free : 0n };
}
