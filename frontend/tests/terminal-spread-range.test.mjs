// The HITZ Terminal's CEX vs DEX ranges (app/components/terminal/spreadRange.ts): the window, bins and
// refresh each tab asks for, and when the viewer's plan, not the data or the clock, cut a window short.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spreadCut, spreadDefault, spreadQuery } from "../app/components/terminal/spreadRange.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const AS_OF = "2026-11-26T12:00:00.000Z";
const A = Date.parse(AS_OF);
const iso = (ms) => new Date(ms).toISOString();
const bins = (from, to, bin) => { const out = []; for (let t = Math.floor(from / bin) * bin; t < to; t += bin) out.push({ t }); return out; };
const cutTo = (days, plan) => ({ from: iso(A - days * DAY), limited: [`history starts ${days} days back on the ${plan} plan`], as_of: AS_OF });

test("each tab's window, bins and refresh", () => {
  assert.deepEqual(spreadQuery("1D", true), { params: { resolution: "5m" }, spanMs: DAY, everyMs: MIN, binMs: 5 * MIN });
  assert.deepEqual(spreadQuery("1D", false), { params: { resolution: "1h" }, spanMs: DAY, everyMs: MIN, binMs: HOUR });
  assert.deepEqual(spreadQuery("7D", true), { params: { resolution: "1h" }, spanMs: 7 * DAY, everyMs: MIN, binMs: HOUR });
  assert.deepEqual(spreadQuery("30D", false), { params: { resolution: "1h" }, spanMs: 30 * DAY, everyMs: 15 * MIN, binMs: HOUR });
  assert.deepEqual(spreadQuery("90D", true), { params: { resolution: "1d" }, spanMs: 90 * DAY, everyMs: 15 * MIN, binMs: DAY });
  assert.deepEqual(spreadQuery("All", false), { params: { resolution: "1d", from: "2015-01-01" }, everyMs: 15 * MIN, binMs: DAY });
});

test("the default tab is today's view", () => {
  assert.equal(spreadDefault(true), "1D");
  assert.equal(spreadDefault(false), "7D");
});

test("a plan cut: Free on 30D, Trader on All", () => {
  assert.equal(spreadCut(bins(A - 7 * DAY, A, HOUR), spreadQuery("30D", false), cutTo(7, "Free")), true);
  assert.equal(spreadCut(bins(A - 90 * DAY, A, DAY), spreadQuery("All", true), cutTo(90, "Trader")), true);
});

test("clock drift is no cut", () => {
  // The browser asked from a few seconds before the plan's reach: the gate narrowed it, by seconds.
  assert.equal(spreadCut(bins(A - 7 * DAY, A, HOUR), spreadQuery("7D", false), cutTo(7, "Free")), false);
  assert.equal(spreadCut(bins(A - 90 * DAY, A, DAY), spreadQuery("90D", true), cutTo(90, "Trader")), false);
});

test("the data starting after the plan's reach is no cut (Pro on All)", () => {
  assert.equal(spreadCut(bins(Date.UTC(2026, 5, 12), A, DAY), spreadQuery("All", true), cutTo(365, "Pro")), false);
});

test("nothing narrowed, only the bins, or nothing to show: no cut", () => {
  assert.equal(spreadCut(bins(A - 400 * DAY, A, DAY), spreadQuery("All", true), { from: "2015-01-01T00:00:00.000Z", as_of: AS_OF }), false);
  assert.equal(spreadCut(bins(A - DAY, A, HOUR), spreadQuery("1D", true), { from: iso(A - DAY), limited: ["bins of 1h or wider on the Free plan"], as_of: AS_OF }), false);
  assert.equal(spreadCut([], spreadQuery("30D", false), cutTo(7, "Free")), false);
  assert.equal(spreadCut(bins(A - 7 * DAY, A, HOUR), spreadQuery("30D", false), { ...cutTo(7, "Free"), as_of: "not a time" }), false);
});
