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

import { json, serverError } from "../_lib/http";

const CONTRACT_ID = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const EXPERT_API = "https://api.stellar.expert";
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const CACHE_SECONDS = 60;

interface ExpertRecord {
  key: string;
  updated?: number;
}

interface ExpertPage {
  _embedded?: { records?: ExpertRecord[] };
  _links?: { next?: { href?: string } };
}

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
    const records: ExpertRecord[] = [];
    let path: string | null =
      `/explorer/public/contract-data/${CONTRACT_ID}?order=asc&limit=${PAGE_LIMIT}`;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const res = await fetch(EXPERT_API + path, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Stellar Expert HTTP ${res.status}`);
      const body = (await res.json()) as ExpertPage;
      const batch = body._embedded?.records ?? [];
      for (const r of batch) records.push({ key: r.key, updated: r.updated });
      const next = body._links?.next?.href;
      // Only follow `next` from the same contract's listing.
      path =
        batch.length === PAGE_LIMIT && next?.startsWith(`/explorer/public/contract-data/${CONTRACT_ID}`)
          ? next
          : null;
    }

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
