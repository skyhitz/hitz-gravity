// The gateway's limits, applied the way the endpoints apply them.
//
// The limits everyone shares (emails sent per hour, sponsored transactions
// per day) bound what the Worker can be made to do in total. They must not
// become a way for one caller to switch the gateway off for everybody else.

import assert from "node:assert/strict";
import { test } from "node:test";
import { executeLimits, loginLimits, newAccountLimits, notifyCallerLimits, notifyTransferLimits, resolveLimits, sponsoredLimits } from "../functions/_lib/limits.ts";
import { hit } from "../functions/_lib/rate-limit.ts";
import { testDb } from "./helpers/d1.mjs";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const digest = (i) => i.toString(16).padStart(64, "0");
const count = (db, bucket) => db.raw.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM rate_counters WHERE bucket = ?").get(bucket).n;

test("one address hammering sign-in gets its 5 emails and leaves everyone else's", async () => {
  const db = testDb();
  let sent = 0;
  for (let i = 0; i < 400; i++) if ((await hit(db, loginLimits("203.0.113.7", digest(i)), T0)).ok) sent++;
  assert.equal(sent, 5);
  assert.equal(count(db, "login:all|3600"), 5);
  assert.equal((await hit(db, loginLimits("198.51.100.1", digest(9999)), T0)).ok, true);
});

test("an address over its own limit can't run down someone else's email", async () => {
  const db = testDb();
  for (let i = 0; i < 5; i++) await hit(db, loginLimits("203.0.113.7", digest(i)), T0); // its allowance, on other emails
  const victim = digest(777);
  for (let i = 0; i < 20; i++) assert.equal((await hit(db, loginLimits("203.0.113.7", victim), T0)).ok, false);
  assert.equal(count(db, `login:email:${victim}|600`), 0);
  assert.equal((await hit(db, loginLimits("198.51.100.1", victim), T0)).ok, true); // the victim, from their own address
});

test("one email gets at most 3 sign-in emails in 10 minutes, whoever asks", async () => {
  const db = testDb();
  const verdicts = [];
  for (let i = 0; i < 5; i++) verdicts.push((await hit(db, loginLimits(`203.0.113.${i}`, digest(1)), T0)).ok);
  assert.deepEqual(verdicts, [true, true, true, false, false]);
  assert.equal(count(db, "login:all|3600"), 3); // the two refused ones sent nothing
});

test("all addresses together get 300 sign-in emails an hour", async () => {
  const db = testDb();
  let sent = 0;
  for (let i = 0; i < 320; i++) if ((await hit(db, loginLimits(`10.0.${i >> 8}.${i & 255}`, digest(i)), T0)).ok) sent++;
  assert.equal(sent, 300);
});

test("notify: garbage from one address is stopped before it touches a recipient's allowance", async () => {
  const db = testDb();
  const verdicts = [];
  for (let i = 0; i < 12; i++) verdicts.push((await hit(db, notifyCallerLimits("203.0.113.7"), T0)).ok);
  assert.equal(verdicts.filter(Boolean).length, 10);
  // Recipients and the overall count are only charged for a transfer that was found on chain.
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM rate_counters WHERE bucket LIKE 'notify:email:%' OR bucket LIKE 'notify:all%'").get().n, 0);
});

test("notify: a recipient gets at most 5 claim emails a day", async () => {
  const db = testDb();
  const verdicts = [];
  for (let i = 0; i < 7; i++) verdicts.push((await hit(db, notifyTransferLimits(digest(1)), T0)).ok);
  assert.deepEqual(verdicts, [true, true, true, true, true, false, false]);
  assert.equal(count(db, "notify:all|3600"), 5);
});

test("execute: an account gets 30 attempts an hour", async () => {
  const db = testDb();
  let passed = 0;
  for (let i = 0; i < 40; i++) if ((await hit(db, executeLimits("GACCOUNT"), T0)).ok) passed++;
  assert.equal(passed, 30);
  assert.equal((await hit(db, executeLimits("GOTHER"), T0)).ok, true);
});

test("execute: and 100 attempts a day", async () => {
  const db = testDb();
  let passed = 0;
  for (let h = 0; h < 4; h++) for (let i = 0; i < 25; i++) if ((await hit(db, executeLimits("GACCOUNT"), T0 + h * 3_600_000)).ok) passed++;
  assert.equal(passed, 100);
  assert.equal((await hit(db, executeLimits("GACCOUNT"), T0 + 4 * 3_600_000)).ok, false);
});

test("execute: attempts don't count as sponsored transactions; those have their own daily total", async () => {
  const db = testDb();
  for (let i = 0; i < 30; i++) await hit(db, executeLimits("GACCOUNT"), T0);
  assert.equal(count(db, "execute:all|86400"), 0);
  let paid = 0;
  for (let i = 0; i < 510; i++) if ((await hit(db, sponsoredLimits(), T0)).ok) paid++;
  assert.equal(paid, 500);
});

test("new accounts: an address over its 5 a day doesn't use up the day's total", async () => {
  const db = testDb();
  let opened = 0;
  for (let i = 0; i < 40; i++) if ((await hit(db, newAccountLimits("203.0.113.7", 30), T0)).ok) opened++;
  assert.equal(opened, 5);
  assert.equal(count(db, "create:all|86400"), 5);
  // Other addresses still can, up to the day's total.
  for (let i = 0; i < 40; i++) if ((await hit(db, newAccountLimits(`198.51.100.${i}`, 30), T0)).ok) opened++;
  assert.equal(opened, 30);
});

test("new accounts: a total of zero opens none", async () => {
  assert.equal((await hit(testDb(), newAccountLimits("203.0.113.7", 0), T0)).ok, false);
});

test("lookups: 60 per 10 minutes per address", async () => {
  const db = testDb();
  let passed = 0;
  for (let i = 0; i < 70; i++) if ((await hit(db, resolveLimits("203.0.113.7"), T0)).ok) passed++;
  assert.equal(passed, 60);
});
