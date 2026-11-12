#!/usr/bin/env node
// Replay the arbitrage bot over past SDEX prices: the bot's own planner
// (planTrade and floorXlm from functions/_lib/arb.ts) and the vault's exact
// math (app/lib/vaultMath.ts), stepped through a price series at the cron's
// cadence. It answers "what would these settings have done", for choosing
// the profit floor and for the numbers in ARB_BOT.md. Method, data and
// results: ../research/arb-bot-replay/README.md.
//
// From frontend/ (after `pnpm install`), with Node 22.6 or later:
//
//   # 1. A price file: `ts,price` lines, unix seconds and USDC per XLM.
//   #    Anyone can build one from Horizon's public 5-minute trade averages:
//   node --experimental-strip-types scripts/arb-replay.mjs --fetch 2026-06-12 2026-11-11 > sdex.csv
//
//   # 2. The comparison: no bot, the first settings, the current defaults.
//   node --experimental-strip-types scripts/arb-replay.mjs sdex.csv
//
//   # One setting of your own:
//   node --experimental-strip-types scripts/arb-replay.mjs sdex.csv --min-profit 0.05 --min-bps 30
//
// Options:
//   --min-profit <xlm>  profit floor after fees (default: the bot's)
//   --min-bps <bps>     profit floor as a share of the trade (default: the bot's)
//   --max-trade <xlm>   largest trade (default: the bot's)
//   --cadence <s>       seconds between runs (default 300, the cron's)
//   --hedge-bps <bps>   what the SDEX leg costs against the mid, each way (default 8)
//   --fee <xlm>         network fees per round trip (default 0.0023)
//   --depth <x>         multiply the vault's reserves (default 1: Nov 11, 2026)
//   --from, --to <date> part of the series only
//   --json              the numbers as JSON
//
// What it leaves out: the SDEX leg always fills at its quote (the price moves
// under 0.05% in the seconds a leg takes), the bot is alone on the vault, and
// its funds never run short.

import { readFileSync } from "node:fs";
import { swap } from "../app/lib/vaultMath.ts";
import { DEFAULTS, floorXlm, planTrade } from "../functions/_lib/arb.ts";

const HORIZON = (process.env.HORIZON_URL ?? "https://horizon.stellar.org").replace(/\/$/, "");
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** The vault on Nov 11, 2026 (raw units, 7 decimals): the XLM pool, and the USDC pool's HITZ. */
const DEPTH = { xlmHitz: 509_693_908_169_577n, xlmReserve: 108_600_829_318n, usdcHitz: 374_510_844_986_055n };
const SAC = { XLM: "XLM", USDC: "USDC" };
const AMPLE = 1n << 62n;
/** A price older than this is no price: the run is skipped. */
const STALE_S = 900;

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const day = (text) => Math.floor(Date.parse(`${text}T00:00:00Z`) / 1000);

// ─── Prices ──────────────────────────────────────────────────────────────────

