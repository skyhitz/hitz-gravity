// Email accounts are derived from MASTER_SECRET and the email. The gateway
// records the email's digest for every account it creates, so the account can
// be found again (and its sponsored reserve reclaimed) without storing the
// address itself.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deriveKeypair, deriveKeypairFromDigest, emailDigest } from "../functions/_lib/derive.ts";

const MASTER = "5a".repeat(32);

test("the digest is the SHA-256 of the normalized email", async () => {
  const expected = createHash("sha256").update("alice@example.com").digest("hex");
  assert.equal(await emailDigest("  Alice@Example.COM "), expected);
});

test("the digest re-derives the same key as the email", async () => {
  const fromEmail = await deriveKeypair("alice@example.com", MASTER);
  const fromDigest = await deriveKeypairFromDigest(await emailDigest("alice@example.com"), MASTER);
  assert.equal(fromDigest.publicKey(), fromEmail.publicKey());
  assert.equal(fromDigest.secret(), fromEmail.secret());
});

test("different emails give different accounts", async () => {
  const a = await deriveKeypairFromDigest(await emailDigest("a@example.com"), MASTER);
  const b = await deriveKeypairFromDigest(await emailDigest("b@example.com"), MASTER);
  assert.notEqual(a.publicKey(), b.publicKey());
});

test("a malformed digest is refused", async () => {
  await assert.rejects(deriveKeypairFromDigest("abc123", MASTER), /digest/);
  await assert.rejects(deriveKeypairFromDigest("zz".repeat(32), MASTER), /digest/);
});
