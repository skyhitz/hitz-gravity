// Reclaiming the sponsor's reserves from email accounts that were never
// used: which accounts qualify, and the one transaction that both revokes
// their sponsorship and pays what that frees to the admin.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { RECOVERY_RANGE, MAX_PER_TX, buildRecoveryTx, heldHitz, planRecovery, runRecovery, whyNotRecoverable } from "../functions/_lib/recovery.ts";
import { testDb } from "./helpers/d1.mjs";

const SPONSOR = Keypair.random();
const ADMIN = Keypair.random().publicKey();
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const HORIZON = "https://horizon.test";
const RPC = "https://rpc.test";
const cfg = {
  horizonUrl: HORIZON,
  rpcUrl: RPC,
  networkPassphrase: Networks.PUBLIC,
  sponsor: SPONSOR.publicKey(),
  fromLedger: RECOVERY_RANGE.fromLedger,
  toLedger: RECOVERY_RANGE.toLedger,
};

/** A Horizon record shaped like an unused account of the first account flow. */
function account({ ledger = RECOVERY_RANGE.fromLedger + 100, txs = 0, xlm = "1.0000000", sponsor = SPONSOR.publicKey(), usdc = "0.0000000", sponsoring = 0 } = {}) {
  return {
    account_id: Keypair.random().publicKey(),
    sequence: String((BigInt(ledger) << 32n) + BigInt(txs)),
    subentry_count: 1,
    num_sponsoring: sponsoring,
    num_sponsored: sponsor ? 3 : 1,
    ...(sponsor ? { sponsor } : {}),
    balances: [
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, balance: usdc, sponsor: SPONSOR.publicKey() },
      { asset_type: "native", balance: xlm },
    ],
  };
}

// ── Which accounts ───────────────────────────────────────────────────────────

test("the recovery range is fixed in the code, not taken from the job", () => {
  assert.deepEqual(RECOVERY_RANGE, { fromLedger: 64_105_992, toLedger: 64_138_234 });
});

test("an unused account from the range qualifies", () => {
  assert.equal(whyNotRecoverable(account(), cfg), null);
  assert.equal(whyNotRecoverable(account({ ledger: RECOVERY_RANGE.fromLedger }), cfg), null);
  assert.equal(whyNotRecoverable(account({ ledger: RECOVERY_RANGE.toLedger }), cfg), null);
});

test("an account whose starting balance is gone does not: it can't pay its own reserve", () => {
  assert.match(whyNotRecoverable(account({ xlm: "0.0000000", txs: 1 }), cfg), /sent|1 XLM/);
});

test("an account created before or after the range is left alone", () => {
  assert.match(whyNotRecoverable(account({ ledger: RECOVERY_RANGE.fromLedger - 1 }), cfg), /range/);
  assert.match(whyNotRecoverable(account({ ledger: RECOVERY_RANGE.toLedger + 1 }), cfg), /range/);
});

test("an account that has sent a transaction is left alone", () => {
  assert.match(whyNotRecoverable(account({ txs: 1 }), cfg), /sent/);
});

test("an account holding anything but exactly its 1 XLM starting balance is left alone", () => {
  assert.match(whyNotRecoverable(account({ xlm: "5.5000000" }), cfg), /1 XLM/);
  assert.match(whyNotRecoverable(account({ xlm: "1.5000000" }), cfg), /1 XLM/);
  assert.match(whyNotRecoverable(account({ xlm: "0.9999999" }), cfg), /1 XLM/);
});

test("an account holding USDC is left alone", () => {
  assert.match(whyNotRecoverable(account({ usdc: "0.0000001" }), cfg), /asset/);
});

test("an account the sponsor does not sponsor is left alone", () => {
  assert.match(whyNotRecoverable(account({ sponsor: Keypair.random().publicKey() }), cfg), /sponsor/);
  assert.match(whyNotRecoverable(account({ sponsor: null }), cfg), /sponsor/);
});

test("an account that sponsors others is left alone", () => {
  assert.match(whyNotRecoverable(account({ sponsoring: 1 }), cfg), /sponsor/);
});

