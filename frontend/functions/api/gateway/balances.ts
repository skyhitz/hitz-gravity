// GET /api/gateway/balances?publicKey=G...
//   → { exists: boolean, balances: BalanceLine[] }
//
// Reads classic balances + trustlines from Horizon for an arbitrary
// G-address. Used by the multi-asset Send component to populate the
// asset dropdown with whatever the sender actually holds (native XLM,
// HITZ, USDC, plus any other trustlines the user added themselves).
//
// Why server-side rather than calling Horizon from the browser: keeps a
// single place to switch Horizon endpoints (mainnet vs testnet) and lets
// us hide the URL behind a same-origin /api/* path so we don't have
// browser CORS surface area to manage. Horizon does support browser
// CORS, but routing through here matches the rest of the gateway.
//
// No session required — balances and trustlines are public on chain.

import * as StellarSdk from "@stellar/stellar-sdk";
import { badRequest, json, serverError } from "../../_lib/http";
import { getAccountInfo } from "../../_lib/stellar";
import type { Env } from "../../_lib/types";

export async function GET(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const publicKey = url.searchParams.get("publicKey");
  if (!publicKey) return badRequest("publicKey required");
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    return badRequest("invalid Stellar address");
  }

  try {
    const info = await getAccountInfo(env, publicKey);
    return json(info);
  } catch (err) {
    return serverError(
      `balances fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
