// One-time HITZ/USD price history backfill into D1.
//
// The ingestion cron (functions/_lib/ingest.ts) keeps price data current in
// small increments; pulling ~12k pool events since launch in one Worker
// invocation would blow the Free-plan limits, so the initial load runs here.
// It uses the exact same model code as the cron (functions/_lib/price-model.ts).
//
//   1. Registered HITZ pools:  list_pools → get_tokens → quote token name()
//   2. Reserve history:        Stellar Expert pool events (update_reserves)
//   3. Quote prices:           Horizon hourly XLM/USDC (etc.) VWAP since launch
//   4. Price series:           price_hourly + the served snapshot
//
// Idempotent: reserves/pools use INSERT OR IGNORE / REPLACE, and pool
// cursors only move forward, so it's safe to re-run or to run after the
// cron has started.
//
// Usage (from frontend/):
//   node --experimental-strip-types scripts/backfill-prices.mjs --local
//   node --experimental-strip-types scripts/backfill-prices.mjs --remote

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as StellarSdk from "@stellar/stellar-sdk";
import {
  HOUR,
  canonicalEventId,
  classifyQuoteName,
  computeHours,
  decodeReservesBody,
  hourOf,
  mergeSnapshot,
  orientReserves,
} from "../functions/_lib/price-model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(here, "..");

// Mirrors wrangler.toml [vars].
const HITZ = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";
const RPC_URL = "https://soroban-rpc.mainnet.stellar.gateway.fm";
const HORIZON_URL = "https://horizon.stellar.org";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STELLAR_EXPERT = "https://api.stellar.expert/explorer/public";
const VIEW_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const SNAPSHOT_KEY = "price-history";
const MAX_STATEMENT_BYTES = 90_000;

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (!target) {
  console.error("usage: node --experimental-strip-types scripts/backfill-prices.mjs --local|--remote");
  process.exit(1);
}

const server = new StellarSdk.rpc.Server(RPC_URL);

async function view(contractId, method) {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(VIEW_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  })
    .addOperation(new StellarSdk.Contract(contractId).call(method))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${contractId}.${method} failed`);
  return StellarSdk.scValToNative(sim.result.retval);
}

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

// ─── 1. Pools ────────────────────────────────────────────────────────────────

const pools = [];
for (const address of await view(HITZ, "list_pools")) {
  if (!address.startsWith("C")) {
    console.log(`[backfill] skip ${address} (classic account — no price)`);
    continue;
  }
  let tokens;
  try {
    tokens = await view(address, "get_tokens");
  } catch {
    console.log(`[backfill] skip ${address} (no get_tokens — not an AMM)`);
    continue;
  }
  const hitzIndex = tokens.indexOf(HITZ);
  if (tokens.length !== 2 || hitzIndex < 0) continue;
  const quoteToken = tokens[1 - hitzIndex];
  const q = classifyQuoteName(String(await view(quoteToken, "name")), USDC_ISSUER);
  pools.push({ address, hitzIndex, quoteToken, quoteKind: q.kind, quoteId: q.quoteId, label: `HITZ/${q.symbol}` });
  console.log(`[backfill] pool ${address} ${`HITZ/${q.symbol}`} (${q.kind})`);
}

// ─── 2. Reserves ─────────────────────────────────────────────────────────────

const reserves = [];
const poolCursors = [];
for (const pool of pools) {
  let cursor = null;
  let count = 0;
  for (;;) {
    const url = `${STELLAR_EXPERT}/contract/${pool.address}/events?order=asc&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const records = (await getJson(url))._embedded?.records ?? [];
    for (const e of records) {
      if (e.topics?.[0] !== "update_reserves") continue;
      const pair = decodeReservesBody(e.bodyXdr);
      if (!pair) continue;
      const { hitz, quote } = orientReserves(pair, pool.hitzIndex);
      reserves.push({ pool: pool.address, ts: e.ts, eventId: canonicalEventId(e.id), hitz, quote });
      count++;
    }
    if (records.length) cursor = records[records.length - 1].paging_token;
    if (records.length < 200) break;
  }
  if (cursor) poolCursors.push([`pool:${pool.address}`, cursor]);
  console.log(`[backfill] ${pool.label}: ${count} reserve points`);
}
if (!reserves.length) throw new Error("no reserve history found");

// ─── 3. Quote prices ─────────────────────────────────────────────────────────

function assetParams(prefix, quoteId) {
  if (quoteId === "XLM") return `${prefix}_asset_type=native`;
  const [code, issuer] = quoteId === "USDC" ? ["USDC", USDC_ISSUER] : quoteId.split(":");
  const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return `${prefix}_asset_type=${type}&${prefix}_asset_code=${code}&${prefix}_asset_issuer=${issuer}`;
}