test("accounts that ever held HITZ are found in the holder index", async () => {
  const db = testDb();
  const [a, b, c] = [1, 2, 3].map(() => Keypair.random().publicKey());
  db.raw.prepare("INSERT INTO holders (address, source, added_at) VALUES (?, 'events', '2026-08-25T00:00:00Z')").run(b);
  assert.deepEqual([...(await heldHitz(db, [a, b, c]))], [b]);
});

test("the holder lookup handles more addresses than one statement can bind", async () => {
  const db = testDb();
  const many = Array.from({ length: 205 }, () => Keypair.random().publicKey());
  for (const addr of [many[0], many[99], many[204]]) {
    db.raw.prepare("INSERT INTO holders (address, source, added_at) VALUES (?, 'events', '2026-08-25T00:00:00Z')").run(addr);
  }
  assert.deepEqual([...(await heldHitz(db, many))].sort(), [many[0], many[99], many[204]].sort());
});

// ── The transaction ──────────────────────────────────────────────────────────

const sponsorAccount = () => new Account(SPONSOR.publicKey(), "267516745315518414");

test("one transaction revokes each account's sponsorship, then pays the admin what that frees", () => {
  const accounts = [1, 2, 3].map(() => Keypair.random().publicKey());
  const tx = buildRecoveryTx({ sponsor: sponsorAccount(), accounts, admin: ADMIN, networkPassphrase: Networks.PUBLIC });
  assert.equal(tx.source, SPONSOR.publicKey());
  assert.equal(tx.operations.length, 4);
  tx.operations.slice(0, 3).forEach((op, i) => {
    assert.equal(op.type, "revokeAccountSponsorship");
    assert.equal(op.account, accounts[i]);
    assert.equal(op.source, undefined); // the sponsor itself
  });
  const pay = tx.operations[3];
  assert.equal(pay.type, "payment");
  assert.equal(pay.destination, ADMIN);
  assert.equal(pay.asset.isNative(), true);
  assert.equal(pay.amount, "3.0000000"); // 1 XLM of reserve per account
  assert.equal(tx.signatures.length, 0);
});

test("a transaction holds at most 99 accounts, so the payment fits in the same one", () => {
  assert.equal(MAX_PER_TX, 99);
  const accounts = Array.from({ length: 100 }, () => Keypair.random().publicKey());
  assert.throws(() => buildRecoveryTx({ sponsor: sponsorAccount(), accounts, admin: ADMIN, networkPassphrase: Networks.PUBLIC }), /99/);
  assert.equal(buildRecoveryTx({ sponsor: sponsorAccount(), accounts: accounts.slice(0, 99), admin: ADMIN, networkPassphrase: Networks.PUBLIC }).operations.length, 100);
});

test("an empty or repeated account list is refused", () => {
  const a = Keypair.random().publicKey();
  assert.throws(() => buildRecoveryTx({ sponsor: sponsorAccount(), accounts: [], admin: ADMIN, networkPassphrase: Networks.PUBLIC }), /no accounts/);
  assert.throws(() => buildRecoveryTx({ sponsor: sponsorAccount(), accounts: [a, a], admin: ADMIN, networkPassphrase: Networks.PUBLIC }), /twice/);
});

// ── Planning and running, against a stand-in for Horizon and the RPC ─────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serves `records` as Horizon's sponsored-accounts listing and records what the RPC is sent. */
function network(records, { outcome = "SUCCESS", sendStatus = "PENDING" } = {}) {
  const sent = [];
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin === HORIZON && url.pathname === "/accounts" && url.searchParams.get("sponsor") === SPONSOR.publicKey()) {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const page = records.slice(cursor, cursor + 2); // tiny pages, to exercise paging
      return json({ _links: { next: { href: `${HORIZON}/accounts?sponsor=${SPONSOR.publicKey()}&cursor=${cursor + page.length}` } }, _embedded: { records: page } });
    }
    if (url.origin === HORIZON && url.pathname === `/accounts/${SPONSOR.publicKey()}`) {
      return json({ account_id: SPONSOR.publicKey(), sequence: "267516745315518414", subentry_count: 0, balances: [{ asset_type: "native", balance: "1739.2783222" }] });
    }
    if (url.origin === RPC) {
      const call = JSON.parse(init.body);
      if (call.method === "sendTransaction") {
        const tx = TransactionBuilder.fromXDR(call.params.transaction, Networks.PUBLIC);
        sent.push(tx);
        return json({ jsonrpc: "2.0", id: 1, result: { status: sendStatus, hash: tx.hash().toString("hex") } });
      }
      if (call.method === "getTransaction") return json({ jsonrpc: "2.0", id: 1, result: { status: outcome, ledger: 65_400_000 } });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return sent;
}

