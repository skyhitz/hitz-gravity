// What the email gateway will sign for an account and let the sponsor pay
// for: moving the account's own HITZ, XLM or USDC, and swapping its own funds
// in the Sovereign Vault. Nothing else.
//
// The sponsor pays for whatever `execute` sends, so it sends only what an
// email account needs. Signing any contract and any method would let every
// signed-in caller spend the sponsor's XLM on calls of their own choosing.
//
// Pure and erasable TypeScript, so tests/gateway-policy.test.mjs runs it in Node.

import { Address, Asset, scValToNative, xdr } from "@stellar/stellar-sdk";

/** The call is not one the gateway makes. Shown to the caller as it is. */
export class PolicyError extends Error {}

export interface GatewayPolicy {
  hitz: string;
  vault: string;
  /** Stellar asset contracts of native XLM and of USDC. */
  xlm: string;
  usdc: string;
}

export function gatewayPolicy(
  env: { HITZ_CONTRACT_ID: string; NETWORK_PASSPHRASE: string; USDC_ISSUER: string },
  vault: string
): GatewayPolicy {
  return {
    hitz: env.HITZ_CONTRACT_ID,
    vault,
    xlm: Asset.native().contractId(env.NETWORK_PASSPHRASE),
    usdc: new Asset("USDC", env.USDC_ISSUER).contractId(env.NETWORK_PASSPHRASE),
  };
}

export type AllowedCall =
  | { kind: "transfer"; token: string; to: string; amount: bigint }
  | { kind: "swap"; tokenIn: string; tokenOut: string; to: string; amountIn: bigint; minOut: bigint };

/**
 * The most the sponsor pays in resource fees for one call, in stroops
 * (0.5 XLM). The allowed calls cost a few hundredths of an XLM.
 */
export const MAX_RESOURCE_FEE = 5_000_000n;

/**
 * Inclusion bid per operation for the sponsor's fee bump, in stroops. The
 * network charges the going rate, up to this. A high bid buys nothing here
 * and ties up the sponsor: the whole bid has to be spendable for each call.
 */
export const FEE_BUMP_BASE_FEE = "10000";

function addressArg(value: xdr.ScVal, name: string): string {
  if (value.switch().name !== "scvAddress") throw new PolicyError(`argument ${name} must be an address`);
  return Address.fromScVal(value).toString();
}

function amountArg(value: xdr.ScVal, name: string): bigint {
  if (value.switch().name !== "scvI128") throw new PolicyError(`argument ${name} must be an i128 amount`);
  return BigInt(scValToNative(value) as bigint);
}

function expectArgs(args: xdr.ScVal[], count: number, method: string): void {
  if (args.length !== count) throw new PolicyError(`${method} takes ${count} arguments`);
}

/**
 * Check a requested call for the account `self`, and return what it does.
 * Throws PolicyError for anything but a transfer of the account's own HITZ,
 * XLM or USDC, or a vault swap of its own funds.
 */
export function checkCall(
  policy: GatewayPolicy,
  self: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): AllowedCall {
  const isToken = contractId === policy.hitz || contractId === policy.xlm || contractId === policy.usdc;
  if (!isToken && contractId !== policy.vault) {
    throw new PolicyError("this contract can't be called through the email gateway");
  }
  if (method !== (isToken ? "transfer" : "swap")) {
    throw new PolicyError(`method ${method} can't be called through the email gateway`);
  }

  if (isToken) {
    expectArgs(args, 3, "transfer");
    const from = addressArg(args[0], "from");
    const to = addressArg(args[1], "to");
    const amount = amountArg(args[2], "amount");
    if (from !== self) throw new PolicyError("an account can only send its own funds");
    if (amount <= 0n) throw new PolicyError("amount must be greater than zero");
    return { kind: "transfer", token: contractId, to, amount };
  }

  expectArgs(args, 6, "swap");
  const from = addressArg(args[0], "from");
  const to = addressArg(args[1], "to");
  const tokenIn = addressArg(args[2], "token_in");
  const tokenOut = addressArg(args[3], "token_out");
  const amountIn = amountArg(args[4], "amount_in");
  const minOut = amountArg(args[5], "min_out");
  if (from !== self) throw new PolicyError("an account can only swap its own funds");
  if (amountIn <= 0n) throw new PolicyError("amount_in must be greater than zero");
  if (minOut < 0n) throw new PolicyError("min_out amount can't be negative");
  return { kind: "swap", tokenIn, tokenOut, to, amountIn, minOut };
}

/**
 * True when simulation asks for no signature but the transaction's own
 * source account. A call that needs another address to sign would fail on
 * chain, and the sponsor would pay for the failure.
 */
export function onlySourceAuth(auth: xdr.SorobanAuthorizationEntry[]): boolean {
  return auth.every((entry) => entry.credentials().switch().name === "sorobanCredentialsSourceAccount");
}
