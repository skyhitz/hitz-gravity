// POST /api/gateway/execute
//
//   body: { contractId, method, argsXdr: string[] }  (argsXdr[] are base64 ScVal)
//   cookie: hitz_session JWT
//   → { hash } on success
//
// The core custodial-action endpoint. For an email-authenticated user:
//   1. Authenticate via session cookie.
//   2. Derive the user's keypair from session.email (never trust the
//      client-supplied publicKey — derive fresh and use that).
//   3. Run the contract call with the derived key as source, wrapping the
//      whole thing in a fee-bump signed by the sponsor. Bootstrap the
//      account on first call.
//
// No per-tx confirmation UI — that's the whole point of the gas station.
// Wallet users hit their own sign flow client-side; they never touch this.

import { deriveKeypair } from "../../_lib/derive";
import { badRequest, json, readJson, serverError, unauthorized } from "../../_lib/http";
import { readSession } from "../../_lib/session";
import { runSponsoredContractCall } from "../../_lib/stellar";
import type { Env } from "../../_lib/types";

interface Body {
  contractId?: string;
  method?: string;
  argsXdr?: string[];
}

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
  if (!Array.isArray(body.argsXdr) || !body.argsXdr.every((a) => typeof a === "string")) {
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

  try {
    const res = await runSponsoredContractCall(
      env,
      userKp,
      body.contractId,
      body.method,
      body.argsXdr
    );
    return json({ hash: res.hash });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 400 on user-triggered failures (sim error, contract rejection); 500
    // on infrastructure. We can't perfectly distinguish, so we classify by
    // message prefix we control.
    if (msg.startsWith("simulation failed") || msg.startsWith("tx ")) {
      return json({ error: msg }, { status: 400 });
    }
    return serverError(msg);
  }
}
