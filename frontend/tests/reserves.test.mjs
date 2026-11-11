// How much XLM an account can actually spend. A sponsor's total balance is
// almost all locked in the reserves it sponsors, so alerts and floors that
// read the total would never see it run out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeFunds } from "../functions/_lib/reserves.ts";

const native = (balance, extra = {}) => ({ asset_type: "native", balance, ...extra });

test("XLM locked in sponsored reserves is not spendable (a sponsor holding 3,475 reserves)", () => {
  const funds = nativeFunds({ balances: [native("1739.2783222")], subentry_count: 0, num_sponsoring: 3475, num_sponsored: 0 });
  assert.equal(funds.total, 17392783222n);
  assert.equal(funds.locked, 17385000000n); // (2 + 3475) × 0.5 XLM
  assert.equal(funds.spendable, 7783222n); // 0.7783222 XLM
});

test("an account whose reserves are all sponsored can spend its whole balance", () => {
  const funds = nativeFunds({ balances: [native("1.0000000")], subentry_count: 1, num_sponsoring: 0, num_sponsored: 3 });
  assert.equal(funds.locked, 0n);
  assert.equal(funds.spendable, 10000000n);
});

test("an account paying its own reserve keeps it locked", () => {
  const funds = nativeFunds({ balances: [native("1.0000000")], subentry_count: 1, num_sponsoring: 0, num_sponsored: 1 });
  assert.equal(funds.locked, 10000000n);
  assert.equal(funds.spendable, 0n);
});

test("XLM offered for sale is not spendable", () => {
  const funds = nativeFunds({ balances: [native("10.0000000", { selling_liabilities: "2.5000000" })], subentry_count: 0 });
  assert.equal(funds.spendable, 65000000n); // 10 − 1 reserve − 2.5
});

test("spendable never goes below zero", () => {
  assert.equal(nativeFunds({ balances: [native("0.4000000")], subentry_count: 3 }).spendable, 0n);
});

test("an account record without a native line has nothing", () => {
  assert.deepEqual(nativeFunds({ balances: [], subentry_count: 0 }), { total: 0n, locked: 10000000n, spendable: 0n });
});