const firstHour = hourOf(Math.min(...reserves.map((r) => r.ts)));
const nowHour = hourOf(Date.now() / 1000);
const quotes = new Map();
for (const quoteId of new Set(pools.filter((p) => p.quoteKind === "native" || p.quoteKind === "classic").map((p) => p.quoteId))) {
  const series = [];
  let start = firstHour;
  while (start <= nowHour) {
    const url =
      `${HORIZON_URL}/trade_aggregations?${assetParams("base", quoteId)}&${assetParams("counter", "USDC")}` +
      `&resolution=3600000&start_time=${start * 1000}&end_time=${(nowHour + HOUR) * 1000}&order=asc&limit=200`;
    const records = (await getJson(url))._embedded?.records ?? [];
    // VWAP, not close: see the quote_prices note in migrations/0001_init.sql.
    for (const r of records) series.push([Math.floor(Number(r.timestamp) / 1000), Number(r.avg)]);
    if (records.length < 200) break;
    start = series[series.length - 1][0] + HOUR;
  }
  quotes.set(quoteId, series);
  console.log(`[backfill] ${quoteId}/USD: ${series.length} hourly VWAPs`);
}

// ─── 4. Series ───────────────────────────────────────────────────────────────

const priced = pools.filter((p) => p.quoteKind !== "unpriced");
const hours = computeHours({
  pools: priced,
  fromHour: firstHour,
  toHour: nowHour,
  reserves,
  seedReserves: new Map(),
  quotes,
  seedQuotes: new Map(),
});
const snapshot = mergeSnapshot(null, hours, priced, new Date().toISOString());
const [firstPoint, lastPoint] = [snapshot.points[0], snapshot.points.at(-1)];
console.log(
  `[backfill] ${hours.length} hourly prices: ${new Date(firstPoint[0] * 1000).toISOString()} $${firstPoint[1]} → ` +
    `${new Date(lastPoint[0] * 1000).toISOString()} $${lastPoint[1]}`
);
console.log("[backfill] current weights:", snapshot.pools.map((p) => `${p.pair} ${(p.weight * 100).toFixed(1)}%`).join(", "));

// ─── Write ───────────────────────────────────────────────────────────────────

const sql = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
function inserts(verb, table, columns, rows) {
  const head = `${verb} INTO ${table} (${columns.join(", ")}) VALUES\n`;
  const out = [];
  let batch = [];
  let size = head.length;
  for (const row of rows) {
    const tuple = `(${row.map(sql).join(", ")})`;
    if (batch.length && size + tuple.length + 2 > MAX_STATEMENT_BYTES) {
      out.push(head + batch.join(",\n") + ";");
      batch = [];
      size = head.length;
    }
    batch.push(tuple);
    size += tuple.length + 2;
  }
  if (batch.length) out.push(head + batch.join(",\n") + ";");
  return out;
}

const now = new Date().toISOString();
const statements = [
  ...inserts(
    "INSERT OR REPLACE",
    "pools",
    ["address", "hitz_index", "quote_token", "quote_kind", "quote_id", "label", "active"],
    pools.map((p) => [p.address, p.hitzIndex, p.quoteToken, p.quoteKind, p.quoteId, p.label, 1])
  ),
  ...inserts(
    "INSERT OR IGNORE",
    "pool_reserves",
    ["pool", "event_id", "ts", "hitz", "quote"],
    reserves.map((r) => [r.pool, r.eventId, r.ts, r.hitz.toString(), r.quote.toString()])
  ),
  ...inserts(
    "INSERT OR REPLACE",
    "quote_prices",
    ["quote", "hour", "usd"],
    [...quotes].flatMap(([id, series]) => series.map(([hour, usd]) => [id, hour, usd]))
  ),
  ...inserts("INSERT OR REPLACE", "price_hourly", ["hour", "price", "weights"], hours.map((h) => [h.hour, h.price, JSON.stringify(h.weights)])),
  ...inserts("INSERT OR REPLACE", "snapshots", ["key", "json", "updated_at"], [[SNAPSHOT_KEY, JSON.stringify(snapshot), now]]),
  // Pool cursors only move forward, so the cron never re-walks history.
  ...poolCursors.map(
    ([source, cursor]) =>
      `INSERT INTO cursors (source, cursor, updated_at) VALUES (${sql(source)}, ${sql(cursor)}, ${sql(now)}) ` +
      `ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at WHERE excluded.cursor > cursors.cursor;`
  ),
];

const file = join(mkdtempSync(join(tmpdir(), "hitz-prices-")), "backfill.sql");
writeFileSync(file, statements.join("\n\n") + "\n");
console.log(`[backfill] ${statements.length} statements → ${file}`);

const res = spawnSync("npx", ["--yes", "wrangler@4.87.0", "d1", "execute", "hitz-data", target, "--file", file], {
  cwd: frontendDir,
  stdio: "inherit",
});
process.exit(res.status ?? 1);
