// Paying for a plan: the checkout's swap, how a payment is checked on chain, and that one payment buys
// one period once (D1 on SQLite with the real migrations; the chain is a fake).

import assert from "node:assert/strict";
import { test } from "node:test";
import { amountFor, checkPayment, confirmCheckout, reconcileCheckouts, startCheckout } from "../functions/_lib/terminal/checkout.ts";
import { planOf } from "../functions/_lib/terminal/store.ts";
import { PERIOD_MS } from "../functions/_lib/terminal/plans.ts";
import { testDb } from "./helpers/d1.mjs";

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const ACCOUNT = "GBUYER";
const TREASURY = "GTREASURY";
const H = (n) => n.toString(16).padStart(64, "0");

/** A chain where `ledger` holds the transactions that landed, by hash. */
function fakeChain() {
  const ledger = new Map();
  const built = [];
  let n = 0;
  return {
    ledger,
    built,
    vaultId: "CVAULT",
    hitzContract: "CHITZ",
    contractOf: (a) => (a === "XLM" ? "CXLM" : "CUSDC"),
    treasury: async () => TREASURY,
    xlmUsd: async () => 0.15,
    async buildSwap(input) {
      n += 1;
      built.push(input);
      return { xdr: `xdr-${n}`, hash: H(n), validUntil: T0 + 600_000, expectedHitz: "1000.5", argsXdr: ["a", "b"] };
    },
    async submit(xdr) {
      return { hash: H(Number(xdr.split("-")[1])) };
    },
    hashOf: (xdr) => H(Number(String(xdr).split("-")[1])),
    readTx: async (hash) => ledger.get(hash) ?? null,
  };
}

/** The swap a checkout asked for, as it would land on chain. */
const paidTx = (hash, c, over = {}) => ({
  hash,
  status: "SUCCESS",
  closedAt: T0 + 30_000,
  call: { from: ACCOUNT, to: TREASURY, tokenIn: c.asset === "XLM" ? "CXLM" : "CUSDC", tokenOut: "CHITZ", amountIn: BigInt(c.amount_raw), minOut: 1n },
  bought: 12_345_678_900n,
  ...over,
});

test("amounts: dollars in 7 decimals, XLM rounded up so a payment is never short", () => {
  assert.deepEqual(amountFor("USDC", 99, null), { amount: "99", raw: 990_000_000n });
  const x = amountFor("XLM", 29, 0.1478);
  assert.equal(x.raw, BigInt(Math.ceil((29 / 0.1478) * 1e7)));
  assert.ok(Number(x.amount) * 0.1478 >= 29);
  assert.throws(() => amountFor("XLM", 29, null), (e) => e.code === "no_price");
});

test("a checkout builds the swap to the treasury and records it", async () => {
  const db = testDb();
  const chain = fakeChain();
  const c = await startCheckout(db, chain, { account: ACCOUNT, plan: "pro", periods: 1, asset: "USDC" }, T0);
  assert.equal(c.usd, 99);
  assert.deepEqual(c.pay, { asset: "USDC", amount: "99" });
  assert.equal(c.treasury, TREASURY);
  assert.deepEqual(chain.built[0], { account: ACCOUNT, sell: "USDC", amount: "99", to: TREASURY });
  assert.deepEqual(c.gateway_call, { contractId: "CVAULT", method: "swap", argsXdr: ["a", "b"] });
  const row = db.raw.prepare("SELECT * FROM terminal_checkouts").get();
  assert.equal(row.status, "pending");
  assert.equal(row.tx_hash, H(1));
  for (const bad of [{ plan: "free" }, { plan: "pro", periods: 3 }, { plan: "pro", asset: "BTC" }]) {
    await assert.rejects(startCheckout(db, chain, { account: ACCOUNT, periods: 1, asset: "USDC", ...bad }, T0));
  }
});

test("a payment counts only if it is this checkout's swap: account, treasury, asset, amount, time", () => {
  const c = { account: ACCOUNT, treasury: TREASURY, asset: "USDC", amount: "99", amount_raw: "990000000", created_at: T0, expires_at: T0 + 600_000 };
  const chain = { contractOf: (a) => (a === "XLM" ? "CXLM" : "CUSDC"), hitzContract: "CHITZ" };
  const ok = paidTx(H(1), c);
  assert.deepEqual(checkPayment(ok, c, chain), { ok: true });
  const code = (tx) => checkPayment(tx, c, chain).code;
  assert.equal(code({ ...ok, status: "FAILED" }), "payment_failed");
  assert.equal(code({ ...ok, call: null }), "not_a_payment");
  assert.equal(code({ ...ok, call: { ...ok.call, from: "GOTHER" } }), "wrong_account");
  assert.equal(code({ ...ok, call: { ...ok.call, to: ACCOUNT } }), "wrong_recipient");
  assert.equal(code({ ...ok, call: { ...ok.call, tokenIn: "CXLM" } }), "wrong_asset");
  assert.equal(code({ ...ok, call: { ...ok.call, tokenOut: "CUSDC" } }), "wrong_asset");
  assert.equal(code({ ...ok, call: { ...ok.call, amountIn: 989_999_999n } }), "short_payment");
  assert.equal(code({ ...ok, closedAt: T0 - 3_600_000 }), "outside_window");
  assert.equal(code({ ...ok, closedAt: T0 + 3_600_000 }), "outside_window");
});