test("the plan lists the qualifying accounts and says why the others were skipped", async () => {
  const db = testDb();
  const good = [account(), account(), account()];
  const holder = account();
  db.raw.prepare("INSERT INTO holders (address, source, added_at) VALUES (?, 'events', '2026-08-25T00:00:00Z')").run(holder.account_id);
  network([good[0], account({ xlm: "0.0000000", txs: 1 }), good[1], holder, account({ ledger: 62_318_507, xlm: "5.5000000" }), good[2]]);

  const plan = await planRecovery(cfg, db);
  assert.equal(plan.sponsored, 6);
  assert.deepEqual(plan.eligible, good.map((a) => a.account_id).sort());
  assert.equal(plan.recoverableXlm, "3.0000000");
  assert.equal(Object.values(plan.skipped).reduce((a, b) => a + b, 0), 3);
  assert.equal(plan.skipped["has held HITZ"], 1);
});

test("a run revokes up to the limit in one signed transaction and reports what was paid", async () => {
  const db = testDb();
  const good = [account(), account(), account()];
  const sent = network(good);

  const result = await runRecovery(cfg, db, { signer: SPONSOR, admin: ADMIN, limit: 2 });

  assert.equal(sent.length, 1);
  const tx = sent[0];
  assert.equal(tx.operations.length, 3);
  assert.deepEqual(tx.operations.slice(0, 2).map((op) => op.account), good.map((a) => a.account_id).sort().slice(0, 2));
  assert.equal(tx.operations[2].destination, ADMIN);
  assert.equal(tx.operations[2].amount, "2.0000000");
  assert.equal(SPONSOR.verify(tx.hash(), tx.signatures[0].signature()), true);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.revoked.length, 2);
  assert.equal(result.paidXlm, "2.0000000");
  assert.equal(result.remaining, 1);
  assert.equal(result.hash, tx.hash().toString("hex"));
});

test("a failed transaction reports nothing as recovered", async () => {
  const sent = network([account()], { outcome: "FAILED" });
  const result = await runRecovery(cfg, testDb(), { signer: SPONSOR, admin: ADMIN, limit: 1 });
  assert.equal(sent.length, 1);
  assert.equal(result.status, "FAILED");
  assert.deepEqual(result.revoked, []);
  assert.equal(result.paidXlm, "0.0000000");
});

test("a rejected submission reports nothing as recovered", async () => {
  network([account()], { sendStatus: "ERROR" });
  const result = await runRecovery(cfg, testDb(), { signer: SPONSOR, admin: ADMIN, limit: 1 });
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.revoked, []);
});

test("with nothing left to recover, nothing is sent", async () => {
  const sent = network([account({ xlm: "0.0000000", txs: 1 })]);
  const result = await runRecovery(cfg, testDb(), { signer: SPONSOR, admin: ADMIN, limit: 50 });
  assert.equal(sent.length, 0);
  assert.equal(result.status, "NOTHING_TO_DO");
});

test("a run refuses a key that is not the sponsor's", async () => {
  network([account()]);
  await assert.rejects(runRecovery(cfg, testDb(), { signer: Keypair.random(), admin: ADMIN, limit: 1 }), /sponsor/);
});

test("a run takes at most 99 accounts however many are asked for", async () => {
  const sent = network(Array.from({ length: 101 }, () => account()));
  const result = await runRecovery(cfg, testDb(), { signer: SPONSOR, admin: ADMIN, limit: 500 });
  assert.equal(sent[0].operations.length, 100);
  assert.equal(result.revoked.length, 99);
  assert.equal(result.remaining, 2);
});
