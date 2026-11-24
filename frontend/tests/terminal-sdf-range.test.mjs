// The HITZ Terminal's SDF supply ranges (app/components/terminal/sdfRange.ts): which days each tab
// shows, and when the viewer's plan, not the data, cut the history short (Trader has a year of daily
// data; Pro and Institutional have all of it).

import assert from "node:assert/strict";
import { test } from "node:test";
import { cutByPlan, inRange, rangeStart, SDF_RANGES } from "../app/components/terminal/sdfRange.ts";

const span = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push({ day: new Date(t).toISOString().slice(0, 10) });
  return out;
};
const all = span("2021-01-01", "2026-11-23"); // what D1 held on Nov 24, 2026
const trader = span("2025-11-24", "2026-11-23");
const traderMeta = { from: "2025-11-24", limited: ["history starts 2025-11-24 on the Trader plan"] };

test("ranges are anchored to the newest day", () => {
  assert.equal(rangeStart("2026-11-23", 90), "2026-08-26");
  assert.equal(rangeStart("2026-11-23", 365), "2025-11-24");
  assert.equal(rangeStart("2026-11-23", 1095), "2023-11-25");
  assert.equal(rangeStart("2026-11-23", null), null);
});

test("inRange keeps the range's days", () => {
  assert.equal(all.length, 2153);
  assert.equal(inRange(all, 90).length, 90);
  assert.equal(inRange(all, 365)[0].day, "2025-11-24");
  assert.equal(inRange(all, null).length, 2153);
  assert.deepEqual(inRange([], 90), []);
});

test("a full-history plan is never cut", () => {
  for (const r of SDF_RANGES) assert.equal(cutByPlan(all, r.days, { from: "2015-01-01" }), false);
});

test("Trader is cut on 3Y and All only", () => {
  assert.deepEqual(SDF_RANGES.map((r) => cutByPlan(trader, r.days, traderMeta)), [false, false, true, true]);
});

test("the plan's year runs back from the server's clock, not the newest row", () => {
  // Until the 06:00 UTC import the newest complete day is two days back, while the gate's window
  // still starts 365 days before now (gate.ts): 1Y is no cut.
  const lagging = span("2025-11-25", "2026-11-23");
  const meta = { from: "2025-11-25", limited: ["history starts 2025-11-25 on the Trader plan"], as_of: "2026-11-25T03:00:00.000Z" };
  assert.deepEqual(SDF_RANGES.map((r) => cutByPlan(lagging, r.days, meta)), [false, false, true, true]);
  const outage = span("2025-11-25", "2026-11-21"); // three days without an import
  assert.deepEqual(SDF_RANGES.map((r) => cutByPlan(outage, r.days, { ...meta, as_of: "2026-11-25T09:00:00.000Z" })), [false, false, true, true]);
});

test("an unreadable as_of measures from the newest row", () => {
  assert.deepEqual(SDF_RANGES.map((r) => cutByPlan(trader, r.days, { ...traderMeta, as_of: "not a time" })), [false, false, true, true]);
});

test("a narrowed window that starts before the data is no cut", () => {
  assert.equal(cutByPlan(all, null, { from: "2020-01-01", limited: ["history starts 2020-01-01 on the Pro plan"] }), false);
  assert.equal(cutByPlan([], null, traderMeta), false);
});
