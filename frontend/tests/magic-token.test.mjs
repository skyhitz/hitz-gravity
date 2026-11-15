// Sign-in tokens share their KV namespace with other records (pending
// reparations, the arbitrage bot's state, alert markers). Redeeming a token
// reads its key and deletes it, so only a token may get that far: any other
// value must leave the namespace untouched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isMagicToken, newMagicToken, redeemMagicToken } from "../functions/_lib/magic-token.ts";
import { fakeKv } from "./helpers/kv.mjs";

/** A namespace holding one token and the other kinds of record the Worker keeps there. */
async function namespace() {
  const kv = fakeKv();
  const token = newMagicToken();
  await kv.put(token, JSON.stringify({ email: "alice@example.com", createdAt: 1_700_000_000_000 }));
  await kv.put("reparation:bob@example.com", JSON.stringify({ amount: "125", status: "pending", createdAt: 1 }));
  await kv.put("arb:paused", "3 runs in a row failed (since 2026-11-01T00:00:00.000Z)");
  await kv.put("arb:last", JSON.stringify({ action: "none", email: "not-a-login@example.com" }));
  await kv.put("alert:low_balance", "1700000000000");
  await kv.put(`notified:${"ab".repeat(32)}`, "cd".repeat(32));
  await kv.put("term-nonce:abc", "1");
  return { kv, token };
}

test("a new token is 64 lowercase hex characters, different every time", () => {
  const a = newMagicToken();
  const b = newMagicToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.ok(isMagicToken(a));
});

test("nothing but a token passes as one", () => {
  for (const value of [
    "",
    "reparation:bob@example.com",
    "arb:paused",
    "alert:low_balance",
    `notified:${"ab".repeat(32)}`,
    "AB".repeat(32),
    "ab".repeat(31),
    "ab".repeat(33),
    `${"ab".repeat(32)}\n`,
    ` ${"ab".repeat(32)}`,
    "zz".repeat(32),
    null,
    undefined,
    42,
    ["ab".repeat(32)],
  ]) {
    assert.equal(isMagicToken(value), false, JSON.stringify(value));
  }
});

test("a token is redeemed once", async () => {
  const { kv, token } = await namespace();
  assert.deepEqual(await redeemMagicToken(kv, token), { email: "alice@example.com", createdAt: 1_700_000_000_000 });
  assert.equal(await kv.get(token), null);
  assert.equal(await redeemMagicToken(kv, token), null);
});

test("an unknown token redeems nothing", async () => {
  const { kv } = await namespace();
  const before = kv.keys();
  assert.equal(await redeemMagicToken(kv, newMagicToken()), null);
  assert.deepEqual(kv.keys(), before);
});

test("other records in the namespace can't be read or removed by naming their key", async () => {
  const { kv } = await namespace();
  const before = kv.keys();
  for (const key of before.filter((k) => !isMagicToken(k))) {
    assert.equal(await redeemMagicToken(kv, key), null, key);
  }
  assert.deepEqual(kv.keys(), before);
  assert.equal(await kv.get("arb:paused"), "3 runs in a row failed (since 2026-11-01T00:00:00.000Z)");
  assert.ok(await kv.get("reparation:bob@example.com"));
});

test("a record under a token's key that isn't a sign-in record signs nobody in", async () => {
  const kv = fakeKv();
  const notJson = newMagicToken();
  const noEmail = newMagicToken();
  const emptyEmail = newMagicToken();
  await kv.put(notJson, "1");
  await kv.put(noEmail, JSON.stringify({ amount: "5" }));
  await kv.put(emptyEmail, JSON.stringify({ email: "" }));
  assert.equal(await redeemMagicToken(kv, notJson), null);
  assert.equal(await redeemMagicToken(kv, noEmail), null);
  assert.equal(await redeemMagicToken(kv, emptyEmail), null);
});
