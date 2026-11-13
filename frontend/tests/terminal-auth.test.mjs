// Terminal sign-in: wallet challenges, session tokens, API keys, and who a request is from.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, TransactionBuilder, Networks, Account, Operation } from "@stellar/stellar-sdk";
import {
  buildChallenge,
  CHALLENGE_TTL_S,
  COOKIE,
  identify,
  KEY_RE,
  newApiKey,
  sha256Hex,
  signersFromHorizon,
  signSession,
  verifyChallenge,
  verifySession,
} from "../functions/_lib/terminal/auth.ts";

const NET = Networks.PUBLIC;
const SECRET = "a".repeat(64);
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const user = Keypair.random();
const master = (kp = user) => ({ signers: [{ key: kp.publicKey(), weight: 1 }], threshold: 0 });
const sign = (xdr, ...kps) => {
  const tx = TransactionBuilder.fromXDR(xdr, NET);
  for (const kp of kps) tx.sign(kp);
  return tx.toXDR();
};

test("a challenge signed by the account's key signs it in, and can never be submitted", async () => {
  const { xdr, expires_at } = await buildChallenge(user.publicKey(), SECRET, T0, NET);
  assert.equal(expires_at, T0 + CHALLENGE_TTL_S * 1000);
  const tx = TransactionBuilder.fromXDR(xdr, NET);
  assert.equal(tx.sequence, "0");
  assert.equal(tx.source, user.publicKey());
  const nonce = await verifyChallenge(sign(xdr, user), user.publicKey(), SECRET, master(), T0 + 1000, NET);
  assert.match(nonce, /^[0-9a-f]{32}$/);
});

test("a challenge is refused unsigned, signed by someone else, expired, or issued elsewhere", async () => {
  const { xdr } = await buildChallenge(user.publicKey(), SECRET, T0, NET);
  const reject = (p, code) => assert.rejects(p, (e) => e.code === code);
  await reject(verifyChallenge(xdr, user.publicKey(), SECRET, master(), T0, NET), "not_signed");
  await reject(verifyChallenge(sign(xdr, Keypair.random()), user.publicKey(), SECRET, master(), T0, NET), "not_signed");
  await reject(verifyChallenge(sign(xdr, user), user.publicKey(), SECRET, master(), T0 + (CHALLENGE_TTL_S + 1) * 1000, NET), "challenge_expired");
  await reject(verifyChallenge(sign(xdr, user), user.publicKey(), "b".repeat(64), master(), T0, NET), "bad_challenge");
  await reject(verifyChallenge(sign(xdr, user), Keypair.random().publicKey(), SECRET, master(), T0, NET), "bad_challenge");
  // A look-alike built by someone else: same name, their own nonce.
  const fake = new TransactionBuilder(new Account(user.publicKey(), "-1"), { fee: "100", networkPassphrase: NET, timebounds: { minTime: T0 / 1000, maxTime: T0 / 1000 + CHALLENGE_TTL_S } })
    .addOperation(Operation.manageData({ name: "skyhitz.io terminal sign-in", value: Buffer.alloc(32, 7), source: user.publicKey() }))
    .build();
  fake.sign(user);
  await reject(verifyChallenge(fake.toXDR(), user.publicKey(), SECRET, master(), T0, NET), "bad_challenge");
});

test("multisig accounts need their medium threshold", async () => {
  const other = Keypair.random();
  const signers = { signers: [{ key: user.publicKey(), weight: 1 }, { key: other.publicKey(), weight: 1 }], threshold: 2 };
  const { xdr } = await buildChallenge(user.publicKey(), SECRET, T0, NET);
  await assert.rejects(verifyChallenge(sign(xdr, user), user.publicKey(), SECRET, signers, T0, NET), (e) => e.code === "not_signed");
  await verifyChallenge(sign(xdr, user, other), user.publicKey(), SECRET, signers, T0, NET);
  assert.deepEqual(signersFromHorizon(user.publicKey(), null), { signers: [{ key: user.publicKey(), weight: 1 }], threshold: 1 });
  assert.deepEqual(
    signersFromHorizon("G", { signers: [{ key: "GX", weight: 2, type: "ed25519_public_key" }, { key: "TX", weight: 5, type: "preauth_tx" }], thresholds: { med_threshold: 2 } }),
    { signers: [{ key: "GX", weight: 2 }], threshold: 2 },
  );
});

test("session tokens: signed, expiring, tamper-proof", async () => {
  const tok = await signSession({ account: user.publicKey(), exp: T0 / 1000 + 60 }, SECRET);
  assert.deepEqual(await verifySession(tok, SECRET, T0), { account: user.publicKey(), exp: T0 / 1000 + 60 });
  assert.equal(await verifySession(tok, SECRET, T0 + 61_000), null);
  assert.equal(await verifySession(tok, "c".repeat(64), T0), null);
  const [v, , s] = tok.split(".");
  const forged = Buffer.from(JSON.stringify({ a: Keypair.random().publicKey(), e: T0 / 1000 + 60 })).toString("base64url");
  assert.equal(await verifySession(`${v}.${forged}.${s}`, SECRET, T0), null);
});

test("API keys are random, shaped, and stored only as a digest", async () => {
  const a = newApiKey();
  const b = newApiKey();
  assert.notEqual(a.key, b.key);
  assert.match(a.key, KEY_RE);
  assert.equal(a.prefix, a.key.slice(0, 12));
  assert.match(await sha256Hex(a.key), /^[0-9a-f]{64}$/);
});

test("who is calling: a key first (unknown keys refused), then the terminal cookie, then email", async () => {
  const { key } = newApiKey();
  const hash = await sha256Hex(key);
  const deps = { secret: SECRET, nowMs: T0, keyAccount: async (h) => (h === hash ? "GKEY" : null), emailAccount: async (r) => (r.headers.get("X-Email") ? "GEMAIL" : null) };
  const req = (headers) => new Request("https://skyhitz.io/api/terminal/me", { headers });
  assert.deepEqual(await identify(req({ Authorization: `Bearer ${key}` }), deps), { account: "GKEY", via: "key", keyHash: hash });
  await assert.rejects(identify(req({ Authorization: `Bearer ${newApiKey().key}` }), deps), (e) => e.code === "invalid_key");
  await assert.rejects(identify(req({ Authorization: "Bearer nope" }), deps), (e) => e.code === "invalid_key");
  const tok = await signSession({ account: "GWALLET", exp: T0 / 1000 + 60 }, SECRET);
  assert.deepEqual(await identify(req({ Cookie: `x=1; ${COOKIE}=${tok}`, "X-Email": "1" }), deps), { account: "GWALLET", via: "wallet" });
  assert.deepEqual(await identify(req({ Cookie: `${COOKIE}=junk`, "X-Email": "1" }), deps), { account: "GEMAIL", via: "email" });
  assert.deepEqual(await identify(req({}), deps), { account: null, via: "none" });
});
