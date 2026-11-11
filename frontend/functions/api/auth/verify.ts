// GET /api/auth/verify?token=...
//
// Second leg of the magic-link flow. The token came from the email body
// and is single-use: we DELETE it from KV the moment we look it up, so
// replaying a leaked link is impossible.
//
// On success:
//   - Derive the user's Stellar keypair from email + MASTER_SEED.
//   - Issue a 30-day session JWT as an HttpOnly cookie.
//   - If a pending legacy-reparation record exists for this email,
//     redeem it inline: create the derived account (sponsored, zero
//     balance) + sponsor → user transfers of the recorded amounts.
//     Failures here don't fail the login: the record stays around for
//     retry on next login.
//   - Return {email, publicKey} (and {redeemed} on success) so the
//     client can hydrate state and show a claim banner.
//
// Signing in does nothing else on chain. Anyone can sign in with any number
// of emails, so nothing the sponsor pays for may depend on it alone. An
// account is created the first time its owner does something that needs one
// (_lib/stellar.ts).
//
// This is called by the /auth/verify/ page in the browser; the page then
// redirects home. We don't redirect server-side — a 302 would work and
// the Set-Cookie would still land, but keeping the client in control of
// navigation lets us show an error state cleanly.

import { deriveKeypair, getServerKeys } from "../../_lib/derive";
import { json, unauthorized } from "../../_lib/http";
import { signSession } from "../../_lib/jwt";
import { redeemPendingReparation, type RedeemResult } from "../../_lib/reparation";
import { SESSION_TTL_SECONDS, serializeSessionCookie } from "../../_lib/session";
import type { Env, Session } from "../../_lib/types";

interface TokenRecord {
  email: string;
  createdAt: number;
}

export async function GET(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return unauthorized("missing token");

  const raw = await env.MAGIC_LINKS.get(token);
  if (!raw) return unauthorized("link expired or already used");
  // Single-use: remove immediately so a double-click can't reuse it.
  await env.MAGIC_LINKS.delete(token);

  let record: TokenRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return unauthorized("corrupt token record");
  }

  const userKp = await deriveKeypair(record.email, env.MASTER_SECRET);
  const publicKey = userKp.publicKey();
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const session: Session = { email: record.email, publicKey, exp };
  const { jwtSecret } = await getServerKeys(env.MASTER_SECRET);
  const jwt = await signSession(session, jwtSecret);

  // Inline redemption of pending legacy reparation, if any. This is the
  // lazy path: we only bootstrap + transfer on first successful click, so
  // un-claimed rows cost nothing. Failures don't bubble up — the magic
  // link login itself succeeded, and the reparation record stays for a
  // retry on the user's next login.
  let redeemed: RedeemResult | null = null;
  try {
    redeemed = await redeemPendingReparation(env, ctx, record.email, publicKey);
  } catch (err) {
    // Defensive — redeemPendingReparation already swallows internal errors,
    // but if anything escapes we still want the login to succeed.
    console.error(
      `[verify] unexpected redeem error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return json(
    { email: record.email, publicKey, redeemed },
    { headers: { "Set-Cookie": serializeSessionCookie(jwt) } }
  );
}
