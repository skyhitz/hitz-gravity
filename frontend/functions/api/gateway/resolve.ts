// POST /api/gateway/resolve  { email: string }
//   → { publicKey: string }
//
// The Stellar address derived for an email. Used by "send to email" before
// the sender issues `transfer(from, to, amount)`.
//
// This is a lookup and nothing else. It takes any email from anyone, with no
// login, so it must never create or fund anything: whatever it gave out
// could be collected in bulk.
//
// Nothing needs it to. HITZ doesn't need the account at all (its balances
// live in the token contract), so a transfer to an email that has never
// signed in works without one. So does a transfer of 1 XLM or more: the
// asset contract opens the account with the sender's XLM. USDC needs the
// recipient's trustline, which is added the first time they swap into USDC.

import { deriveKeypair } from "../../_lib/derive";
import { isValidEmail } from "../../_lib/email";
import { badRequest, clientIp, json, readJson, tooManyRequests } from "../../_lib/http";
import { resolveLimits } from "../../_lib/limits";
import { hit } from "../../_lib/rate-limit";
import type { Env } from "../../_lib/types";

interface Body {
  email?: string;
}

export async function POST(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body?.email || typeof body.email !== "string") {
    return badRequest("email required");
  }
  if (!isValidEmail(body.email)) return badRequest("invalid email");

  const verdict = await hit(env.DB, resolveLimits(clientIp(request)));
  if (!verdict.ok) return tooManyRequests(verdict.retryAfter);

  const userKp = await deriveKeypair(body.email, env.MASTER_SECRET);
  return json({ publicKey: userKp.publicKey() });
}
