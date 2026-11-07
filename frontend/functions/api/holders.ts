// GET /api/holders
//   → { holders: string[] }
//
// Every address our own index knows to have held HITZ (the D1 `holders`
// table: addresses from the ingested HITZ events, plus a one-time backfill
// of holders older than the event store). The Holder Ecosystem reads the
// actual balances and vault flags from Soroban RPC; this route only answers
// "which addresses", never amounts.
//
// Edge-cached for 60s: the list only grows when a brand-new address
// receives HITZ.

import { cachedJson } from "../_lib/cache";
import { listHolders } from "../_lib/holders";
import type { Env } from "../_lib/types";

export async function GET(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cachedJson(request, ctx, async () => ({ holders: await listHolders(env) }), 60);
}
