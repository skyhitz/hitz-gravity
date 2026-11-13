// Alert webhooks: which URLs are accepted, how deliveries are signed and formatted, and that each alert
// reaches each paying subscriber's webhook once.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { bodyFor, checkWebhookUrl, CURSOR_KEY, deliverAlerts, signatureHeader, webhookSecret } from "../functions/_lib/terminal/webhooks.ts";
import { insertWebhook, MAX_FAILURES } from "../functions/_lib/terminal/store.ts";
import { testDb } from "./helpers/d1.mjs";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const SECRET = "d".repeat(64);

test("webhook URLs: public https host names only", () => {
  for (const ok of ["https://discord.com/api/webhooks/1/abc", "https://hooks.slack.com/services/T/B/x", "https://alerts.fund.example.org/xlm"]) {
    assert.equal(checkWebhookUrl(ok).ok, true, ok);
  }
  for (const bad of [
    "http://discord.com/api/webhooks/1/abc",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://printer.local/hook",
    "https://api.internal/hook",
    "https://user:pw@example.org/hook",
    "https://example.org:8443/hook",
    "https://intranet/hook",
    "ftp://example.org",
    "not a url",
    42,
  ]) {
    assert.equal(checkWebhookUrl(bad).ok, false, String(bad));
  }
});

test("deliveries are signed so a receiver can check them", async () => {
  const secret = await webhookSecret(SECRET, "hook1");
  assert.match(secret, /^whsec_[0-9a-f]{64}$/);
  assert.notEqual(secret, await webhookSecret(SECRET, "hook2"));
  const body = '{"id":"x"}';
  const header = await signatureHeader(secret, body, T0);
  const t = T0 / 1000;
  assert.equal(header, `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`);
});

test("bodies: our JSON, or a message Discord and Slack post as is", () => {
  const a = { id: "xfer:1", kind: "sdf_deposit", at: T0, title: "SDF sent 25.0M XLM to Kraken", text: "SDF sent 25.0M XLM to Kraken at 12:00 UTC.", data: { xlm: 25e6 } };
  assert.deepEqual(JSON.parse(bodyFor("json", a)), { id: "xfer:1", kind: "sdf_deposit", at: new Date(T0).toISOString(), title: a.title, text: a.text, data: { xlm: 25e6 }, source: "HITZ Terminal" });
  assert.deepEqual(JSON.parse(bodyFor("discord", a)), { username: "HITZ Terminal", content: `**${a.title}**\n${a.text}` });
  assert.deepEqual(JSON.parse(bodyFor("slack", a)), { text: `*${a.title}*\n${a.text}` });
});

/** Two accounts: GPAID has Pro, GFREE has nothing. */
function world() {
  const db = testDb();
  db.raw
    .prepare("INSERT INTO terminal_purchases (account, plan, periods, usd, paid_at, checkout_id, tx_hash) VALUES ('GPAID', 'pro', 1, 99, ?, 'c1', 'h1')")
    .run(T0 - 86_400_000);
  return db;
}

const alertsAt = (...ats) => ats.map((at, i) => ({ id: `xfer:${i}`, kind: i % 2 ? "exchange_deposit" : "liquidation_burst", at, title: `t${i}`, text: `x${i}`, data: {} }));

test("each alert reaches each paying subscriber's webhook once, and never a free account's", async () => {
  const db = world();
  await insertWebhook(db, { id: "paid", account: "GPAID", url: "https://a.example.org/h", format: "json", kinds: null, created_at: T0 });
  await insertWebhook(db, { id: "free", account: "GFREE", url: "https://b.example.org/h", format: "json", kinds: null, created_at: T0 });
  await insertWebhook(db, { id: "only-dep", account: "GPAID", url: "https://c.example.org/h", format: "slack", kinds: ["exchange_deposit"], created_at: T0 + 1 });
  const sent = [];
  const deps = {
    db,
    alerts: async () => alertsAt(T0 - 60_000, T0 - 30_000),
    send: async (url, body, headers) => (sent.push({ url, body, headers }), 200),
    terminalSecret: SECRET,
    nowMs: T0,
  };
  const r = await deliverAlerts(deps);
  assert.deepEqual(r, { alerts: 2, sent: 3, failed: 0, hooks: 2 });
  assert.deepEqual(sent.map((s) => s.url).sort(), ["https://a.example.org/h", "https://a.example.org/h", "https://c.example.org/h"]);
  assert.ok(sent.every((s) => /^t=\d+,v1=[0-9a-f]{64}$/.test(s.headers["X-Skyhitz-Signature"])));
  sent.length = 0;
  assert.deepEqual(await deliverAlerts({ ...deps, nowMs: T0 + 300_000 }), { alerts: 2, sent: 0, failed: 0, hooks: 2 });
  assert.equal(Number(db.raw.prepare("SELECT value FROM terminal_state WHERE key = ?").get(CURSOR_KEY).value), T0 + 300_000);
});

test("stale alerts are not pushed, and a webhook that keeps failing is switched off", async () => {
  const db = world();
  await insertWebhook(db, { id: "down", account: "GPAID", url: "https://down.example.org/h", format: "json", kinds: null, created_at: T0 });
  let n = 0;
  const deps = (now) => ({ db, alerts: async () => alertsAt(T0 - 7 * 3_600_000, now - 1000).map((a, i) => ({ ...a, id: `a${now}-${i}` })), send: async () => (n++, 500), terminalSecret: SECRET, nowMs: now });
  const r = await deliverAlerts(deps(T0));
  assert.deepEqual([r.alerts, r.failed], [1, 1], "the 7-hour-old alert is dropped");
  for (let i = 1; i < MAX_FAILURES; i++) await deliverAlerts(deps(T0 + i * 1000));
  const row = db.raw.prepare("SELECT failures, disabled_at FROM terminal_webhooks WHERE id = 'down'").get();
  assert.equal(row.failures, MAX_FAILURES);
  assert.notEqual(row.disabled_at, null);
  const before = n;
  await deliverAlerts(deps(T0 + 100_000));
  assert.equal(n, before, "a switched-off webhook gets nothing");
});

test("after a downgrade an account keeps its oldest webhooks only, up to the plan's allowance", async () => {
  const db = testDb();
  db.raw.prepare("INSERT INTO terminal_purchases (account, plan, periods, usd, paid_at, checkout_id, tx_hash) VALUES ('GT', 'trader', 1, 29, ?, 'c1', 'h1')").run(T0 - 1000);
  for (let i = 0; i < 4; i++) await insertWebhook(db, { id: `h${i}`, account: "GT", url: `https://h${i}.example.org/x`, format: "json", kinds: null, created_at: T0 + i });
  const urls = [];
  await deliverAlerts({ db, alerts: async () => alertsAt(T0 - 1000), send: async (u) => (urls.push(u), 204), terminalSecret: SECRET, nowMs: T0 });
  assert.deepEqual(urls, ["https://h0.example.org/x", "https://h1.example.org/x"]);
});
