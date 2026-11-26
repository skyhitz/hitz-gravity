// Which plan reaches further back than the viewer's, read from the plan table
// (functions/_lib/terminal/plans.ts), for the Terminal's plan notes (app/components/terminal/planReach.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { publicPlans } from "../functions/_lib/terminal/plans.ts";
import { furtherPlan } from "../app/components/terminal/planReach.ts";

const plans = publicPlans();

test("daily series: Trader's year, then Pro sees all of it", () => {
  assert.deepEqual(furtherPlan(plans, "trader", "daily_days"), { name: "Pro", all: true });
  assert.equal(furtherPlan(plans, "pro", "daily_days"), null);
});

test("intraday series: each plan's next step up", () => {
  assert.deepEqual(furtherPlan(plans, "free", "intraday_days"), { name: "Trader", all: false });
  assert.deepEqual(furtherPlan(plans, "trader", "intraday_days"), { name: "Pro", all: false });
  assert.deepEqual(furtherPlan(plans, "pro", "intraday_days"), { name: "Institutional", all: true });
  assert.equal(furtherPlan(plans, "institutional", "intraday_days"), null);
});

test("unknown plans or plan: no claim", () => {
  assert.equal(furtherPlan(null, "free", "intraday_days"), null);
  assert.equal(furtherPlan(plans, "nope", "intraday_days"), null);
});
