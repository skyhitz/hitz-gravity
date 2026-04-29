// POST /api/gateway/bootstrap  { address: string }
//   → { publicKey: string }
//
// Ensures an arbitrary Stellar G-address has a funded classic account on
// chain, creating it via the sponsor (base reserve, 1 XLM) if missing.
// Idempotent — a no-op when the account already exists.
//
// Why it exists: HITZ is SAC-backed, and SAC `transfer` refuses a
// destination without a classic account. The email flow hides this via
// /api/gateway/resolve, which bootstraps the derived address. This
// endpoint is the equivalent hook for the "I'm sending to a G-address I
// typed in" path — otherwise a brand-new, unfunded destination fails
// submit with txBAD_AUTH and the sender has no way to recover without
// asking the recipient to fund themselves first.
//
// Abuse surface: caller-supplied address means anyone can burn 1 XLM of
// sponsor balance per unique G-key. Fine on testnet. For mainnet we'll
// gate this on a session cookie (same as /api/gateway/execute) — the
// StrKey validation already prevents malformed input from reaching the
// RPC, so the cost is strictly "1 XLM per new account".

import * as StellarSdk from "@stellar/stellar-sdk";
import { getServerKeys } from "../../_lib/derive";
import { badRequest, json, readJson, serverError } from "../../_lib/http";
import { ensureAccountBootstrapped } from "../../_lib/stellar";
import type { Env } from "../../_lib/types";

interface Body {
  address?: string;
}

export async function POST(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Body>(request);
  if (!body?.address || typeof body.address !== "string") {
    return badRequest("address required");
  }
  const address = body.address.trim();
  // Defence in depth: StrKey validates length + checksum, so the RPC
  // never sees a malformed key. Reject before spending any round-trip.
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
    return badRequest("invalid Stellar address");
  }

  try {
    const server = new StellarSdk.rpc.Server(env.RPC_URL);
    const { sponsorKeypair } = await getServerKeys(env.MASTER_SECRET);
    await ensureAccountBootstrapped(env, server, sponsorKeypair, address);
  } catch (err) {
    return serverError(
      `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return json({ publicKey: address });
}
