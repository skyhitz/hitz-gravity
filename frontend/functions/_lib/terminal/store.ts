// The terminal's rows in D1 hitz-data (migration 0006_terminal.sql): checkouts, purchases, API keys,
// webhooks and their deliveries. Market data is never stored here.
//
// Erasable TypeScript, run in Node against a real SQLite by the tests (tests/helpers/d1.mjs).

import { planAt, type Purchase } from "./billing.ts";
import { isPlanId, type PlanId } from "./plans.ts";

export interface CheckoutRow {
  id: string;
  account: string;
  plan: PlanId;
  periods: number;
  asset: string;
  amount: string;
  amount_raw: string;
  usd: number;
  treasury: string;
  tx_hash: string | null;
  status: "pending" | "paid" | "expired";
  paid_tx: string | null;
  hitz_bought: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

export async function insertCheckout(db: D1Database, c: Omit<CheckoutRow, "status" | "paid_tx" | "hitz_bought" | "paid_at">): Promise<void> {
  await db
    .prepare(
      "INSERT INTO terminal_checkouts (id, account, plan, periods, asset, amount, amount_raw, usd, treasury, tx_hash, created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
    )
    .bind(c.id, c.account, c.plan, c.periods, c.asset, c.amount, c.amount_raw, c.usd, c.treasury, c.tx_hash, c.created_at, c.expires_at)
    .run();
}

export async function getCheckout(db: D1Database, id: string): Promise<CheckoutRow | null> {
  return (await db.prepare("SELECT * FROM terminal_checkouts WHERE id = ?1").bind(id).first<CheckoutRow>()) ?? null;
}

export async function listCheckouts(db: D1Database, account: string, limit = 20): Promise<CheckoutRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM terminal_checkouts WHERE account = ?1 ORDER BY created_at DESC LIMIT ?2")
    .bind(account, limit)
    .all<CheckoutRow>();
  return results ?? [];
}

/** Pending checkouts created after `sinceMs`, oldest first (the cron confirms or expires them). */
export async function pendingCheckouts(db: D1Database, sinceMs: number, limit = 20): Promise<CheckoutRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM terminal_checkouts WHERE status = 'pending' AND created_at >= ?1 ORDER BY created_at LIMIT ?2")
    .bind(sinceMs, limit)
    .all<CheckoutRow>();
  return results ?? [];
}

export async function markExpired(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE terminal_checkouts SET status = 'expired' WHERE id = ?1 AND status = 'pending'").bind(id).run();
}

export type PaidResult = { ok: true; fresh: boolean } | { ok: false; code: "tx_used" | "not_pending" };

/**
 * Mark a checkout paid by `paidTx` and record its purchase, in one batch (a transaction in D1). The
 * update takes a checkout not yet paid (an expired one too: the payment's own time was checked against
 * the checkout's window), and a transaction can pay one checkout only (UNIQUE), so a second
 * confirmation of the same payment, or one payment offered for two checkouts, adds nothing.
 */
export async function markPaid(db: D1Database, c: CheckoutRow, paidTx: string, hitzBought: string | null, paidAt: number): Promise<PaidResult> {
  const used = await db.prepare("SELECT id FROM terminal_checkouts WHERE paid_tx = ?1").bind(paidTx).first<{ id: string }>();
  if (used) return used.id === c.id ? { ok: true, fresh: false } : { ok: false, code: "tx_used" };
  try {
    const [updated] = await db.batch([
      db
        .prepare("UPDATE terminal_checkouts SET status = 'paid', paid_tx = ?2, hitz_bought = ?3, paid_at = ?4 WHERE id = ?1 AND status IN ('pending', 'expired') RETURNING id")
        .bind(c.id, paidTx, hitzBought, paidAt),
      db
        .prepare(
          "INSERT INTO terminal_purchases (account, plan, periods, usd, paid_at, checkout_id, tx_hash) " +
            "SELECT account, plan, periods, usd, ?2, id, ?3 FROM terminal_checkouts WHERE id = ?1 AND status = 'paid' AND paid_tx = ?3 " +
            "ON CONFLICT DO NOTHING"
        )
        .bind(c.id, paidAt, paidTx),
    ]);
    if (!(updated?.results ?? []).length) {
      const now = await getCheckout(db, c.id);
      return now?.status === "paid" && now.paid_tx === paidTx ? { ok: true, fresh: false } : { ok: false, code: "not_pending" };
    }
    return { ok: true, fresh: true };
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return { ok: false, code: "tx_used" };
    throw err;
  }
}

// ─── Purchases and plans ──────────────────────────────────────────────────────

