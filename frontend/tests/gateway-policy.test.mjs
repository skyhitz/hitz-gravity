// What an email account may ask the gateway to sign and the sponsor to pay
// for: transfers of its own HITZ, XLM or USDC and vault swaps of its own
// funds. Any other contract, method or source of funds is refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Address, Asset, Keypair, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { PolicyError, checkCall, gatewayPolicy, onlySourceAuth } from "../functions/_lib/gateway-policy.ts";

const HITZ = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const VAULT = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";
const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const policy = gatewayPolicy(
  {
    HITZ_CONTRACT_ID: HITZ,
    NETWORK_PASSPHRASE: Networks.PUBLIC,
    USDC_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  VAULT
);

const self = Keypair.random().publicKey();
const other = Keypair.random().publicKey();
const addr = (a) => Address.fromString(a).toScVal();
const i128 = (v) => nativeToScVal(v, { type: "i128" });
const transfer = (from, to, amount) => [addr(from), addr(to), i128(amount)];
const swap = (from, to, tokenIn, tokenOut, amountIn, minOut) => [addr(from), addr(to), addr(tokenIn), addr(tokenOut), i128(amountIn), i128(minOut)];
const refuses = (fn, pattern) => assert.throws(fn, (err) => err instanceof PolicyError && pattern.test(err.message));

test("the policy names mainnet's XLM and USDC asset contracts", () => {
  assert.equal(policy.xlm, XLM);
  assert.equal(policy.usdc, USDC);
});

for (const [name, token] of [["HITZ", HITZ], ["XLM", XLM], ["USDC", USDC]]) {
  test(`an account may transfer its own ${name}`, () => {
    assert.deepEqual(checkCall(policy, self, token, "transfer", transfer(self, other, 5n)), {
      kind: "transfer",
      token,
      to: other,
      amount: 5n,
    });
  });
}

test("an account may swap its own funds in the vault", () => {
  assert.deepEqual(checkCall(policy, self, VAULT, "swap", swap(self, self, HITZ, USDC, 1000n, 3n)), {
    kind: "swap",
    tokenIn: HITZ,
    tokenOut: USDC,
    to: self,
    amountIn: 1000n,
    minOut: 3n,
  });
});

test("a swap may pay out to another address", () => {
  assert.equal(checkCall(policy, self, VAULT, "swap", swap(self, other, XLM, HITZ, 10n, 1n)).to, other);
});

test("a transfer may go to a contract address", () => {
  assert.equal(checkCall(policy, self, HITZ, "transfer", transfer(self, VAULT, 1n)).to, VAULT);
});

test("any other contract is refused", () => {
  const stranger = new Asset("EVIL", other).contractId(Networks.PUBLIC);
  refuses(() => checkCall(policy, self, stranger, "transfer", transfer(self, other, 5n)), /contract/);
});

for (const [contract, method] of [[HITZ, "approve"], [HITZ, "burn"], [HITZ, "mint"], [HITZ, "transfer_from"], [XLM, "approve"], [VAULT, "deposit"], [VAULT, "transfer"], [HITZ, "swap"]]) {
  test(`${method} on ${contract.slice(0, 4)}… is refused`, () => {
    refuses(() => checkCall(policy, self, contract, method, transfer(self, other, 5n)), /method/);
  });
}

test("a transfer that names someone else as the sender is refused", () => {
  refuses(() => checkCall(policy, self, HITZ, "transfer", transfer(other, self, 5n)), /own/);
});

test("a swap that spends someone else's funds is refused", () => {
  refuses(() => checkCall(policy, self, VAULT, "swap", swap(other, self, HITZ, XLM, 5n, 1n)), /own/);
});

test("the wrong number of arguments is refused", () => {
  refuses(() => checkCall(policy, self, HITZ, "transfer", [addr(self), addr(other)]), /argument/);
  refuses(() => checkCall(policy, self, VAULT, "swap", transfer(self, other, 5n)), /argument/);
});

test("arguments of the wrong type are refused", () => {
  refuses(() => checkCall(policy, self, HITZ, "transfer", [i128(1n), addr(other), i128(5n)]), /argument/);
  refuses(() => checkCall(policy, self, HITZ, "transfer", [addr(self), addr(other), nativeToScVal("5")]), /argument/);
  refuses(() => checkCall(policy, self, VAULT, "swap", [addr(self), addr(self), i128(1n), addr(XLM), i128(5n), i128(1n)]), /argument/);
});

test("amounts must be positive", () => {
  refuses(() => checkCall(policy, self, HITZ, "transfer", transfer(self, other, 0n)), /amount/);
  refuses(() => checkCall(policy, self, HITZ, "transfer", transfer(self, other, -5n)), /amount/);
  refuses(() => checkCall(policy, self, VAULT, "swap", swap(self, self, HITZ, XLM, 0n, 0n)), /amount/);
  refuses(() => checkCall(policy, self, VAULT, "swap", swap(self, self, HITZ, XLM, 5n, -1n)), /amount/);
});

// ── Authorization entries from simulation ────────────────────────────────────

function authEntry(credentials) {
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(HITZ).toScAddress(),
          functionName: "transfer",
          args: transfer(self, other, 5n),
        })
      ),
      subInvocations: [],
    }),
  });
}
const sourceAuth = authEntry(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
const strangerAuth = authEntry(
  xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(other).toScAddress(),
      nonce: xdr.Int64.fromString("7"),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    })
  )
);

test("a call authorized only by its own account passes", () => {
  assert.equal(onlySourceAuth([sourceAuth]), true);
  assert.equal(onlySourceAuth([]), true);
});

test("a call that needs another address's signature does not", () => {
  assert.equal(onlySourceAuth([strangerAuth]), false);
  assert.equal(onlySourceAuth([sourceAuth, strangerAuth]), false);
});
