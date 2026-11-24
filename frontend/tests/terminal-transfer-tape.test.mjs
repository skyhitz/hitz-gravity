// The terminal's transfer tape (app/components/terminal/transferTape.ts): the "Institutional and whale
// flows" card's rows, newest first, while the live poll adds new transfers on top and scrolling pages
// older ones in, with no row lost, doubled or silently skipped.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_FROM, asking, dayGroups, emptyTape, failed, footerAction, HEAD_ROWS, HEAD_SPAN_MS, mergeRows, olderQuery, PAGE_ROWS, withHead, withOlder } from "../app/components/terminal/transferTape.ts";
import { data } from "../app/lib/terminal.ts";
import { handleTerminal } from "../functions/_lib/terminal/routes.ts";
import { testDb } from "./helpers/d1.mjs";
import { fakeKv } from "./helpers/kv.mjs";

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

test("the footer keeps one button through more, loading and error, so keyboard focus stays on it", () => {
  const t = first([row("2", "2026-11-24T10:00:00Z")]);
  assert.deepEqual(footerAction(t), { label: "Load older transfers", busy: false, error: null });
  const loading = asking(t, t.gen);
  assert.deepEqual(footerAction(loading), { label: "Loading older transfers…", busy: true, error: null });
  assert.deepEqual(footerAction(failed(loading, t.gen, "Too many requests for now.")), { label: "Try again", busy: false, error: "Too many requests for now." });
  assert.equal(footerAction(withOlder(t, t.gen, [], TRADER_PAGE)), null, "the end has no button");
});

test("dayGroups splits the rows by UTC day", () => {
  const g = dayGroups([row("3", "2026-11-24T00:10:00Z"), row("2", "2026-11-23T23:59:59Z"), row("1", "2026-11-23T00:00:00Z")]);
  assert.deepEqual(g.map((d) => [d.day, d.rows.map((r) => r.op_id)]), [["2026-11-24", ["3"]], ["2026-11-23", ["2", "1"]]]);
  assert.deepEqual(dayGroups([]), []);
});

// ─── End to end ───────────────────────────────────────────────────────────────
// Through the real API (functions/_lib/terminal/routes.ts and the plan gate) with a fake data worker that
// answers the way terminalQueries.transfers does: what each plan sees when it scrolls to the end, every
// transfer once, in order. Three transfers share each second, so page edges split them.

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACCOUNT = `G${"A".repeat(55)}`;
const isoSecond = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
let nextOp = 1_000_000;

/** `per` transfers of `xlm` sharing a second, every `everyMs`, 17 seconds past the minute, up to NOW. */
const series = (fromMs, everyMs, per, xlm) => {
  const rows = [];
  for (let t = fromMs + 17_000; t < NOW; t += everyMs) for (let i = 0; i < per; i++) rows.push({ op_id: String(nextOp++), closed_at: isoSecond(t), xlm, flow_class: "to_exchange" });
  return rows;
};

function serve(rows, plan) {
  const db = testDb();
  if (plan !== "free") db.raw.prepare("INSERT INTO terminal_grants (account, plan, until, note, created_at) VALUES (?, ?, NULL, 'test', ?)").run(ACCOUNT, plan, NOW - 1000);
  const market = {
    async terminalTransfers({ fromMs, toMs, minXlm, limit }) {
      const to = Math.min(toMs ?? NOW, NOW);
      const from = Math.min(to, Math.max(fromMs ?? to - 7 * DAY, to - 400 * DAY));
      const hits = rows.filter((r) => r.closed_at >= isoSecond(from) && r.closed_at < isoSecond(to) && r.xlm >= Math.max(1_000_000, minXlm ?? 10_000_000));
      // ORDER BY closed_at DESC: transfers sharing a second come back in any order (here, oldest op id first).
      hits.sort((a, b) => b.closed_at.localeCompare(a.closed_at) || Number(a.op_id) - Number(b.op_id));
      return { window: { fromMs: from, toMs: to, minXlm }, rows: hits.slice(0, Math.min(500, limit ?? 100)) };
    },
  };
  const cache = new Map();
  const deps = {
    db,
    market,
    chain: () => {
      throw new Error("no chain here");
    },
    secret: "e".repeat(64),
    passphrase: "Public Global Stellar Network ; September 2015",
    appUrl: "https://skyhitz.io",
    kv: fakeKv(),
    emailAccount: async () => (plan === "free" ? null : ACCOUNT),
    horizonAccount: async () => null,
    send: async () => 200,
    cache: { match: async (k) => cache.get(k)?.clone(), put: async (k, r) => void cache.set(k, r) },
    nowMs: NOW,
    waitUntil: (p) => p,
  };
  globalThis.fetch = async (url, init) => handleTerminal(new Request(`https://skyhitz.io${url}`, init), deps);
}

/** What the card does: the head, then older pages until the tape ends. */
async function scrollToEnd() {
  const head = await data("transfers", { limit: HEAD_ROWS, from: NOW - HEAD_SPAN_MS });
  assert.ok(head.ok, JSON.stringify(head));
  let t = withHead(emptyTape(), head.data.rows, head.meta);
  for (let pages = 0; t.status === "more"; pages++) {
    assert.ok(pages < 100, "the tape reaches an end");
    const r = await data("transfers", olderQuery(t));
    assert.ok(r.ok, JSON.stringify(r));
    t = withOlder(t, t.gen, r.data.rows, r.meta);
  }
  return t;
}

const expected = (rows, fromMs, toMs, min) =>
  rows
    .filter((r) => r.closed_at >= isoSecond(fromMs) && r.closed_at < isoSecond(toMs) && r.xlm >= min)
    .sort((a, b) => b.closed_at.localeCompare(a.closed_at) || Number(b.op_id) - Number(a.op_id))
    .map((r) => r.op_id);

test("Free scrolls through its week of 50M+ transfers, an hour behind, each once", async () => {
  const rows = [...series(NOW - 10 * DAY, HOUR, 3, 60_000_000), ...series(NOW - 10 * DAY, 2 * HOUR, 1, 20_000_000)];
  serve(rows, "free");
  const t = await scrollToEnd();
  assert.deepEqual(ids(t), expected(rows, NOW - 7 * DAY, NOW - HOUR, 50_000_000));
  assert.deepEqual(t.end, { plan: "free", from: new Date(NOW - 7 * DAY).toISOString(), cut: true });
});

test("Trader scrolls back 90 days of 10M+ transfers, each once", async () => {
  const rows = [...series(NOW - 120 * DAY, 3 * HOUR, 3, 12_000_000), ...series(NOW - 120 * DAY, 5 * HOUR, 1, 2_000_000)];
  serve(rows, "trader");
  const t = await scrollToEnd();
  assert.deepEqual(ids(t), expected(rows, NOW - 90 * DAY, NOW, 10_000_000));
  assert.deepEqual(t.end, { plan: "trader", from: new Date(NOW - 90 * DAY).toISOString(), cut: true });
});

test("Institutional scrolls past the data worker's 400 days to the start of the record", async () => {
  const rows = series(NOW - 900 * DAY, 11 * HOUR, 2, 1_500_000);
  serve(rows, "institutional");
  const t = await scrollToEnd();
  assert.deepEqual(ids(t), expected(rows, 0, NOW, 1_000_000));
  assert.deepEqual(t.end, { plan: "institutional", from: "2015-01-01T00:00:00.000Z", cut: false });
});
