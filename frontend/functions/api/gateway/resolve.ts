// POST /api/gateway/resolve  { email: string }
//   → { publicKey: string }
//
// Given an email, return the Stellar address that would be derived for it
// AND ensure that address is bootstrapped on-chain (funded with the base
// reserve by the sponsor). Used by the "send HITZ to email" flow before
// the sender issues `transfer(from, to, amount)`.
//
// Why the side effect: the HITZ SAC-backed token refuses transfers whose
// destination has no classic account — simulation fails with
// `Account not found: <G…>`. Pre-bootstrapping the derived address makes
// the subsequent transfer land whether the sender is wallet-mode or
// email-mode, first-time recipient or repeat.
//
// Abuse surface: bootstrap is idempotent and costs 1 XLM per brand-new
// account. Address comes from an email hash, not caller-supplied, so an
// attacker would have to spray unique emails to burn sponsor balance.
// Fine on testnet; if we move to mainnet we'll gate this on a session
// cookie or a challenge.

import * as StellarSdk from "@stellar/stellar-sdk";
import { deriveKeypair, getServerKeys } from "../../_lib/derive";
import { isValidEmail } from "../../_lib/email";
import { badRequest, json, readJson, serverError } from "../../_lib/http";
import { ensureBootstrappedWithUsdcTrustline } from "../../_lib/stellar";
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
  const userKp = await deriveKeypair(body.email, env.MASTER_SECRET);
  const publicKey = userKp.publicKey();

  try {
    const server = new StellarSdk.rpc.Server(env.RPC_URL);
    const { sponsorKeypair } = await getServerKeys(env.MASTER_SECRET);
    // Bootstrap target + sponsored USDC trustline. Idempotent — recipient
    // accounts that already exist with the trustline short-circuit.
    await ensureBootstrappedWithUsdcTrustline(env, server, sponsorKeypair, userKp);
  } catch (err) {
    return serverError(
      `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return json({ publicKey });
}
