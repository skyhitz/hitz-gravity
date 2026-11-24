// The HITZ Terminal's number and time formats (app/components/terminal/format.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { day, dayYear } from "../app/components/terminal/format.ts";

test("dayYear names the year, from an ISO day or ms", () => {
  assert.equal(dayYear("2025-11-24"), "Nov 24, 2025");
  assert.equal(dayYear(Date.UTC(2021, 0, 1)), "Jan 1, 2021");
  assert.equal(dayYear(null), "n/a");
  assert.equal(dayYear(undefined), "n/a");
});

test("day stays without the year", () => {
  assert.equal(day("2025-11-24"), "Nov 24");
});
