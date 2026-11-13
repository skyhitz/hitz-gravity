// The HITZ Terminal's plans, prices, billing and plan gate (functions/_lib/terminal/).

import assert from "node:assert/strict";
import { test } from "node:test";
import { cheapestWith, PERIOD_MS, PLANS, priceUsd, publicPlans } from "../functions/_lib/terminal/plans.ts";
import { planAt } from "../functions/_lib/terminal/billing.ts";
import { gate } from "../functions/_lib/terminal/gate.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const buy = (plan, at, periods = 1) => ({ plan, periods, usd: priceUsd(plan, periods), paid_at: at });

test("prices: per 30 days, twelve periods cost ten, only 1 or 12 sold", () => {
  assert.deepEqual([priceUsd("trader", 1), priceUsd("pro", 1), priceUsd("institutional", 1)], [29, 99, 499]);
  assert.equal(priceUsd("pro", 12), 990);
  assert.throws(() => priceUsd("pro", 3));
  assert.equal(cheapestWith("leverage"), "trader");
  assert.equal(cheapestWith("labels"), "institutional");
  assert.equal(cheapestWith("overview"), "free");
  const shown = publicPlans();
  assert.deepEqual(shown.map((p) => p.id), ["free", "trader", "pro", "institutional"]);
  for (const p of shown) for (const f of [p.tagline, ...p.features]) assert.doesNotMatch(f, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
});

test("billing: nothing bought is free; a plan runs its periods and then ends", () => {
  assert.equal(planAt([], T0).plan, "free");
  const s = planAt([buy("trader", T0)], T0 + DAY);
  assert.deepEqual([s.plan, s.until], ["trader", T0 + PERIOD_MS]);
  assert.equal(planAt([buy("trader", T0)], T0 + PERIOD_MS).plan, "free");
  assert.equal(planAt([buy("trader", T0 + DAY)], T0).plan, "free", "a purchase counts from when it was paid");
});

test("billing: the same plan again extends it, a year at the year's price", () => {
  const s = planAt([buy("pro", T0), buy("pro", T0 + 10 * DAY)], T0 + 11 * DAY);
  assert.equal(s.until, T0 + 2 * PERIOD_MS);
  assert.equal(planAt([buy("pro", T0, 12)], T0 + 300 * DAY).until, T0 + 12 * PERIOD_MS);
});

test("billing: an upgrade starts now and turns what is left into extra time at the new rate", () => {
  // Trader ($29) paid at T0; Pro ($99) 10 days in: 20 days of Trader are worth $29 x 20/30.
  const s = planAt([buy("trader", T0), buy("pro", T0 + 10 * DAY)], T0 + 11 * DAY);
  const credit = (29 * 20) / 30;
  const extra = Math.floor(credit / (99 / PERIOD_MS));
  assert.equal(s.plan, "pro");
  assert.equal(s.until, T0 + 10 * DAY + PERIOD_MS + extra);
  // An annual Trader is credited at the price paid for it, not the monthly list price.
  const annual = planAt([buy("trader", T0, 12), buy("pro", T0 + 10 * DAY)], T0 + 11 * DAY);
  const left = 12 * PERIOD_MS - 10 * DAY;
  assert.equal(annual.until, T0 + 10 * DAY + PERIOD_MS + Math.floor((left * (290 / (12 * PERIOD_MS))) / (99 / PERIOD_MS)));
});

test("billing: a lower plan bought during a higher one adds time to the higher one", () => {
  const s = planAt([buy("pro", T0), buy("trader", T0 + DAY)], T0 + 2 * DAY);
  assert.equal(s.plan, "pro");
  assert.equal(s.until, T0 + PERIOD_MS + Math.floor(29 / (99 / PERIOD_MS)));
});

test("billing: purchases are folded in payment order, whatever order they come in", () => {
  const a = [buy("trader", T0), buy("pro", T0 + 5 * DAY), buy("pro", T0 + 6 * DAY)];
  assert.deepEqual(planAt([...a].reverse(), T0 + 7 * DAY), planAt(a, T0 + 7 * DAY));
});

test("gate: a free visitor gets the delayed, hourly, week-long shape, whatever is asked", () => {
  const g = gate(PLANS.free, "spreads", { resolution: "1m", from: "2021-01-01", to: String(T0 + DAY) }, T0);
  assert.equal(g.ok, true);
  assert.equal(g.method, "terminalSpreads");
  assert.deepEqual(g.args, { fromMs: T0 - 7 * DAY, toMs: T0 - 60 * 60_000, resolution: "1h" });
  assert.equal(g.meta.limited.length, 3);
  assert.deepEqual(gate(PLANS.free, "overview", {}, T0).args, { asOfMs: T0 - 3_600_000 });
  const t = gate(PLANS.free, "transfers", { min_xlm: "1000000" }, T0);
  assert.equal(t.args.minXlm, 50_000_000);
  assert.equal(t.args.toMs, T0 - 3_600_000);
  assert.equal(gate(PLANS.free, "alerts", {}, T0).args.toMs, T0 - 3_600_000);
});

test("gate: datasets a plan lacks are refused with the plan that opens them", () => {
  for (const [plan, ds, up] of [["free", "leverage", "trader"], ["free", "liquidation_feed", "trader"], ["free", "books", "trader"], ["free", "sdf", "trader"], ["pro", "labels", "institutional"]]) {
    const g = gate(PLANS[plan], ds, {}, T0);
    assert.deepEqual([g.ok, g.status, g.code, g.upgrade], [false, 403, "plan_required", up], `${plan} ${ds}`);
  }
  assert.equal(gate(PLANS.institutional, "labels", {}, T0).ok, true);
  assert.equal(gate(PLANS.pro, "nope", {}, T0).status, 404);
});

test("gate: paid plans are live, to their own bins and history", () => {
  const trader = gate(PLANS.trader, "liquidations", { resolution: "1m", from: String(T0 - 200 * DAY) }, T0);
  assert.deepEqual(trader.args, { fromMs: T0 - 90 * DAY, toMs: T0, resolution: "5m" });
  const pro = gate(PLANS.pro, "spreads", { resolution: "1m" }, T0);
  assert.deepEqual(pro.args, { fromMs: T0 - 6 * 3_600_000, toMs: T0, resolution: "1m" });
  assert.equal(pro.meta.limited, undefined);
  const inst = gate(PLANS.institutional, "books", { from: "2020-01-01", resolution: "1d" }, T0);
  assert.equal(inst.args.fromMs, Date.UTC(2020, 0, 1));
  assert.equal(gate(PLANS.institutional, "transfers", { min_xlm: "1000000" }, T0).args.minXlm, 1_000_000);
  assert.equal(gate(PLANS.pro, "liquidation_feed", { limit: "100000" }, T0).args.limit, 500);
});

test("gate: daily series by plan, and unreadable times are refused", () => {
  assert.deepEqual(gate(PLANS.free, "flows", { from: "2021-01-01" }, T0).args, { fromDay: new Date(T0 - 30 * DAY).toISOString().slice(0, 10) });
  assert.deepEqual(gate(PLANS.pro, "sdf", { from: "2021-01-01", to: "2026-01-31" }, T0).args, { fromDay: "2021-01-01", toDay: "2026-01-31" });
  assert.equal(gate(PLANS.pro, "spreads", { from: "yesterday" }, T0).code, "invalid_time");
  assert.equal(gate(PLANS.pro, "spreads", { resolution: "2m" }, T0).code, "invalid_resolution");
});
