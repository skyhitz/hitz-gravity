// POST /api/gateway/execute
//
//   body: { contractId, method, argsXdr: string[] }  (argsXdr[] are base64 ScVal)
//   cookie: hitz_session JWT
//   → { hash } on success
//
// The custodial-action endpoint. For an email-authenticated user:
//   1. Authenticate via session cookie.
//   2. Derive the user's keypair from session.email (never trust the
//      client-supplied publicKey — derive fresh and use that).
//   3. Check the call against the gateway policy: a transfer of the
//      account's own HITZ, XLM or USDC, or a vault swap of its own funds.
//      Anything else is refused (_lib/gateway-policy.ts).
//   4. Limit the account's attempts, then run it with the derived key as
//      source, wrapped in a fee bump signed by the sponsor (_lib/stellar.ts).
//      The day's total of sponsored transactions is charged there, once the
//      call has simulated successfully.
//
// No per-tx confirmation UI — that's the whole point of the gas station.
// Wallet users hit their own sign flow client-side; they never touch this.

import * as StellarSdk from "@stellar/stellar-sdk";
import { deriveKeypair } from "../../_lib/derive";
import { PolicyError, checkCall, gatewayPolicy, type AllowedCall } from "../../_lib/gateway-policy";
import { badRequest, clientIp, json, readJson, serverError, tooManyRequests, unauthorized } from "../../_lib/http";
import { executeLimits } from "../../_lib/limits";
import { hit } from "../../_lib/rate-limit";
import { readSession } from "../../_lib/session";
import { GatewayError, runSponsoredContractCall } from "../../_lib/stellar";
import { VAULT_ID } from "../../_lib/vault-api";
import type { Env } from "../../_lib/types";

interface Body {
  contractId?: string;
  method?: string;
  argsXdr?: string[];
}

/** No call the gateway makes takes more arguments than a swap, or bigger ones than an address or an amount. */
const MAX_ARGS = 6;
const MAX_ARG_LENGTH = 512;

export async function POST(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return unauthorized("no session");

  const body = await readJson<Body>(request);
  if (!body) return badRequest("invalid body");
  if (!body.contractId || typeof body.contractId !== "string") {
    return badRequest("contractId required");
  }
  if (!body.method || typeof body.method !== "string") {
    return badRequest("method required");
  }
  if (
    !Array.isArray(body.argsXdr) ||
    body.argsXdr.length > MAX_ARGS ||
    !body.argsXdr.every((a) => typeof a === "string" && a.length <= MAX_ARG_LENGTH)
  ) {
    return badRequest("argsXdr must be string[]");
  }

  // Derive the keypair fresh from the session email — never trust any
  // client-supplied pubkey. The session.publicKey is only informational.
  let userKp;
  try {
    userKp = await deriveKeypair(session.email, env.MASTER_SECRET);
  } catch (err) {
    return serverError(`key derivation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Only the calls an email account may make, moving only its own funds.
  const policy = gatewayPolicy(env, VAULT_ID);
  let args: StellarSdk.xdr.ScVal[];
  let call: AllowedCall;
  try {
    args = body.argsXdr.map((b64) => StellarSdk.xdr.ScVal.fromXDR(b64, "base64"));
  } catch {
    return badRequest("argsXdr must be base64 ScVal values");
  }
  try {
    call = checkCall(policy, userKp.publicKey(), body.contractId, body.method, args);
  } catch (err) {
    if (err instanceof PolicyError) return json({ error: err.message }, { status: 403 });
    throw err;
  }

  const verdict = await hit(env.DB, executeLimits(userKp.publicKey()));
  if (!verdict.ok) return tooManyRequests(verdict.retryAfter);

  try {
    const res = await runSponsoredContractCall(env, {
      userKp,
      email: session.email,
      contractId: body.contractId,
      method: body.method,
      args,
      call,
      policy,
      ip: clientIp(request),
    });
    return json({ hash: res.hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof GatewayError) return json({ error: msg }, { status: err.status });
    // 400 on user-triggered failures (contract rejection on chain); 500 on
    // infrastructure. We classify by the message prefix we control.
    if (msg.startsWith("tx ")) return json({ error: msg }, { status: 400 });
    return serverError(msg);
  }
}
