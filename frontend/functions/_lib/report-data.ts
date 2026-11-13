// Pages of the two D1 tables the monthly report reads besides the HITZ events
// (served by functions/api/data.ts, read by scripts/contract-report.mjs):
//
//   - pool_reserves: one pool's reserves after each of its events. For a
//     Sovereign Vault pool (`<vault>:<asset contract>`) that is every seed,
//     deposit and swap hop, including swaps that never move HITZ out of the
//     vault (XLM to USDC), which the HITZ events can't show.
//   - arb_runs: the arbitrage bot's live actions. Its account and every trade
//     are public already (GET /api/v1/bot shows the last 20); the full report
//     JSON of each run stays private.
//
// Plain queries with no Worker imports, so Node tests run them against the
// real schema (tests/report-data.test.mjs).

export interface ReservePoint {
  eventId: string;
  /** Ledger close time, unix seconds. */
  ts: number;
  /** HITZ in the pool, stroops, as a decimal string. */
  hitz: string;
  /** The pool's asset, in its smallest unit, as a decimal string. */
  quote: string;
}

export interface ReservePage {
  pool: string;
  points: ReservePoint[];
  /** The `after` for the next page, or null on the last one. */
  next: string | null;
}

/** One pool's reserve points after `after` (an event id), in event order. */
export async function poolReservesPage(db: D1Database, pool: string, after: string, limit: number): Promise<ReservePage> {
  const { results } = await db
    .prepare("SELECT event_id, ts, hitz, quote FROM pool_reserves WHERE pool = ? AND event_id > ? ORDER BY event_id LIMIT ?")
    .bind(pool, after, limit)
    .all<{ event_id: string; ts: number; hitz: string; quote: string }>();
  const points = results.map((r) => ({ eventId: r.event_id, ts: r.ts, hitz: String(r.hitz), quote: String(r.quote) }));
  return { pool, points, next: points.length === limit ? points[points.length - 1].eventId : null };
}

export interface ArbRun {
  id: number;
  at: string;
  action: string;
  sell: string | null;
  amount_in: string | null;
  vault_out: string | null;
  hedge_out: string | null;
  profit_xlm: number | null;
  gap_pct: number | null;
  vault_tx: string | null;
  hedge_tx: string | null;
}

export interface ArbRunPage {
  runs: ArbRun[];
  /** The `after` for the next page, or null on the last one. */
  next: number | null;
}

/**
 * The bot's live actions after run id `after`, oldest first, in the field
 * names GET /api/v1/bot uses. Dry runs are left out: they moved nothing.
 */
export async function arbRunsPage(db: D1Database, after: number, limit: number): Promise<ArbRunPage> {
  const { results } = await db
    .prepare(
      `SELECT id, at, action, sell, amount_in, vault_out, hedge_out, profit_xlm, gap_pct, vault_tx, hedge_tx
       FROM arb_runs WHERE mode = 'live' AND id > ? ORDER BY id LIMIT ?`
    )
    .bind(after, limit)
    .all<ArbRun>();
  return { runs: results, next: results.length === limit ? results[results.length - 1].id : null };
}