test("confirming: pending until it lands, then one period, however many times it is confirmed", async () => {
  const db = testDb();
  const chain = fakeChain();
  const c = await startCheckout(db, chain, { account: ACCOUNT, plan: "pro", periods: 1, asset: "USDC" }, T0);
  const row = db.raw.prepare("SELECT * FROM terminal_checkouts").get();
  assert.equal((await confirmCheckout(db, chain, ACCOUNT, { id: c.checkout_id }, T0 + 5_000)).status, "pending");
  chain.ledger.set(H(1), paidTx(H(1), row));
  const done = await confirmCheckout(db, chain, ACCOUNT, { id: c.checkout_id, xdr: "xdr-1" }, T0 + 40_000);
  assert.equal(done.status, "paid");
  assert.equal(done.hitz_to_treasury, "1234.56789");
  assert.equal(done.subscription.plan, "pro");
  assert.equal((await confirmCheckout(db, chain, ACCOUNT, { id: c.checkout_id }, T0 + 50_000)).status, "paid");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM terminal_purchases").get().n, 1);
  const s = await planOf(db, ACCOUNT, T0 + DAY());
  assert.equal(s.until, T0 + 30_000 + PERIOD_MS);
  // Someone else cannot confirm it, and a signed transaction that is not this checkout's is refused.
  await assert.rejects(confirmCheckout(db, chain, "GOTHER", { id: c.checkout_id }, T0), (e) => e.code === "unknown_checkout");
  const c2 = await startCheckout(db, chain, { account: ACCOUNT, plan: "trader", periods: 1, asset: "USDC" }, T0 + 60_000);
  await assert.rejects(confirmCheckout(db, chain, ACCOUNT, { id: c2.checkout_id, xdr: "xdr-1" }, T0 + 61_000), (e) => e.code === "not_this_checkout");
});

const DAY = () => 86_400_000;

test("one payment cannot pay two checkouts", async () => {
  const db = testDb();
  const chain = fakeChain();
  const a = await startCheckout(db, chain, { account: ACCOUNT, plan: "trader", periods: 1, asset: "USDC" }, T0);
  const b = await startCheckout(db, chain, { account: ACCOUNT, plan: "trader", periods: 1, asset: "USDC" }, T0);
  const rows = db.raw.prepare("SELECT * FROM terminal_checkouts ORDER BY tx_hash").all();
  chain.ledger.set(H(1), paidTx(H(1), rows[0]));
  await confirmCheckout(db, chain, ACCOUNT, { id: a.checkout_id }, T0 + 40_000);
  await assert.rejects(confirmCheckout(db, chain, ACCOUNT, { id: b.checkout_id, tx_hash: H(1) }, T0 + 41_000), (e) => e.code === "tx_used");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM terminal_purchases").get().n, 1);
});

test("an email account's gateway transaction pays it too: a different hash, the same swap", async () => {
  const db = testDb();
  const chain = fakeChain();
  const c = await startCheckout(db, chain, { account: ACCOUNT, plan: "institutional", periods: 12, asset: "XLM" }, T0);
  const row = db.raw.prepare("SELECT * FROM terminal_checkouts").get();
  assert.equal(c.usd, 4990);
  chain.ledger.set(H(99), paidTx(H(99), row));
  const done = await confirmCheckout(db, chain, ACCOUNT, { id: c.checkout_id, tx_hash: H(99).toUpperCase() }, T0 + 60_000);
  assert.equal(done.status, "paid");
  assert.equal((await planOf(db, ACCOUNT, T0 + 300 * 86_400_000)).plan, "institutional");
  // A failed or short gateway swap pays nothing.
  const d = await startCheckout(db, chain, { account: ACCOUNT, plan: "trader", periods: 1, asset: "USDC" }, T0);
  const drow = db.raw.prepare("SELECT * FROM terminal_checkouts WHERE id = ?").get(d.checkout_id);
  chain.ledger.set(H(98), paidTx(H(98), drow, { call: { ...paidTx(H(98), drow).call, amountIn: 1n } }));
  await assert.rejects(confirmCheckout(db, chain, ACCOUNT, { id: d.checkout_id, tx_hash: H(98) }, T0 + 60_000), (e) => e.code === "short_payment" && e.status === 402);
});

test("the cron confirms payments whose page was closed, and expires the ones never paid", async () => {
  const db = testDb();
  const chain = fakeChain();
  await startCheckout(db, chain, { account: ACCOUNT, plan: "pro", periods: 1, asset: "USDC" }, T0);
  await startCheckout(db, chain, { account: "GSECOND", plan: "pro", periods: 1, asset: "USDC" }, T0);
  const first = db.raw.prepare("SELECT * FROM terminal_checkouts WHERE account = ?").get(ACCOUNT);
  chain.ledger.set(first.tx_hash, paidTx(first.tx_hash, first));
  assert.deepEqual(await reconcileCheckouts(db, chain, T0 + 60_000), { checked: 2, paid: 1, expired: 0 });
  assert.deepEqual(await reconcileCheckouts(db, chain, T0 + 3_600_000), { checked: 1, paid: 0, expired: 1 });
  assert.deepEqual(
    db.raw.prepare("SELECT account, status FROM terminal_checkouts ORDER BY account").all().map((r) => ({ ...r })),
    [{ account: ACCOUNT, status: "paid" }, { account: "GSECOND", status: "expired" }],
  );
});
