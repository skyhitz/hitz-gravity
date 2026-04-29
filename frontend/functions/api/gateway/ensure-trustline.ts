// POST /api/gateway/ensure-trustline
//
//   cookie: hitz_session JWT (required)
//   → { changed: boolean }
//
// Idempotently ensures the session user's derived account exists on chain
// AND has the configured USDC trustline. The bootstrap + sponsored
// trustline are applied atomically when the account is brand new, or via
// a separate sponsored ChangeTrust when the account exists but lacks the
// trustline. No-op when the account is already in the desired state.
//
// Why an explicit endpoint exists: the trustline flow shipped after the
// initial reparation campaign, so legacy email users who already
// bootstrapped + redeemed are missing the trustline. The /api/auth/verify
// path also calls the same orchestrator, but that only fires on fresh
// magic-link logins. This endpoint lets the client retrofit existing
// sessions on app load — `WalletContext` calls it once when it detects an
// email session, so users don't have to re-login to gain swap support.

import * as StellarSdk from "@stellar/stellar-sdk";
import { deriveKeypair, getServerKeys } from "../../_lib/derive";
import { json, serverError, unauthorized } from "../../_lib/http";
import { readSession } from "../../_lib/session";
import { ensureBootstrappedWithUsdcTrustline } from "../../_lib/stellar";
import type { Env } from "../../_lib/types";

export async function POST(request: Request, env: Env): Promise<Response> {
  const session = await readSession(request, env);
  if (!session) return unauthorized("no session");

  try {
    const userKp = await deriveKeypair(session.email, env.MASTER_SECRET);
    const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
    const server = new StellarSdk.rpc.Server(env.RPC_URL);
    const changed = await ensureBootstrappedWithUsdcTrustline(
      env,
      server,
      sponsor,
      userKp
    );
    return json({ changed });
  } catch (err) {
    return serverError(
      `ensure-trustline failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
