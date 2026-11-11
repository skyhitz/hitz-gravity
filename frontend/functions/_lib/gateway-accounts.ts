// The record of every reserve the sponsor locks for an email account
// (D1 `gateway_accounts`, migration 0005).
//
// The sponsor's XLM in an account's reserves is locked, not spent: it comes
// back when the account is merged or its trustline removed, and both take
// the account's key. The key derives from the email's digest and
// MASTER_SECRET, so the digest is written down before the sponsor pays for
// anything. An account without a record can't be opened again, and the
// reserve the sponsor holds for it stays locked for good.
//
// Erasable TypeScript without Worker bindings, so
// tests/gateway-accounts.test.mjs runs it in Node.

export interface SponsoredRecord {
  address: string;
  /** SHA-256 of the normalized email, in hex (derive.ts `emailDigest`). */
  emailDigest: string;
  /** What the sponsor paid for: an account ("execute", "reparation") or only its USDC trustline. */
  reason: "execute" | "reparation" | "trustline";
}

/**
 * Write down that the sponsor is about to lock a reserve for this account.
 * The first record of an address stands: an account the gateway created
 * keeps that reason when its trustline is added later.
 */
export async function recordSponsored(db: D1Database, record: SponsoredRecord, now: Date = new Date()): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(record.emailDigest)) throw new Error("invalid email digest");
  await db
    .prepare("INSERT OR IGNORE INTO gateway_accounts (address, email_sha256, reason, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(record.address, record.emailDigest, record.reason, now.toISOString())
    .run();
}

/** Accounts the gateway has created since `since`. Trustline-only records are not accounts. */
export async function newAccountsSince(db: D1Database, since: Date): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM gateway_accounts WHERE created_at >= ?1 AND reason <> 'trustline'")
    .bind(since.toISOString())
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
