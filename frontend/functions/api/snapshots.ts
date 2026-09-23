// Pre-rendered market data, one D1 read per cache miss. The ingestion cron
// (_lib/ingest.ts) rebuilds each snapshot as new pool / quote data lands.
//
//   GET /api/price/history
//     → { asOf, pools: [{address, pair, quote, weight}], points: [[hour, usd]] }
//     Hourly HITZ/USD since launch, liquidity-weighted across the
//     registered HITZ pools (model: _lib/price-model.ts).
//   GET /api/liquidity
//     → { asOf, pools, totals, volume: {h24, d7, d30}, history: [[hour, tvlUsd]] }
//     Per-pool depth, ±2% depth, cross-pool spread, swap volume and fees,
//     and hourly TVL over the last 30 days.

import { cachedJson } from "../_lib/cache";
import { LIQUIDITY_SNAPSHOT_KEY, PRICE_SNAPSHOT_KEY } from "../_lib/ingest";
import { json } from "../_lib/http";
import type { Env } from "../_lib/types";

class NotIndexedYet extends Error {}

function snapshotRoute(key: string, what: string) {
  return async function GET(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await cachedJson(
        request,
        ctx,
        async () => {
          const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?").bind(key).first<{ json: string }>();
          if (!row) throw new NotIndexedYet();
          return JSON.parse(row.json) as unknown;
        },
        60
      );
    } catch (err) {
      if (!(err instanceof NotIndexedYet)) throw err;
      return json(
        { error: `${what} is still being indexed` },
        { status: 503, headers: { "Retry-After": "300", "Access-Control-Allow-Origin": "*" } }
      );
    }
  };
}

export const GET_PRICE_HISTORY = snapshotRoute(PRICE_SNAPSHOT_KEY, "price history");
export const GET_LIQUIDITY = snapshotRoute(LIQUIDITY_SNAPSHOT_KEY, "liquidity data");
