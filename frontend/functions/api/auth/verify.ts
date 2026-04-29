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
//     redeem it inline: bootstrap derived account + sponsor → user
//     SAC transfer of the recorded amount. Failures here don't fail
//     the login — the record stays around for retry on next login.
//   - Return {email, publicKey} (and {redeemed} on success) so the
//     client can hydrate state and show a claim banner.
//
// This is called by the /auth/verify/ page in the browser; the page then
// redirects home. We don't redirect server-side — a 302 would work and
// the Set-Cookie would still land, but keeping the client in control of
// navigation lets us show an error state cleanly.

import * as StellarSdk from "@stellar/stellar-sdk";
import { deriveKeypair, getServerKeys } from "../../_lib/derive";
import { json, unauthorized } from "../../_lib/http";
import { signSession } from "../../_lib/jwt";
import { redeemPendingReparation, type RedeemResult } from "../../_lib/reparation";
import { SESSION_TTL_SECONDS, serializeSessionCookie } from "../../_lib/session";
import { ensureBootstrappedWithUsdcTrustline } from "../../_lib/stellar";
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
  const { jwtSecret, sponsorKeypair: sponsor } = await getServerKeys(
    env.MASTER_SECRET
  );
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

  // Legacy-user retrofit: ensure the USDC trustline exists on every login.
  // Reparation redemption already handles this for un-redeemed users; this
  // covers the population that redeemed before the trustline flow shipped.
  // Idempotent — no-op for accounts already in the desired state.
  try {
    const server = new StellarSdk.rpc.Server(env.RPC_URL);
    await ensureBootstrappedWithUsdcTrustline(env, server, sponsor, userKp);
  } catch (err) {
    console.error(
      `[verify] ensureBootstrappedWithUsdcTrustline failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return json(
    { email: record.email, publicKey, redeemed },
    { headers: { "Set-Cookie": serializeSessionCookie(jwt) } }
  );
}