/** Horizon's 5-minute volume-weighted XLM/USDC trade averages, each stamped with the end of its 5 minutes. */
async function fetchSeries(from, to) {
  const lines = ["ts,price"];
  let url =
    `${HORIZON}/trade_aggregations?base_asset_type=native&counter_asset_type=credit_alphanum4&counter_asset_code=USDC` +
    `&counter_asset_issuer=${USDC_ISSUER}&resolution=300000&start_time=${day(from) * 1000}&end_time=${day(to) * 1000}&limit=200&order=asc`;
  while (url) {
    let body;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        body = await res.json();
        break;
      }
      if (attempt >= 5) throw new Error(`horizon ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    const records = body._embedded.records;
    for (const r of records) lines.push(`${Math.floor(Number(r.timestamp) / 1000) + 300},${r.avg}`);
    url = records.length === 200 ? body._links.next.href : null;
    process.stderr.write(`\r${lines.length - 1} prices`);
  }
  process.stderr.write("\n");
  return lines.join("\n");
}

function loadSeries(path) {
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [ts, price] = line.split(",").map(Number);
    if (Number.isFinite(ts) && price > 0) rows.push({ ts: ts > 1e11 ? Math.floor(ts / 1000) : ts, price });
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (!rows.length) throw new Error(`${path}: no "ts,price" rows`);
  return rows;
}

// ─── The replay ──────────────────────────────────────────────────────────────

const rateOf = ([x, u]) => Number(u.reserve) / Number(u.hitz) / (Number(x.reserve) / Number(x.hitz));
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/**
 * @param {{ ts: number, price: number }[]} series
 * @param {{ minProfitXlm: number, minProfitBps: number, maxTradeXlm: number, cadence: number, hedgeBps: number, feeXlm: number, depth: number, trade: boolean }} o
 */
export function replay(series, o) {
  const t0 = series[0].ts;
  const scale = (v) => BigInt(Math.round(Number(v) * o.depth));
  // Seeded at the market price, as the vault was.
  const usdcReserve = BigInt(Math.round(series[0].price * Number(DEPTH.xlmReserve) * (Number(DEPTH.usdcHitz) / Number(DEPTH.xlmHitz)) * o.depth));
  let pools = [
    { asset: SAC.XLM, hitz: scale(DEPTH.xlmHitz), reserve: scale(DEPTH.xlmReserve), deviation: 0n, updated: BigInt(t0) },
    { asset: SAC.USDC, hitz: scale(DEPTH.usdcHitz), reserve: usdcReserve, deviation: 0n, updated: BigInt(t0) },
  ];
  const cost = o.hedgeBps / 10_000;
  const s = { runs: 0, trades: 0, sellXlm: 0, sellUsdc: 0, profitXlm: 0, profitUsd: 0, vaultFeesUsd: 0, volumeUsd: 0, gap: 0, beyond2: 0, beyond5: 0, maxGap: 0 };
  const sizes = [];
  const margins = [];
  const waits = [];
  let lastTrade = null;
  let i = 0;
  for (let t = t0; t <= series[series.length - 1].ts; t += o.cadence) {
    while (i + 1 < series.length && series[i + 1].ts <= t) i++;
    if (t - series[i].ts > STALE_S) continue;
    const mid = series[i].price;
    const gap = Math.abs(Math.log(rateOf(pools) / mid));
    s.runs++;
    s.gap += gap;
    if (gap > 0.02) s.beyond2++;
    if (gap > 0.05) s.beyond5++;
    if (gap > s.maxGap) s.maxGap = gap;
    if (!o.trade) continue;
    const market = { bid: mid * (1 - cost), ask: mid * (1 + cost) };
    const plan = planTrade({ pools, now: BigInt(t), hitz: "HITZ", sac: SAC, balances: { xlm: AMPLE, usdc: AMPLE }, market, maxTradeXlm: o.maxTradeXlm });
    if (!plan || plan.profitXlm - o.feeXlm < floorXlm(plan, o)) continue;
    const done = swap(pools, SAC[plan.sell], SAC[plan.buy], plan.amountIn, BigInt(t));
    pools = done.pools;
    const earned = plan.profitXlm - o.feeXlm;
    const usdIn = (Number(plan.amountIn) / 1e7) * (plan.sell === "XLM" ? mid : 1);
    const kept = done.hops.reduce((k, h) => k * (1 - Number(h.feeRate) / 1e9), 1);
    s.trades++;
    s[plan.sell === "XLM" ? "sellXlm" : "sellUsdc"]++;
    s.profitXlm += earned;
    s.profitUsd += earned * mid;
    s.vaultFeesUsd += usdIn * (1 - kept);
    s.volumeUsd += usdIn;
    sizes.push(plan.notionalXlm);
    margins.push((100 * earned) / plan.notionalXlm);
    if (lastTrade !== null) waits.push((t - lastTrade) / 60);
    lastTrade = t;
  }
  for (const list of [sizes, margins, waits]) list.sort((a, b) => a - b);
  const days = (series[series.length - 1].ts - t0) / 86_400;
  const round = (x, digits = 2) => Number(x.toFixed(digits));
  return {
    days: round(days, 1),
    runs: s.runs,
    trades: s.trades,
    tradesPerDay: round(s.trades / days, 1),
    sellXlm: s.sellXlm,
    sellUsdc: s.sellUsdc,
    profitXlm: round(s.profitXlm),
    profitUsd: round(s.profitUsd),
    profitUsdPer30Days: round((s.profitUsd / days) * 30),
    profitXlmPerTrade: s.trades ? round(s.profitXlm / s.trades, 4) : 0,
    vaultFeesUsd: round(s.vaultFeesUsd),
    volumeUsd: round(s.volumeUsd, 0),
    avgGapPct: round((100 * s.gap) / s.runs),
    beyond2Pct: round((100 * s.beyond2) / s.runs, 0),
    beyond5Pct: round((100 * s.beyond5) / s.runs, 0),
    maxGapPct: round(100 * s.maxGap, 1),
    tradeXlm: { p5: round(quantile(sizes, 0.05)), median: round(quantile(sizes, 0.5)), p95: round(quantile(sizes, 0.95)), max: round(sizes[sizes.length - 1] ?? 0) },
    marginPct: { p5: round(quantile(margins, 0.05)), median: round(quantile(margins, 0.5)), p95: round(quantile(margins, 0.95)) },
    minutesBetweenTrades: { p10: round(quantile(waits, 0.1), 0), median: round(quantile(waits, 0.5), 0), p90: round(quantile(waits, 0.9), 0) },
  };
}

// ─── Command line ────────────────────────────────────────────────────────────

if (flag("fetch")) {
  const i = process.argv.indexOf("--fetch");
  const [from, to] = [process.argv[i + 1], process.argv[i + 2]];
  if (!from || !to || Number.isNaN(day(from)) || Number.isNaN(day(to))) {
    console.error("Usage: arb-replay.mjs --fetch <from YYYY-MM-DD> <to YYYY-MM-DD> > prices.csv");
    process.exit(1);
  }
  console.log(await fetchSeries(from, to));
  process.exit(0);
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: arb-replay.mjs <prices.csv> [options], or arb-replay.mjs --fetch <from> <to> > prices.csv");
  process.exit(1);
}
let series = loadSeries(file);
if (option("from")) series = series.filter((p) => p.ts >= day(option("from")));
if (option("to")) series = series.filter((p) => p.ts < day(option("to")));
const num = (name, fallback) => (option(name) === undefined ? fallback : Number(option(name)));
const base = {
  minProfitXlm: num("min-profit", DEFAULTS.minProfitXlm),
  minProfitBps: num("min-bps", DEFAULTS.minProfitBps),
  maxTradeXlm: num("max-trade", DEFAULTS.maxTradeXlm),
  cadence: num("cadence", 300),
  hedgeBps: num("hedge-bps", 8),
  feeXlm: num("fee", 0.0023),
  depth: num("depth", 1),
  trade: true,
};
const single = ["min-profit", "min-bps", "max-trade"].some((name) => option(name) !== undefined);
const runs = single
  ? [["these settings", base]]
  : [
      ["no bot", { ...base, trade: false }],
      // What PR #13 shipped: 0.05 XLM after a 0.02 XLM fee allowance, where the fees are really 0.0023.
      ["first settings (0.05 XLM floor, 0.02 fee guess)", { ...base, minProfitXlm: 0.05 + 0.02 - base.feeXlm, minProfitBps: 30 }],
      [`defaults (${DEFAULTS.minProfitXlm} XLM floor, real fees)`, base],
    ];
const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
const results = runs.map(([name, o]) => ({ name, ...replay(series, o) }));
if (flag("json")) {
  console.log(JSON.stringify({ from: iso(series[0].ts), to: iso(series[series.length - 1].ts), prices: series.length, settings: base, results }, null, 2));
} else {
  console.log(`${series.length} prices, ${iso(series[0].ts)} to ${iso(series[series.length - 1].ts)} UTC; a run every ${base.cadence} s; depth x${base.depth}; SDEX leg ${base.hedgeBps} bps from the mid; fees ${base.feeXlm} XLM a round trip\n`);
  const row = (cells) => `| ${cells.join(" | ")} |`;
  console.log(row(["", "Trades", "A day", "Bot profit", "Per 30 days", "Fees into the vault", "Vault off the SDEX, on average", "Over 2% off", "Over 5% off"]));
  console.log(row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const r of results) {
    console.log(row([r.name, r.trades, r.tradesPerDay, `${r.profitXlm} XLM ($${r.profitUsd})`, `$${r.profitUsdPer30Days}`, `$${r.vaultFeesUsd}`, `${r.avgGapPct}%`, `${r.beyond2Pct}% of the time`, `${r.beyond5Pct}%`]));
  }
  for (const r of results.filter((x) => x.trades)) {
    console.log(`\n${r.name}: ${r.sellXlm} trades sold XLM, ${r.sellUsdc} sold USDC; $${r.volumeUsd} traded; ${r.profitXlmPerTrade} XLM a trade.`);
    console.log(`  size in XLM: median ${r.tradeXlm.median} (5% under ${r.tradeXlm.p5}, 5% over ${r.tradeXlm.p95}, largest ${r.tradeXlm.max})`);
    console.log(`  profit as a share of the trade: median ${r.marginPct.median}% (5% under ${r.marginPct.p5}%, 5% over ${r.marginPct.p95}%)`);
    console.log(`  minutes between trades: median ${r.minutesBetweenTrades.median} (a tenth under ${r.minutesBetweenTrades.p10}, a tenth over ${r.minutesBetweenTrades.p90}); furthest off the SDEX: ${r.maxGapPct}%`);
  }
}
