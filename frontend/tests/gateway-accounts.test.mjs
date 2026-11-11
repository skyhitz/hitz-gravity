// The record of every reserve the sponsor locks for an email account.
//
// A reserve can only be reclaimed with the account's key, and the key can
// only be derived again from the email's digest. So every account and
// trustline the sponsor pays for is written down first, with that digest: an
// account nobody recorded keeps the sponsor's reserve for good.

import assert from "node:assert/strict";
import { test } from "node:test";
import { newAccountsSince, recordSponsored } from "../functions/_lib/gateway-accounts.ts";
import { testDb } from "./helpers/d1.mjs";

const A = "GA27EFZ6S5PZSTKBWTXGGKZT4R6VYJCKHHGSFWP3ZC5HQGZ5SVF4YDWZ";
const B = "GD3J6MN2LCQ2K4NFOQ4Q3F7Y5D2ZP4JVI6NGOTTQ5WZ3YV7Z2Y6M4XKQ";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const at = (iso) => new Date(iso);
const rows = (db) => db.raw.prepare("SELECT address, email_sha256, reason, created_at FROM gateway_accounts ORDER BY address").all().map((r) => ({ ...r }));

test("an account the gateway creates is recorded with the digest its key derives from", async () => {
  const db = testDb();
  await recordSponsored(db, { address: A, emailDigest: DIGEST_A, reason: "execute" }, at("2026-11-11T10:00:00Z"));
  assert.deepEqual(rows(db), [{ address: A, email_sha256: DIGEST_A, reason: "execute", created_at: "2026-11-11T10:00:00.000Z" }]);
});

test("a trustline sponsored for an account the gateway did not create is recorded too", async () => {
  // An account opened by an incoming XLM transfer, or one from before the record existed.
  const db = testDb();
  await recordSponsored(db, { address: B, emailDigest: DIGEST_B, reason: "trustline" }, at("2026-11-11T10:00:00Z"));
  assert.deepEqual(rows(db).map((r) => [r.address, r.email_sha256, r.reason]), [[B, DIGEST_B, "trustline"]]);
});

test("the first record of an account stands: a later trustline doesn't rewrite it", async () => {
  const db = testDb();
  await recordSponsored(db, { address: A, emailDigest: DIGEST_A, reason: "execute" }, at("2026-11-11T10:00:00Z"));
  await recordSponsored(db, { address: A, emailDigest: DIGEST_A, reason: "trustline" }, at("2026-11-12T10:00:00Z"));
  assert.deepEqual(rows(db).map((r) => [r.reason, r.created_at]), [["execute", "2026-11-11T10:00:00.000Z"]]);
});

test("anything but a 64-digit hex digest is refused: the key could not be derived from it", async () => {
  const db = testDb();
  for (const emailDigest of ["", "someone@example.com", "A".repeat(64), "a".repeat(63)]) {
    await assert.rejects(recordSponsored(db, { address: A, emailDigest, reason: "execute" }), /digest/);
  }
  assert.deepEqual(rows(db), []);
});

test("new accounts are counted from a point in time, without the trustline-only records", async () => {
  const db = testDb();
  await recordSponsored(db, { address: A, emailDigest: DIGEST_A, reason: "execute" }, at("2026-11-10T09:00:00Z"));
  await recordSponsored(db, { address: B, emailDigest: DIGEST_B, reason: "reparation" }, at("2026-11-11T09:00:00Z"));
  await recordSponsored(db, { address: "GTRUSTLINEONLY", emailDigest: "c".repeat(64), reason: "trustline" }, at("2026-11-11T09:30:00Z"));
  assert.equal(await newAccountsSince(db, at("2026-11-10T00:00:00Z")), 2);
  assert.equal(await newAccountsSince(db, at("2026-11-11T00:00:00Z")), 1);
  assert.equal(await newAccountsSince(db, at("2026-11-12T00:00:00Z")), 0);
});
