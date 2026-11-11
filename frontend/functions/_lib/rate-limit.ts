// Fixed-window rate limits in D1 (table `rate_counters`, migration 0005).
//
// Each limit is a bucket ("login:ip:203.0.113.7"), a count and a window. A
// hit adds one to the bucket's row for the current window and reads the new
// count back in the same statement, so concurrent requests can't both slip
// under the limit. A refused hit still counts against the limit that refused
// it, and against nothing that comes after it (see `hit`).
//
// Everything a public endpoint can be made to do is counted: emails sent,
// lookups, transactions the sponsor pays for, accounts it opens (limits.ts).

export interface Limit {
  /** What is being counted, and for whom. */
  bucket: string;
  /** Hits allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface Verdict {
  ok: boolean;
  /** The bucket that is over its limit. */
  exceeded?: string;
  /** Seconds until that bucket's window ends. */
  retryAfter?: number;
}

const COUNT =
  "INSERT INTO rate_counters (bucket, win, n) VALUES (?1, ?2, 1) " +
  "ON CONFLICT (bucket, win) DO UPDATE SET n = n + 1 RETURNING n";

/**
 * Count one hit against groups of limits, in order. The limits of a group are
 * counted together, and the hit is refused as soon as one of them is over;
 * the groups after that one are not counted.
 *
 * So the order matters: the caller's own limits go first and the ones
 * everybody shares go last. A caller over their own limit then can't use up
 * a shared one with requests that were all refused, which would switch the
 * endpoint off for everyone else.
 */
export async function hit(db: D1Database, groups: Limit[][], nowMs: number = Date.now()): Promise<Verdict> {
  const now = Math.floor(nowMs / 1000);
  for (const limits of groups) {
    if (!limits.length) continue;
    const counted = await db.batch(
      limits.map((l) => db.prepare(COUNT).bind(`${l.bucket}|${l.windowSeconds}`, now - (now % l.windowSeconds)))
    );
    for (let i = 0; i < limits.length; i++) {
      const n = Number((counted[i].results[0] as { n: number } | undefined)?.n ?? 0);
      if (n > limits[i].limit) {
        return { ok: false, exceeded: limits[i].bucket, retryAfter: limits[i].windowSeconds - (now % limits[i].windowSeconds) };
      }
    }
  }
  return { ok: true };
}

/** Drop windows that ended long ago (the longest window is a day). Run by the cron. */
export async function pruneRateCounters(db: D1Database, nowMs: number = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM rate_counters WHERE win < ?1").bind(Math.floor(nowMs / 1000) - 2 * 86_400).run();
}

/**
 * The caller an address counts as, for per-address limits. IPv4 addresses
 * stand for themselves. An IPv6 address stands for its /64: one subscriber
 * or server is handed the whole /64 and can use any address in it, so
 * counting single addresses would limit nothing. Anything unreadable shares
 * one bucket.
 */
export function callerBucket(ip: string): string {
  const text = ip.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
  if (!/^[0-9a-f:]+$/.test(text) || !text.includes(":")) return "unknown";
  const halves = text.split("::");
  if (halves.length > 2) return "unknown";
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return "unknown";
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "unknown";
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