export async function purchasesOf(db: D1Database, accounts: string[]): Promise<Map<string, Purchase[]>> {
  const out = new Map<string, Purchase[]>();
  if (!accounts.length) return out;
  const marks = accounts.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT account, plan, periods, usd, paid_at FROM terminal_purchases WHERE account IN (${marks}) ORDER BY paid_at`)
    .bind(...accounts)
    .all<Purchase & { account: string }>();
  for (const r of results ?? []) {
    if (!isPlanId(r.plan)) continue;
    const list = out.get(r.account) ?? [];
    list.push({ plan: r.plan, periods: r.periods, usd: r.usd, paid_at: r.paid_at });
    out.set(r.account, list);
  }
  return out;
}

export async function planOf(db: D1Database, account: string | null, nowMs: number) {
  if (!account) return planAt([], nowMs);
  return planAt((await purchasesOf(db, [account])).get(account) ?? [], nowMs);
}

// ─── API keys ─────────────────────────────────────────────────────────────────

export interface KeyRow {
  hash: string;
  prefix: string;
  account: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export async function insertKey(db: D1Database, k: { hash: string; prefix: string; account: string; label: string | null; created_at: number }) {
  await db
    .prepare("INSERT INTO terminal_keys (hash, prefix, account, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(k.hash, k.prefix, k.account, k.label, k.created_at)
    .run();
}

export async function listKeys(db: D1Database, account: string): Promise<Omit<KeyRow, "hash">[]> {
  const { results } = await db
    .prepare("SELECT prefix, account, label, created_at, last_used_at, revoked_at FROM terminal_keys WHERE account = ?1 ORDER BY created_at DESC")
    .bind(account)
    .all<Omit<KeyRow, "hash">>();
  return results ?? [];
}

export async function activeKeyCount(db: D1Database, account: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM terminal_keys WHERE account = ?1 AND revoked_at IS NULL").bind(account).first<{ n: number }>())?.n ?? 0;
}

export async function revokeKey(db: D1Database, account: string, prefix: string, nowMs: number): Promise<boolean> {
  const { results } = await db
    .prepare("UPDATE terminal_keys SET revoked_at = ?3 WHERE account = ?1 AND prefix = ?2 AND revoked_at IS NULL RETURNING hash")
    .bind(account, prefix, nowMs)
    .all();
  return (results ?? []).length > 0;
}

/** The account of an active key; notes its use at most once a minute. */
export async function keyAccount(db: D1Database, hash: string, nowMs: number): Promise<string | null> {
  const row = await db.prepare("SELECT account, last_used_at FROM terminal_keys WHERE hash = ?1 AND revoked_at IS NULL").bind(hash).first<{ account: string; last_used_at: number | null }>();
  if (!row) return null;
  if (!row.last_used_at || nowMs - row.last_used_at > 60_000) {
    await db.prepare("UPDATE terminal_keys SET last_used_at = ?2 WHERE hash = ?1").bind(hash, nowMs).run();
  }
  return row.account;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export interface WebhookRow {
  id: string;
  account: string;
  url: string;
  format: string;
  kinds: string | null;
  created_at: number;
  failures: number;
  last_status: number | null;
  last_at: number | null;
  disabled_at: number | null;
}

export async function insertWebhook(db: D1Database, w: { id: string; account: string; url: string; format: string; kinds: string[] | null; created_at: number }) {
  await db
    .prepare("INSERT INTO terminal_webhooks (id, account, url, format, kinds, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(w.id, w.account, w.url, w.format, w.kinds ? JSON.stringify(w.kinds) : null, w.created_at)
    .run();
}

export async function listWebhooks(db: D1Database, account: string): Promise<WebhookRow[]> {
  const { results } = await db.prepare("SELECT * FROM terminal_webhooks WHERE account = ?1 ORDER BY created_at").bind(account).all<WebhookRow>();
  return results ?? [];
}

export async function getWebhook(db: D1Database, account: string, id: string): Promise<WebhookRow | null> {
  return (await db.prepare("SELECT * FROM terminal_webhooks WHERE id = ?1 AND account = ?2").bind(id, account).first<WebhookRow>()) ?? null;
}

export async function deleteWebhook(db: D1Database, account: string, id: string): Promise<boolean> {
  const { results } = await db.prepare("DELETE FROM terminal_webhooks WHERE id = ?1 AND account = ?2 RETURNING id").bind(id, account).all();
  if (!(results ?? []).length) return false;
  await db.prepare("DELETE FROM terminal_deliveries WHERE webhook_id = ?1").bind(id).run();
  return true;
}

export async function activeWebhooks(db: D1Database): Promise<WebhookRow[]> {
  const { results } = await db.prepare("SELECT * FROM terminal_webhooks WHERE disabled_at IS NULL ORDER BY created_at").all<WebhookRow>();
  return results ?? [];
}

/** Which of these alerts each webhook already got: "webhookId|alertId". */
export async function deliveredPairs(db: D1Database, alertIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < alertIds.length; i += 50) {
    const chunk = alertIds.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT webhook_id, alert_id FROM terminal_deliveries WHERE alert_id IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})`)
      .bind(...chunk)
      .all<{ webhook_id: string; alert_id: string }>();
    for (const r of results ?? []) out.add(`${r.webhook_id}|${r.alert_id}`);
  }
  return out;
}

export const MAX_FAILURES = 50;

export async function recordDelivery(db: D1Database, hookId: string, alertId: string, status: number, nowMs: number): Promise<void> {
  const ok = status >= 200 && status < 300;
  await db.batch([
    db.prepare("INSERT INTO terminal_deliveries (webhook_id, alert_id, status, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING").bind(hookId, alertId, status, nowMs),
    ok
      ? db.prepare("UPDATE terminal_webhooks SET failures = 0, last_status = ?2, last_at = ?3 WHERE id = ?1").bind(hookId, status, nowMs)
      : db
          .prepare(
            "UPDATE terminal_webhooks SET failures = failures + 1, last_status = ?2, last_at = ?3, " +
              "disabled_at = CASE WHEN failures + 1 >= ?4 THEN ?3 ELSE disabled_at END WHERE id = ?1"
          )
          .bind(hookId, status, nowMs, MAX_FAILURES),
  ]);
}

export async function pruneDeliveries(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM terminal_deliveries WHERE at < ?1").bind(nowMs - 14 * 86_400_000).run();
}

export async function getState(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM terminal_state WHERE key = ?1").bind(key).first<{ value: string }>())?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO terminal_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}
