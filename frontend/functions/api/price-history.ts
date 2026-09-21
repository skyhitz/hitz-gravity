// GET /api/price/history
//   → { asOf, pools: [{address, pair, quote, weight}], points: [[hour, usd]] }
//
// Hourly HITZ/USD since launch, liquidity-weighted across the registered
// HITZ pools (model: _lib/price-model.ts). The ingestion cron keeps the
// payload pre-rendered in `snapshots`, so a cache miss is one D1 read.

import { cachedJson } from "../_lib/cache";
import { PRICE_SNAPSHOT_KEY } from "../_lib/ingest";
import { json } from "../_lib/http";
import type { Env } from "../_lib/types";

class NotIndexedYet extends Error {}

export async function GET(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await cachedJson(
      request,
      ctx,
      async () => {
        const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?")
          .bind(PRICE_SNAPSHOT_KEY)
          .first<{ json: string }>();
        if (!row) throw new NotIndexedYet();
        return JSON.parse(row.json) as unknown;
      },
      60
    );
  } catch (err) {
    if (!(err instanceof NotIndexedYet)) throw err;
    return json(
      { error: "price history is still being indexed" },
      { status: 503, headers: { "Retry-After": "300", "Access-Control-Allow-Origin": "*" } }
    );
  }
}
