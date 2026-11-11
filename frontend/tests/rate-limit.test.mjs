// Fixed-window rate limits backed by D1, for everything a public endpoint
// can be made to do: login, notify, resolve, execute, new accounts.
//
// A hit is checked against groups of limits, in order: the caller's own
// first, the ones everybody shares last.

import assert from "node:assert/strict";
import { test } from "node:test";
import { hit, pruneRateCounters } from "../functions/_lib/rate-limit.ts";
import { testDb } from "./helpers/d1.mjs";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0); // on a window boundary for every window used below
const lim = (bucket, limit, windowSeconds) => ({ bucket, limit, windowSeconds });
const count = (db, bucket) => db.raw.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM rate_counters WHERE bucket LIKE ?").get(`${bucket}|%`).n;

test("hits up to the limit pass", async () => {
  const db = testDb();
  for (let i = 0; i < 3; i++) assert.equal((await hit(db, [[lim("login:ip:1.2.3.4", 3, 600)]], T0 + i * 1000)).ok, true);
});

test("the hit after the limit is refused, with the time left in the window", async () => {
  const db = testDb();
  for (let i = 0; i < 3; i++) await hit(db, [[lim("a", 3, 600)]], T0);
  assert.deepEqual(await hit(db, [[lim("a", 3, 600)]], T0 + 100_000), { ok: false, exceeded: "a", retryAfter: 500 });
});

test("the next window starts from zero", async () => {
  const db = testDb();
  for (let i = 0; i < 4; i++) await hit(db, [[lim("a", 3, 600)]], T0);
  assert.equal((await hit(db, [[lim("a", 3, 600)]], T0 + 600_000)).ok, true);
});

test("buckets are counted separately", async () => {
  const db = testDb();
  await hit(db, [[lim("login:ip:1.1.1.1", 1, 600)]], T0);
  assert.equal((await hit(db, [[lim("login:ip:2.2.2.2", 1, 600)]], T0)).ok, true);
  assert.equal((await hit(db, [[lim("login:ip:1.1.1.1", 1, 600)]], T0)).ok, false);
});

test("the limits of one group are counted together, and the one that is exceeded is named", async () => {
  const db = testDb();
  const group = [[lim("per-ip", 10, 600), lim("per-email", 1, 600)]];
  assert.equal((await hit(db, group, T0)).ok, true);
  const second = await hit(db, group, T0);
  assert.equal(second.ok, false);
  assert.equal(second.exceeded, "per-email");
  assert.equal(count(db, "per-ip"), 2);
});

test("a hit refused by the caller's own limit is not counted against the limit everyone shares", async () => {
  // Otherwise one caller could use up everybody's allowance with requests that were all refused.
  const db = testDb();
  const groups = [[lim("login:ip:1.1.1.1", 2, 600)], [lim("login:all", 100, 3600)]];
  const verdicts = [];
  for (let i = 0; i < 50; i++) verdicts.push((await hit(db, groups, T0)).ok);
  assert.deepEqual(verdicts.slice(0, 3), [true, true, false]);
  assert.equal(count(db, "login:all"), 2);
  assert.equal(count(db, "login:ip:1.1.1.1"), 50); // the caller's own counter keeps counting
});

test("the groups before the one that refuses were counted, the ones after it were not", async () => {
  const db = testDb();
  const groups = [[lim("ip", 10, 600)], [lim("email", 1, 600)], [lim("all", 100, 3600)]];
  assert.equal((await hit(db, groups, T0)).ok, true);
  assert.deepEqual(await hit(db, groups, T0), { ok: false, exceeded: "email", retryAfter: 600 });
  assert.deepEqual([count(db, "ip"), count(db, "email"), count(db, "all")], [2, 2, 1]);
});

test("one bucket can carry a short and a long window", async () => {
  const db = testDb();
  const limits = [[lim("login:email:x", 2, 600), lim("login:email:x", 3, 86_400)]];
  assert.equal((await hit(db, limits, T0)).ok, true);
  assert.equal((await hit(db, limits, T0)).ok, true);
  assert.equal((await hit(db, limits, T0)).ok, false); // short window: third in 10 minutes
  // An hour later the short window is fresh, but this is the fourth of the day.
  const later = await hit(db, limits, T0 + 3_600_000);
  assert.equal(later.ok, false);
  assert.equal(later.retryAfter, 86_400 - 3600 - 12 * 3600);
});

test("no limits means no verdict to give", async () => {
  assert.deepEqual(await hit(testDb(), [], T0), { ok: true });
  assert.deepEqual(await hit(testDb(), [[]], T0), { ok: true });
});

test("windows that ended over two days ago are pruned", async () => {
  const db = testDb();
  await hit(db, [[lim("old", 5, 600)]], T0);
  await hit(db, [[lim("new", 5, 600)]], T0 + 3 * 86_400_000);
  await pruneRateCounters(db, T0 + 3 * 86_400_000);
  assert.deepEqual(db.raw.prepare("SELECT bucket FROM rate_counters").all().map((r) => r.bucket.split("|")[0]), ["new"]);
});

// ── Who counts as one caller ─────────────────────────────────────────────────

import { callerBucket } from "../functions/_lib/rate-limit.ts";

test("an IPv4 address is its own caller", () => {
  assert.equal(callerBucket("203.0.113.7"), "203.0.113.7");
});

test("every address in an IPv6 /64 is the same caller", () => {
  // One home or server gets a whole /64, so the interface half is free to rotate.
  assert.equal(callerBucket("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::/64");
  assert.equal(callerBucket("2001:db8:85a3:8d3:ffff:ffff:ffff:ffff"), "2001:db8:85a3:8d3::/64");
  assert.notEqual(callerBucket("2001:db8:85a3:8d4::1"), callerBucket("2001:db8:85a3:8d3::1"));
});

test("compressed and padded IPv6 forms of one network agree", () => {
  assert.equal(callerBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(callerBucket("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8:0:0::/64");
  assert.equal(callerBucket("2001:DB8:0:0:8:800:200C:417A"), "2001:db8:0:0::/64");
  assert.equal(callerBucket("::1"), "0:0:0:0::/64");
});

test("anything unrecognized is one shared caller", () => {
  assert.equal(callerBucket(""), "unknown");
  assert.equal(callerBucket("not an address"), "unknown");
  assert.equal(callerBucket("unknown"), "unknown");
});
