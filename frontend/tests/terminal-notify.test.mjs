// The email to the operator when someone pays for a plan: one per payment, sent by the cron, never
// twice and never skipped (D1 on SQLite with the real migrations; the mail sender is a fake that
// records what it was asked to send).

import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyPurchases } from "../functions/_lib/terminal/notify.ts";
import { insertCheckout, markPaid } from "../functions/_lib/terminal/store.ts";
import { testDb } from "./helpers/d1.mjs";

const T0 = Date.UTC(2026, 10, 23, 14, 5, 0);
const H = (n) => n.toString(16).padStart(64, "0");
let ids = 0;

/** A checkout for `plan`, paid on chain by transaction H(n) at `paidAt`. */
async function pay(db, { plan, periods, usd, asset, amount, account, n, paidAt = T0 }) {
  ids += 1;
  const c = {
    id: `checkout-${ids}`,
    account,
    plan,
    periods,
    asset,
    amount,
    amount_raw: "1",
    usd,
    treasury: "GTREASURY",
    tx_hash: H(n),
    created_at: paidAt - 60_000,
    expires_at: paidAt + 540_000,
  };
  await insertCheckout(db, c);
  const paid = await markPaid(db, { ...c, status: "pending", paid_tx: null, hitz_bought: null, paid_at: null }, H(n), "961234.5678901", paidAt);
  assert.deepEqual(paid, { ok: true, fresh: true });
}

const TRADER = { plan: "trader", periods: 1, usd: 29, asset: "USDC", amount: "29", account: "GTRADERBUYER", n: 1 };
const PRO_YEAR = { plan: "pro", periods: 12, usd: 990, asset: "XLM", amount: "6600.0000001", account: "GPROBUYER", n: 2 };

/** A mail sender that records each message it delivers, and fails the calls listed in `failing`. */
function fakeMail(failing = new Set()) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    async mail(m) {
      calls += 1;
      if (failing.has(calls)) throw new Error("send_email refused the message");
      sent.push(m);
    },
  };
}

test("a payment sends the operator one email with the plan, price, account and transaction", async () => {
  const db = testDb();
  await pay(db, TRADER);
  const out = fakeMail();
  assert.deepEqual(await notifyPurchases({ db, mail: out.mail }), { sent: 1 });
  assert.equal(out.sent.length, 1);
  const [m] = out.sent;
  assert.match(m.subject, /Trader/);
  assert.match(m.subject, /\$29\b/);
  for (const line of [
    "Plan: Trader, 30 days",
    "Price: $29",
    "Paid: 29 USDC",
    "Account: GTRADERBUYER",
    "When: 2026-11-23 14:05 UTC",
    `Transaction: https://stellar.expert/explorer/public/tx/${H(1)}`,
  ]) {
    assert.ok(m.text.split("\n").includes(line), `missing line "${line}" in:\n${m.text}`);
  }
});

test("a grant is not a payment and is never emailed as one", async () => {
  const db = testDb();
  db.raw.prepare("INSERT INTO terminal_grants (account, plan, until, note, created_at) VALUES ('GGIVEN', 'institutional', NULL, 'test', ?)").run(T0);
  const out = fakeMail();
  assert.deepEqual(await notifyPurchases({ db, mail: out.mail }), { sent: 0 });
  assert.equal(out.sent.length, 0);
});

test("each payment is emailed once, however often the cron runs", async () => {
  const db = testDb();
  await pay(db, TRADER);
  const out = fakeMail();
  await notifyPurchases({ db, mail: out.mail });
  assert.deepEqual(await notifyPurchases({ db, mail: out.mail }), { sent: 0 });
  assert.equal(out.sent.length, 1);

  // A later payment is the only one the next run sends: a year of Pro, paid in XLM.
  await pay(db, { ...PRO_YEAR, paidAt: T0 + 3_600_000 });
  assert.deepEqual(await notifyPurchases({ db, mail: out.mail }), { sent: 1 });
  assert.equal(out.sent.length, 2);
  assert.match(out.sent[1].subject, /Pro/);
  assert.match(out.sent[1].subject, /\$990\b/);
  assert.ok(out.sent[1].text.split("\n").includes("Plan: Pro, 360 days"), out.sent[1].text);
  assert.ok(out.sent[1].text.split("\n").includes("Paid: 6600.0000001 XLM"), out.sent[1].text);
});

test("a send that fails is tried again on the next run, and no later payment is skipped", async () => {
  const db = testDb();
  await pay(db, TRADER);
  await pay(db, { ...PRO_YEAR, paidAt: T0 + 3_600_000 });

  const down = fakeMail(new Set([1]));
  const first = await notifyPurchases({ db, mail: down.mail });
  assert.equal(first.sent, 0);
  assert.match(first.error, /refused/);
  assert.equal(down.sent.length, 0);

  const up = fakeMail();
  assert.deepEqual(await notifyPurchases({ db, mail: up.mail }), { sent: 2 });
  assert.deepEqual(
    up.sent.map((m) => /Trader|Pro/.exec(m.subject)?.[0]),
    ["Trader", "Pro"]
  );
});
