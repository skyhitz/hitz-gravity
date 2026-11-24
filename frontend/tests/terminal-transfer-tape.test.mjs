// The terminal's transfer tape (app/components/terminal/transferTape.ts): the "Institutional and whale
// flows" card's rows, newest first, while the live poll adds new transfers on top and scrolling pages
// older ones in, with no row lost, doubled or silently skipped.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_FROM, asking, dayGroups, emptyTape, failed, HEAD_ROWS, HEAD_SPAN_MS, mergeRows, olderQuery, PAGE_ROWS, withHead, withOlder } from "../app/components/terminal/transferTape.ts";

const row = (op_id, closed_at, extra = {}) => ({ op_id, closed_at, ...extra });
const ids = (t) => t.rows.map((r) => r.op_id);
const HEAD = { plan: "trader", from: "2026-11-17T12:00:00.000Z", to: "2026-11-24T12:00:00.000Z" };
const TRADER_PAGE = { plan: "trader", from: "2026-08-26T12:00:00.000Z", to: "2026-11-23T10:00:00.000Z" };
const first = (rows, meta = HEAD) => withHead(emptyTape(), rows, meta);

test("the sizes the card asks for", () => {
  assert.deepEqual([HEAD_ROWS, HEAD_SPAN_MS, PAGE_ROWS, ALL_FROM], [50, 7 * 86_400_000, 100, "2015-01-01"]);
});

test("mergeRows keeps one row per transfer, newest first, the fresh copy winning", () => {
  const held = [row("30", "2026-11-24T10:00:00Z"), row("20", "2026-11-23T10:00:00Z", { to_name: null })];
  const fresh = [row("20", "2026-11-23T10:00:00Z", { to_name: "Kraken" }), row("10", "2026-11-22T10:00:00Z"), row("21", "2026-11-23T10:00:00Z")];
  const m = mergeRows(held, fresh);
  assert.deepEqual(m.map((r) => r.op_id), ["30", "21", "20", "10"]);
  assert.equal(m[2].to_name, "Kraken");
  assert.deepEqual(mergeRows([], [row("99", "2026-11-23T10:00:00Z"), row("100", "2026-11-23T10:00:00Z")]).map((r) => r.op_id), ["100", "99"], "op ids compare as numbers");
});

test("the first head fills the tape", () => {
  const t = first([row("1", "2026-11-23T10:00:00Z"), row("2", "2026-11-24T10:00:00Z")]);
  assert.deepEqual(ids(t), ["2", "1"]);
  assert.deepEqual([t.plan, t.status, t.topMs, t.end, t.gen], ["trader", "more", Date.parse(HEAD.to), null, 1]);
});

test("a later head adds new transfers on top and keeps rows that left it", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z"), row("1", "2026-11-23T10:00:00Z")]);
  const u = withHead(t, [row("3", "2026-11-24T11:00:00Z"), row("2", "2026-11-24T10:00:00Z")], { ...HEAD, to: "2026-11-24T12:02:00.000Z" }, 2);
  assert.deepEqual(ids(u), ["3", "2", "1"]);
  assert.deepEqual([u.gen, u.topMs], [t.gen, Date.parse("2026-11-24T12:02:00.000Z")]);
});

test("a quiet week keeps the tape: a head that isn't full covers its whole window, even empty", () => {
  let t = first([]);
  t = withOlder(t, t.gen, [row("1", "2026-10-01T00:00:00Z")], TRADER_PAGE);
  const u = withHead(t, [], { plan: "trader", from: "2026-11-17T12:02:00.000Z", to: "2026-11-24T12:02:00.000Z" });
  assert.deepEqual(ids(u), ["1"]);
  assert.deepEqual([u.gen, u.status], [t.gen, "end"]);
});

test("after a long sleep the tape starts over from the head instead of leaving a gap", () => {
  const t = first([row("1", "2026-11-23T00:00:00Z")]);
  const late = withHead(t, [row("5", "2026-12-01T00:00:00Z")], { plan: "trader", from: "2026-11-27T12:00:00.000Z", to: "2026-12-04T12:00:00.000Z" });
  assert.deepEqual(ids(late), ["5"]);
  assert.deepEqual([late.gen, late.status, late.end], [t.gen + 1, "more", null]);
  const full = withHead(t, [row("9", "2026-11-27T10:00:00Z"), row("8", "2026-11-26T10:00:00Z")], { ...HEAD, to: "2026-11-27T12:00:00.000Z" }, 2);
  assert.deepEqual([ids(full), full.gen], [["9", "8"], t.gen + 1]);
});

