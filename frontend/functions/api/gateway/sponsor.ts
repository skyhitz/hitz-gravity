// GET /api/gateway/sponsor
//
// Ops helper — returns the gas-sponsor Stellar address so the operator
// knows which G-account to fund. Nothing secret here: the sponsor address
// is public on-chain the first time it pays for a fee bump anyway.
//
// Handy when first deploying: set MASTER_SECRET, hit this once, fund the
// returned G-address with testnet XLM (e.g. Friendbot), and the gas
// station is ready.

import { json } from "../../_lib/http";
import { getSponsorAddress } from "../../_lib/stellar";
import type { Env } from "../../_lib/types";

export async function GET(_request: Request, env: Env): Promise<Response> {
  const publicKey = await getSponsorAddress(env);
  return json({ publicKey });
}
