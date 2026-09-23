// GET /api/holders
//   → { records: { key: string; updated?: number }[] }
//
// The HITZ contract's storage index, as Stellar Expert records it: one
// record per contract-data ledger entry, `key` being the base64 ScVal of
// the storage key. The Holder Ecosystem decodes the `Balance(addr)` keys to
// discover every holder, then reads the actual balances from Soroban RPC —
// this route only answers "which keys exist", never amounts.
//
// Why a proxy: Soroban storage can't be enumerated over RPC, and Stellar
// Expert (which indexes it) rejects browser requests from our origin. A
// server-side fetch carries no Origin header and goes through. The URL is
// fixed to our contract, so this can't be used as an open relay.
//
// Cached at the edge for 60s — the index only changes when a brand-new
// address receives HITZ, and every visitor would otherwise page through
// Stellar Expert on each Monitor-tab load.

import { fetchContractDataIndex } from "../_lib/holders";
import { json, serverError } from "../_lib/http";

const CONTRACT_ID = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const CACHE_SECONDS = 60;

export async function GET(
  request: Request,
  _env: unknown,
  ctx: ExecutionContext
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/holders", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const records = await fetchContractDataIndex(CONTRACT_ID);
    const response = json(
      { records },
      { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } }
    );
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return serverError(
      `holder index fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