test("another plan starts the tape over", () => {
  const t = first([row("1", "2026-11-23T00:00:00Z")]);
  const pro = withHead(t, [row("2", "2026-11-24T00:00:00Z")], { ...HEAD, plan: "pro" });
  assert.deepEqual([ids(pro), pro.plan, pro.gen], [["2"], "pro", t.gen + 1]);
});

test("olderQuery asks for the page before the oldest row, from the next whole minute", () => {
  assert.deepEqual(olderQuery(emptyTape()), { from: "2015-01-01", limit: 100 });
  const t = first([row("2", "2026-11-24T10:00:00Z"), row("1", "2026-11-23T09:59:30Z")]);
  assert.deepEqual(olderQuery(t), { from: "2015-01-01", to: Date.parse("2026-11-23T10:00:00Z"), limit: 100 });
  assert.equal(olderQuery(first([row("1", "2026-11-23T09:59:00Z")])).to, Date.parse("2026-11-23T10:00:00Z"), "a row on the minute is asked for again");
  assert.equal(olderQuery({ ...t, strict: true }).to, Date.parse("2026-11-23T09:59:30Z"));
});

test("a full page adds older rows, the overlap once", () => {
  let t = first([row("3", "2026-11-24T10:00:00Z"), row("2", "2026-11-23T09:59:30Z")]);
  t = asking(t, t.gen);
  assert.equal(t.status, "loading");
  t = withOlder(t, t.gen, [row("2", "2026-11-23T09:59:30Z"), row("1", "2026-11-22T00:00:00Z")], TRADER_PAGE, 2);
  assert.deepEqual(ids(t), ["3", "2", "1"]);
  assert.deepEqual([t.status, t.strict, t.end], ["more", false, null]);
});

test("a short page ends the tape at the plan's reach or the start of the record", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z")]);
  const cut = withOlder(t, t.gen, [row("1", "2026-09-01T00:00:00Z")], TRADER_PAGE);
  assert.deepEqual([ids(cut), cut.status], [["2", "1"], "end"]);
  assert.deepEqual(cut.end, { plan: "trader", from: "2026-08-26T12:00:00.000Z", cut: true });
  const inst = first([row("2", "2026-11-24T10:00:00Z")], { ...HEAD, plan: "institutional" });
  const record = withOlder(inst, inst.gen, [], { plan: "institutional", from: "2015-01-01T00:00:00.000Z" });
  assert.deepEqual(record.end, { plan: "institutional", from: "2015-01-01T00:00:00.000Z", cut: false });
});

test("a full page that adds nothing asks strictly before the oldest row next", () => {
  const minute = [row("12", "2026-11-23T10:00:05Z"), row("11", "2026-11-23T10:00:01Z")];
  let t = withOlder(first(minute), 1, minute, TRADER_PAGE, 2);
  assert.deepEqual([t.status, t.strict], ["more", true]);
  assert.equal(olderQuery(t).to, Date.parse("2026-11-23T10:00:01Z"));
  t = withOlder(t, t.gen, [row("10", "2026-11-23T09:00:00Z"), row("9", "2026-11-23T08:00:00Z")], TRADER_PAGE, 2);
  assert.equal(t.strict, false);
});

test("answers asked for before a restart are dropped", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z")]);
  const stale = t.gen - 1;
  assert.equal(asking(t, stale), t);
  assert.equal(withOlder(t, stale, [row("1", "2026-11-01T00:00:00Z")], TRADER_PAGE), t);
  assert.equal(failed(t, stale, "boom"), t);
});

test("a failed page says why and keeps the rows", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z")]);
  const f = failed(asking(t, t.gen), t.gen, "Too many requests for now.");
  assert.deepEqual([f.status, f.error, ids(f)], ["error", "Too many requests for now.", ["2"]]);
  assert.deepEqual([asking(f, f.gen).status, asking(f, f.gen).error], ["loading", null]);
});

test("a page read under another plan is not merged", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z")]);
  const u = withOlder(t, t.gen, [row("1", "2026-11-20T00:00:00Z")], { plan: "free", from: "2026-11-17T12:00:00.000Z" });
  assert.deepEqual([ids(u), u.status], [["2"], "error"]);
});

test("dayGroups splits the rows by UTC day", () => {
  const g = dayGroups([row("3", "2026-11-24T00:10:00Z"), row("2", "2026-11-23T23:59:59Z"), row("1", "2026-11-23T00:00:00Z")]);
  assert.deepEqual(g.map((d) => [d.day, d.rows.map((r) => r.op_id)]), [["2026-11-24", ["3"]], ["2026-11-23", ["2", "1"]]]);
  assert.deepEqual(dayGroups([]), []);
});
