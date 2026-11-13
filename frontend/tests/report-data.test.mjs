// The read routes the monthly report adds (functions/_lib/report-data.ts),
// against the real schema: one pool's reserve points in event order, and the
// bot's live log without its dry runs, both paged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { arbRunsPage, poolReservesPage } from "../functions/_lib/report-data.ts";
import { testDb } from "./helpers/d1.mjs";

const XLM_POOL = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU:CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC_POOL = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU:CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

function withReserves() {
  const db = testDb();
  const insert = db.raw.prepare("INSERT INTO pool_reserves (pool, event_id, ts, hitz, quote) VALUES (?, ?, ?, ?, ?)");
  // Inserted out of order: the route orders by event id.
  insert.run(XLM_POOL, "0280804923158401024-0000000002", 1794185997, "509739411813420", "108590620034");
  insert.run(XLM_POOL, "0280432832961880064-0000000002", 1793752824, "50973941813420", "10859062138");
  insert.run(XLM_POOL, "0280832299280044032-0000000002", 1794217867, "509692952845764", "108600620034");
  insert.run(USDC_POOL, "0280433159379222528-0000000002", 1793753204, "37451084986055", "1273331229");
  return db;
}

test("pool reserves: one pool, in event order, paged by event id", async () => {
  const db = withReserves();
  const first = await poolReservesPage(db, XLM_POOL, "", 2);
  assert.equal(first.pool, XLM_POOL);
  assert.deepEqual(
    first.points.map((p) => p.eventId),
    ["0280432832961880064-0000000002", "0280804923158401024-0000000002"]
  );
  assert.deepEqual(first.points[0], {
    eventId: "0280432832961880064-0000000002",
    ts: 1793752824,
    hitz: "50973941813420",
    quote: "10859062138",
  });
  assert.equal(first.next, "0280804923158401024-0000000002");
  const second = await poolReservesPage(db, XLM_POOL, first.next, 2);
  assert.deepEqual(second.points.map((p) => p.eventId), ["0280832299280044032-0000000002"]);
  assert.equal(second.next, null);
  // Another pool's rows never leak in; an unknown pool is simply empty.
  assert.equal((await poolReservesPage(db, USDC_POOL, "", 10)).points.length, 1);
  assert.deepEqual(await poolReservesPage(db, "CNOPE", "", 10), { pool: "CNOPE", points: [], next: null });
});

test("arbitrage runs: live actions only, oldest first, paged by id, no private report", async () => {
  const db = testDb();
  const insert = db.raw.prepare(
    `INSERT INTO arb_runs (at, mode, action, sell, amount_in, vault_out, hedge_out, profit_xlm, gap_pct, vault_tx, hedge_tx, report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run("2026-11-12T16:40:00.000Z", "dry-run", "would-trade", "XLM", "5", "0.7", "5.1", 0.05, 9.9, null, null, "{}");
  insert.run("2026-11-12T16:52:38.134Z", "live", "setup", null, null, null, null, null, 10.298, null, null, '{"secret":"no"}');
  insert.run("2026-11-12T17:07:38.494Z", "live", "trade", "XLM", "25.7379483", "3.8978517", "27.011573", 1.2773079, 10.627, "a".repeat(64), "b".repeat(64), "{}");
  insert.run("2026-11-12T22:32:37.921Z", "live", "trade-incomplete", "XLM", "4.1", null, "4.2", null, 7.1, null, "c".repeat(64), "{}");

  const first = await arbRunsPage(db, 0, 2);
  assert.deepEqual(first.runs.map((r) => r.action), ["setup", "trade"]);
  assert.equal(first.next, first.runs[1].id);
  assert.ok(first.runs.every((r) => !("report" in r) && !("mode" in r)));
  assert.deepEqual(
    { ...first.runs[1], id: undefined },
    {
      id: undefined,
      at: "2026-11-12T17:07:38.494Z",
      action: "trade",
      sell: "XLM",
      amount_in: "25.7379483",
      vault_out: "3.8978517",
      hedge_out: "27.011573",
      profit_xlm: 1.2773079,
      gap_pct: 10.627,
      vault_tx: "a".repeat(64),
      hedge_tx: "b".repeat(64),
    }
  );
  const second = await arbRunsPage(db, first.next, 2);
  assert.deepEqual(second.runs.map((r) => r.action), ["trade-incomplete"]);
  assert.equal(second.next, null);
});
