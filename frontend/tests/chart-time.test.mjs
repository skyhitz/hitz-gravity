// The time labels of the shared chart (app/components/TimeSeriesChart.tsx): the Monitor cards and the
// HITZ Terminal's panels. Spans over 300 days (the Terminal's SDF supply on 1Y, 3Y and All) name the
// month and year on the axis; shorter ones keep today's day and time labels.

import assert from "node:assert/strict";
import { test } from "node:test";
import { axisLabel, fmtDate, fmtDateTime, fmtDay, LONG_SPAN_S } from "../app/components/chartTime.ts";

const s = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;
const DAY = 86_400;

test("spans over 300 days label the axis by month and year", () => {
  assert.equal(axisLabel(s(2024, 1, 15), 3 * 365 * DAY, 1000), "Jan 2024");
  assert.equal(axisLabel(s(2026, 4, 9), 364 * DAY, 365), "Apr 2026");
});

test("spans up to 300 days keep day labels (the Monitor cards)", () => {
  assert.equal(axisLabel(s(2026, 9, 21), 213 * DAY, 5114), "Sep 21");
  assert.equal(axisLabel(s(2026, 9, 21), LONG_SPAN_S, 300), "Sep 21");
  assert.equal(axisLabel(s(2026, 9, 21), 89 * DAY, 90), "Sep 21");
});

test("short hourly spans keep the time", () => {
  assert.equal(axisLabel(s(2026, 9, 21, 14), DAY, 24), "Sep 21, 14:00");
});

test("point formats", () => {
  assert.equal(fmtDay(s(2021, 1, 30)), "Jan 30, 2021");
  assert.equal(fmtDate(s(2021, 1, 30)), "Jan 30");
  assert.equal(fmtDateTime(s(2026, 9, 21, 14)), "Sep 21, 14:00 UTC");
});
