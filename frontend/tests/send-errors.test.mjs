// What the Send card tells a sender when the recipient can't take the asset.
// The gateway creates nothing for a recipient, so the asset contracts' own
// rules decide, and their errors don't say it in words.
//
// The two errors below are what mainnet (protocol 29) returns for a transfer
// to an address with no account, checked by simulation on Nov 11, 2026:
//   XLM under 1    Error(Contract, #14): a transfer of 1 XLM or more creates
//                  the recipient's account, a smaller one can't
//   USDC           Error(Contract, #13): no trustline, with or without an account

import assert from "node:assert/strict";
import { test } from "node:test";
import { recipientCantReceive } from "../app/lib/send-errors.ts";

const BELOW_NEW_ACCOUNT_MINIMUM =
  "simulation failed: HostError: Error(Contract, #14)\n\nEvent log (newest first):\n" +
  '   0: [Diagnostic Event] contract:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA, topics:[error, Error(Contract, #14)], data:["transfer amount is below minimum balance for new account", 9999999, 10000000]';
const TRUSTLINE_MISSING =
  "simulation failed: HostError: Error(Contract, #13)\n\nEvent log (newest first):\n" +
  '   0: [Diagnostic Event] contract:CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GBER7ROBYH5NFFKXCDGTSMUKTDQ4U3MEUTUCPJRZZY6EYZVEFDBVNJNB]';

test("under 1 XLM to an address with no account: say that 1 XLM or more opens it", () => {
  const message = recipientCantReceive(BELOW_NEW_ACCOUNT_MINIMUM, "XLM");
  assert.match(message, /no Stellar account yet/);
  assert.match(message, /at least 1 XLM/);
  assert.doesNotMatch(message, /trustline/);
});

test("USDC to a recipient without the trustline says so", () => {
  const message = recipientCantReceive(TRUSTLINE_MISSING, "USDC");
  assert.match(message, /can't receive USDC/);
  assert.match(message, /no USDC trustline/);
});

test("a trustline error worded differently is recognized too", () => {
  assert.match(recipientCantReceive("op_no_trust: destination has no trustline", "USDC"), /no USDC trustline/);
});

test("both point the sender to HITZ, which needs neither an account nor a trustline", () => {
  for (const error of [BELOW_NEW_ACCOUNT_MINIMUM, TRUSTLINE_MISSING]) {
    assert.match(recipientCantReceive(error, "USDC"), /HITZ/);
  }
});

test("any other failure is not about the recipient", () => {
  // #10 is the sender's own balance; #130 and #140 only contain the digits.
  for (const error of ["simulation failed: HostError: Error(Contract, #10)", "Error(Contract, #130)", "Error(Contract, #140)", "User declined", "", undefined]) {
    assert.equal(recipientCantReceive(error, "XLM"), null);
  }
});
