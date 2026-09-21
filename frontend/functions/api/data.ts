// Read-only export of the D1 data store — the monthly report generator
// (scripts/contract-report.mjs) reads through these instead of the old
// reports/data/ files. Everything here is public on-chain data (or public
// metadata about it), so the routes are open and edge-cached.
//
//   GET /api/data/events?after=<id>&limit=<≤1000>
//     → { events: [{ledger, ts, txHash, id, name, topics, data}], next }
//     Same row shape as the old events.jsonl, in id (= chronological) order.
//   GET /api/data/tx-info?after=<hash>&limit=<≤2000>
//     → { items: { [hash]: info }, next }
//   GET /api/data/contract-info
//     → { [address]: info }
//   GET /api/data/status
//     → ingestion health: latest event, cursor freshness, row counts

import { cachedJson } from "../_lib/cache";
import { badRequest } from "../_lib/http";
import type { Env } from "../_lib/types";

function pageParams(request: Request, max: number): { after: string; limit: number } | null {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? max);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) return null;
  return { after: url.searchParams.get("after") ?? "", limit };
}

export async function GET_EVENTS(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const page = pageParams(request, 1000);
  if (!page) return badRequest("limit must be 1..1000");
  return cachedJson(
    request,
    ctx,
    async () => {
      const { results } = await env.DB.prepare(
        "SELECT id, ledger, ts, tx_hash, name, topics, data FROM hitz_events WHERE id > ? ORDER BY id LIMIT ?"
      )
        .bind(page.after, page.limit)
        .all<{ id: string; ledger: number; ts: string; tx_hash: string; name: string; topics: string; data: string | null }>();
      const events = results.map((r) => ({
        ledger: r.ledger,
        ts: r.ts,
        txHash: r.tx_hash,
        id: r.id,
        name: r.name,
        topics: JSON.parse(r.topics),
        data: r.data === null ? null : JSON.parse(r.data),
      }));
      return { events, next: events.length === page.limit ? events[events.length - 1].id : null };
    },
    // Full pages sit behind the tip and only change if history is re-imported.
    (body) => (body.next ? 3600 : 60)
  );
}

export async function GET_TX_INFO(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const page = pageParams(request, 2000);
  if (!page) return badRequest("limit must be 1..2000");
  return cachedJson(
    request,
    ctx,
    async () => {
      const { results } = await env.DB.prepare("SELECT hash, info FROM tx_info WHERE hash > ? ORDER BY hash LIMIT ?")
        .bind(page.after, page.limit)
        .all<{ hash: string; info: string }>();
      const items: Record<string, unknown> = {};
      for (const r of results) items[r.hash] = JSON.parse(r.info);
      return { items, next: results.length === page.limit ? results[results.length - 1].hash : null };
    },
    300
  );
}

export async function GET_CONTRACT_INFO(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cachedJson(
    request,
    ctx,
    async () => {
      const { results } = await env.DB.prepare("SELECT address, info FROM contract_info ORDER BY address").all<{
        address: string;
        info: string;
      }>();
      const out: Record<string, unknown> = {};
      for (const r of results) out[r.address] = JSON.parse(r.info);
      return out;
    },
    300
  );
}

export async function GET_STATUS(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cachedJson(
    request,
    ctx,
    async () => {
      const [latest, counts, cursors] = await Promise.all([
        env.DB.prepare("SELECT id, ledger, ts FROM hitz_events ORDER BY id DESC LIMIT 1").first(),
        env.DB.prepare(
          `SELECT (SELECT count(*) FROM hitz_events) AS events,
                  (SELECT count(*) FROM tx_info) AS txInfo,
                  (SELECT count(*) FROM contract_info) AS contractInfo,
                  (SELECT count(*) FROM pool_reserves) AS poolReserves,
                  (SELECT count(*) FROM quote_prices) AS quotePrices,
                  (SELECT count(*) FROM price_hourly) AS priceHours`
        ).first(),
        env.DB.prepare("SELECT source, cursor, updated_at FROM cursors ORDER BY source").all(),
      ]);
      return { latestEvent: latest, counts, cursors: cursors.results };
    },
    30
  );
}
