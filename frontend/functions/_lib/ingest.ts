// Ingestion cron — every 5 minutes (wrangler.toml [triggers]).
//
// Replaces the daily GitHub Action that appended to reports/data/*.json(l).
// Each run does a small, bounded slice of work so it fits the Workers Free
// limits (50 subrequests, ~10 ms CPU); anything left over is picked up by
// the next run. Steps are independent — one failing never blocks the rest.
//
//   1. HITZ contract events  — Soroban RPC getEvents → hitz_events
//   2. Report enrichment     — Horizon tx envelopes → tx_info,
//                              Stellar Expert contract metadata → contract_info
//   3. Pool registry         — list_pools → get_tokens → quote name() → pools
//   4. Pool reserves         — Stellar Expert pool events (update_reserves)
//   5. Quote prices          — Horizon hourly VWAP vs USDC
//   6. Price series          — recompute changed hours → price_hourly + snapshot
//   7. Liquidity             — depth, volume, fees, TVL trend (last 30 days) → snapshot

import * as StellarSdk from "@stellar/stellar-sdk";
import { existing, getCursor, insertMany, setCursor } from "./db";
import {
  HOUR,
  canonicalEventId,
  classifyQuoteName,
  computeHours,
  decodeReservesBody,
  hourOf,
  mergeSnapshot,
  orientReserves,
  summarizeLiquidity,
  type LiquiditySnapshot,
  type PoolMeta,
  type PriceSnapshot,
  type QuoteKind,
  type ReservePoint,
} from "./price-model";
import { simulateView } from "./stellar";
import type { Env } from "./types";

const STELLAR_EXPERT = "https://api.stellar.expert/explorer/public";

// Per-run budgets (subrequests are the binding constraint).
const HITZ_EVENT_PAGES = 5;
const ENRICH_SCAN = 200;
const TX_LOOKUPS = 12;
const CONTRACT_LOOKUPS = 4;
const POOL_PAGES = 2;
const QUOTE_PAGES = 2;

export const PRICE_SNAPSHOT_KEY = "price-history";
export const LIQUIDITY_SNAPSHOT_KEY = "liquidity";

/** Liquidity metrics look back 30 days: bounded reads no matter how old the pools get. */
const LIQUIDITY_WINDOW_S = 30 * 86_400;

export async function runIngest(env: Env): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      report[name] = await fn();
    } catch (err) {
      report[name] = { error: err instanceof Error ? err.message : String(err) };
      console.error(`[ingest] ${name} failed`, err);
    }
  };

  await step("hitzEvents", () => ingestHitzEvents(env));
  await step("enrichment", () => enrich(env));

  let changedFrom: number | null = null;
  const bump = (h: number | null) => {
    if (h !== null) changedFrom = changedFrom === null ? h : Math.min(changedFrom, h);
  };
  await step("pools", async () => {
    const r = await syncPools(env);
    bump(r.changedFrom);
    return r;
  });
  await step("quotes", async () => {
    const r = await syncQuotes(env);
    bump(r.changedFrom);
    return r;
  });
  await step("price", () => rebuildPrice(env, changedFrom));
  await step("liquidity", () => rebuildLiquidity(env, changedFrom));
  return report;
}

// ─── 1. HITZ contract events ─────────────────────────────────────────────────
// Row shape and decoding mirror what scripts/contract-report.mjs wrote to
// events.jsonl, so reports read identical data.

interface EventRow {
  ledger: number;
  ts: string;
  txHash: string;
  id: string;
  name: string;
  topics: unknown[];
  data: unknown;
}

/** JSON with bigints as strings (scValToNative yields bigint for i128/u128). */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function decodeScVal(scv: StellarSdk.xdr.ScVal | string | null | undefined): unknown {
  if (scv == null) return null;
  if (typeof scv === "string") {
    return StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(scv, "base64"));
  }
  return StellarSdk.scValToNative(scv);
}

function parseEvent(evt: StellarSdk.rpc.Api.EventResponse): EventRow {
  const topics = (evt.topic ?? []).map(decodeScVal);
  let name = typeof topics[0] === "string" ? topics[0] : String(topics[0] ?? "");
  // #[contractevent] structs publish `<snake_name>_event`; reports use the bare name.
  if (name.endsWith("_event")) name = name.slice(0, -"_event".length);
  return {
    ledger: evt.ledger,
    ts: evt.ledgerClosedAt,
    txHash: evt.txHash,
    id: evt.id,
    name,
    topics: topics.slice(1),
    data: evt.value ? decodeScVal(evt.value) : null,
  };
}

/** The TOID in a cursor packs the ledger sequence in its high 32 bits. */
function cursorLedger(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    return Number(BigInt(cursor.split("-")[0]) >> 32n);
  } catch {
    return null;
  }
}

async function ingestHitzEvents(env: Env) {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const filters = [{ type: "contract" as const, contractIds: [env.HITZ_CONTRACT_ID] }];
  let cursor = await getCursor(env.DB, "hitz-rpc");
  let inserted = 0;
  let pages = 0;

  for (; pages < HITZ_EVENT_PAGES; pages++) {
    let page: StellarSdk.rpc.Api.GetEventsResponse;
    try {
      page = cursor
        ? await server.getEvents({ filters, cursor, limit: 200 })
        : await server.getEvents({
            filters,
            startLedger: Math.max(1, (await server.getLatestLedger()).sequence - 100_000),
            limit: 200,
          });
    } catch (err) {
      // Cursor older than the RPC's retention: restart from the retention
      // floor. Dedup by id makes the overlap safe. (If this ever fires,
      // events between the old cursor and the floor were not captured.)
      if (cursor && /within.*range|outside.*window|must be|retention/i.test(String(err))) {
        console.warn(`[ingest] hitz-rpc cursor ${cursor} is stale — restarting from retention floor`);
        cursor = null;
        continue;
      }
      throw err;
    }

    const rows = page.events.map(parseEvent);
    await insertMany(
      env.DB,
      "INSERT OR IGNORE",
      "hitz_events",
      ["id", "ledger", "ts", "tx_hash", "name", "topics", "data"],
      rows.map((e) => [e.id, e.ledger, e.ts, e.txHash, e.name, toJson(e.topics), toJson(e.data)])
    );
    inserted += rows.length;

    if (page.cursor) {
      cursor = page.cursor;
      await setCursor(env.DB, "hitz-rpc", cursor);
    }
    // A short or empty page means "end of this scan chunk", not "done".
    // Only the cursor reaching the chain tip means caught up.
    const at = cursorLedger(page.cursor);
    if (!page.cursor || at === null || at >= page.latestLedger) break;
  }
  return { seen: inserted, pages: pages + 1, cursor };
}

// ─── 2. Report enrichment ────────────────────────────────────────────────────
// Walks hitz_events behind an `enrich` cursor and fills tx_info /
// contract_info exactly as scripts/contract-report.mjs used to on demand
// (same fields). Permanent misses (HTTP 404) are cached as {error: true}
// like before; transient failures stop the walk so it retries next run.

interface Lookup {
  kind: "tx" | "contract";
  key: string;
}

async function lookupTx(env: Env, hash: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${env.HORIZON_URL}/transactions/${hash}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { error: true };
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown> & {
    inner_transaction?: { source_account?: string };
  };
  return {
    sourceAccount: body.source_account ?? null,
    feeAccount: body.fee_account ?? body.source_account ?? null,
    successful: body.successful ?? null,
    operationCount: body.operation_count ?? null,
    innerSource: body.inner_transaction?.source_account ?? null,
    isFeeBump: !!body.inner_transaction,
  };
}

async function lookupContract(id: string): Promise<Record<string, unknown> | null> {
  const lookedUpAt = new Date().toISOString();
  const res = await fetch(`${STELLAR_EXPERT}/contract/${id}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { error: true, lookedUpAt };
  if (!res.ok) return null;
  const body = (await res.json()) as Record<string, unknown> & {
    validation?: { status?: string; repository?: string };
  };
  return {
    creator: body.creator ?? null,
    created: body.created ?? null,
    validation: body.validation?.status ?? null,
    validationRepo: body.validation?.repository ?? null,
    versionsAtLookup: body.versions ?? null,
    subinvocationAtLookup: body.subinvocation ?? null,
    lookedUpAt,
  };
}

function isContractAddr(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("C") && v.length === 56;
}

async function enrich(env: Env) {
  const after = (await getCursor(env.DB, "enrich")) ?? "";
  const { results: events } = await env.DB.prepare(
    "SELECT id, tx_hash, name, topics FROM hitz_events WHERE id > ? ORDER BY id LIMIT ?"
  )
    .bind(after, ENRICH_SCAN)
    .all<{ id: string; tx_hash: string; name: string; topics: string }>();
  if (!events.length) return { scanned: 0 };

  // What each event needs, mirroring the report: tx info for transfers,
  // contract info for C-addresses in transfer / vault topics.
  const needs = events.map((e) => {
    const topics = JSON.parse(e.topics) as unknown[];
    const out: Lookup[] = [];
    if (e.name === "transfer") {
      out.push({ kind: "tx", key: e.tx_hash });
      for (const t of topics.slice(0, 2)) if (isContractAddr(t)) out.push({ kind: "contract", key: t });
    } else if (e.name === "vaulted" && isContractAddr(topics[0])) {
      out.push({ kind: "contract", key: topics[0] });
    }
    return out;
  });
  const knownTx = await existing(env.DB, "tx_info", "hash", [
    ...new Set(needs.flat().filter((n) => n.kind === "tx").map((n) => n.key)),
  ]);
  const knownContracts = await existing(env.DB, "contract_info", "address", [
    ...new Set(needs.flat().filter((n) => n.kind === "contract").map((n) => n.key)),
  ]);

  // Plan lookups in event order until the budget runs out; the cursor only
  // advances past events whose lookups all fit.
  const planned = new Map<string, Lookup>();
  let txBudget = TX_LOOKUPS;
  let contractBudget = CONTRACT_LOOKUPS;
  let lastCovered = -1;
  for (let i = 0; i < events.length; i++) {
    const missing = needs[i].filter(
      (n) =>
        !planned.has(`${n.kind}:${n.key}`) &&
        !(n.kind === "tx" ? knownTx : knownContracts).has(n.key)
    );
    const tx = missing.filter((n) => n.kind === "tx").length;
    const c = missing.filter((n) => n.kind === "contract").length;
    if (tx > txBudget || c > contractBudget) break;
    txBudget -= tx;
    contractBudget -= c;
    for (const n of missing) planned.set(`${n.kind}:${n.key}`, n);
    lastCovered = i;
  }

  const lookups = [...planned.values()];
  const results = await Promise.all(
    lookups.map((n) => (n.kind === "tx" ? lookupTx(env, n.key) : lookupContract(n.key)).catch(() => null))
  );
  const txRows: unknown[][] = [];
  const contractRows: unknown[][] = [];
  const failed = new Set<string>();
  lookups.forEach((n, i) => {
    const info = results[i];
    if (!info) failed.add(`${n.kind}:${n.key}`);
    else (n.kind === "tx" ? txRows : contractRows).push([n.key, JSON.stringify(info)]);
  });
  await insertMany(env.DB, "INSERT OR IGNORE", "tx_info", ["hash", "info"], txRows);
  await insertMany(env.DB, "INSERT OR IGNORE", "contract_info", ["address", "info"], contractRows);

  // Stop the cursor before the first event with a transient failure.
  let advanceTo = lastCovered;
  for (let i = 0; i <= lastCovered; i++) {
    if (needs[i].some((n) => failed.has(`${n.kind}:${n.key}`))) {
      advanceTo = i - 1;
      break;
    }
  }
  if (advanceTo >= 0) await setCursor(env.DB, "enrich", events[advanceTo].id);
  return { scanned: advanceTo + 1, txAdded: txRows.length, contractsAdded: contractRows.length, failed: failed.size };
}

// ─── 3 + 4. Pool registry and reserves ───────────────────────────────────────

interface PoolRow {
  address: string;
  hitz_index: number;
  quote_token: string;
  quote_kind: QuoteKind;
  quote_id: string | null;
  label: string;
  active: number;
}

export function toPoolMeta(r: PoolRow): PoolMeta {
  return { address: r.address, hitzIndex: r.hitz_index, quoteKind: r.quote_kind, quoteId: r.quote_id, label: r.label };
}

interface ExpertEvent {
  id: string;
  ts: number;
  topics: string[];
  bodyXdr: string;
  paging_token: string;
}

async function syncPools(env: Env) {
  const registered = new Set(((await simulateView(env, env.HITZ_CONTRACT_ID, "list_pools")) as string[]) ?? []);
  const { results: known } = await env.DB.prepare("SELECT * FROM pools").all<PoolRow>();
  const knownSet = new Set(known.map((p) => p.address));

  // New registrations that are AMMs pairing HITZ. Classic G-accounts (and
  // contracts without get_tokens) count toward mass but have no price.
  for (const address of registered) {
    if (knownSet.has(address) || !address.startsWith("C")) continue;
    try {
      const tokens = (await simulateView(env, address, "get_tokens")) as string[];
      const hitzIndex = tokens.indexOf(env.HITZ_CONTRACT_ID);
      if (tokens.length !== 2 || hitzIndex < 0) continue;
      const quoteToken = tokens[1 - hitzIndex];
      const name = String(await simulateView(env, quoteToken, "name"));
      const q = classifyQuoteName(name, env.USDC_ISSUER);
      const row: PoolRow = {
        address,
        hitz_index: hitzIndex,
        quote_token: quoteToken,
        quote_kind: q.kind,
        quote_id: q.quoteId,
        label: `HITZ/${q.symbol}`,
        active: 1,
      };
      await insertMany(env.DB, "INSERT OR REPLACE", "pools", Object.keys(row), [Object.values(row)]);
      known.push(row);
    } catch (err) {
      console.warn(`[ingest] could not inspect registered pool ${address}`, err);
    }
  }
  for (const p of known) {
    const active = registered.has(p.address) ? 1 : 0;
    if (p.active !== active) {
      p.active = active;
      await env.DB.prepare("UPDATE pools SET active = ? WHERE address = ?").bind(active, p.address).run();
    }
  }

  let changedFrom: number | null = null;
  const added: Record<string, number> = {};
  for (const pool of known.filter((p) => p.active)) {
    let cursor = await getCursor(env.DB, `pool:${pool.address}`);
    added[pool.label] = 0;
    for (let page = 0; page < POOL_PAGES; page++) {
      const url = `${STELLAR_EXPERT}/contract/${pool.address}/events?order=asc&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Stellar Expert HTTP ${res.status} for ${pool.address}`);
      const records = ((await res.json()) as { _embedded?: { records?: ExpertEvent[] } })._embedded?.records ?? [];
      const rows: unknown[][] = [];
      for (const e of records) {
        if (e.topics?.[0] !== "update_reserves") continue;
        const pair = decodeReservesBody(e.bodyXdr);
        if (!pair) continue;
        const { hitz, quote } = orientReserves(pair, pool.hitz_index);
        rows.push([pool.address, canonicalEventId(e.id), e.ts, hitz.toString(), quote.toString()]);
        changedFrom = changedFrom === null ? hourOf(e.ts) : Math.min(changedFrom, hourOf(e.ts));
      }
      await insertMany(env.DB, "INSERT OR IGNORE", "pool_reserves", ["pool", "event_id", "ts", "hitz", "quote"], rows);
      added[pool.label] += rows.length;
      if (records.length) {
        cursor = records[records.length - 1].paging_token;
        await setCursor(env.DB, `pool:${pool.address}`, cursor);
      }
      if (records.length < 200) break;
    }
  }
  return { registered: registered.size, reservesAdded: added, changedFrom };
}

// ─── 5. Quote prices ─────────────────────────────────────────────────────────

function horizonAssetParams(prefix: "base" | "counter", quoteId: string, usdcIssuer: string): string {
  if (quoteId === "XLM") return `${prefix}_asset_type=native`;
  const [code, issuer] = quoteId === "USDC" ? ["USDC", usdcIssuer] : quoteId.split(":");
  const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return `${prefix}_asset_type=${type}&${prefix}_asset_code=${code}&${prefix}_asset_issuer=${issuer}`;
}

async function syncQuotes(env: Env) {
  const { results: quotes } = await env.DB.prepare(
    "SELECT DISTINCT quote_id FROM pools WHERE active = 1 AND quote_kind IN ('native', 'classic') AND quote_id IS NOT NULL"
  ).all<{ quote_id: string }>();
  const nowHour = hourOf(Date.now() / 1000);
  let changedFrom: number | null = null;
  const added: Record<string, number> = {};

  for (const { quote_id: quoteId } of quotes) {
    const last = await env.DB.prepare("SELECT max(hour) AS h FROM quote_prices WHERE quote = ?")
      .bind(quoteId)
      .first<{ h: number | null }>();
    let start: number | null = last?.h ?? null;
    if (start === null) {
      // New quote: start at the first reserve point of any pool using it.
      const first = await env.DB.prepare(
        "SELECT min(r.ts) AS ts FROM pool_reserves r JOIN pools p ON p.address = r.pool WHERE p.quote_id = ?"
      )
        .bind(quoteId)
        .first<{ ts: number | null }>();
      if (first?.ts == null) continue;
      start = hourOf(first.ts);
    }
    added[quoteId] = 0;
    // Re-read the latest stored hour too: it was likely still in progress.
    for (let page = 0; page < QUOTE_PAGES && start <= nowHour; page++) {
      const url: string =
        `${env.HORIZON_URL}/trade_aggregations?${horizonAssetParams("base", quoteId, env.USDC_ISSUER)}` +
        `&${horizonAssetParams("counter", "USDC", env.USDC_ISSUER)}` +
        `&resolution=3600000&start_time=${start * 1000}&end_time=${(nowHour + HOUR) * 1000}&order=asc&limit=200`;
      const res: Response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`Horizon HTTP ${res.status} for ${quoteId}`);
      const body = (await res.json()) as { _embedded?: { records?: { timestamp: string | number; avg: string }[] } };
      const records = body._embedded?.records ?? [];
      const rows: [string, number, number][] = records.map((r) => [
        quoteId,
        Math.floor(Number(r.timestamp) / 1000),
        // VWAP, not close: see the quote_prices note in migrations/0001_init.sql.
        Number(r.avg),
      ]);
      await insertMany(env.DB, "INSERT OR REPLACE", "quote_prices", ["quote", "hour", "usd"], rows);
      if (rows.length) {
        const firstHour = rows[0][1];
        changedFrom = changedFrom === null ? firstHour : Math.min(changedFrom, firstHour);
        added[quoteId] += rows.length;
        start = rows[rows.length - 1][1] + HOUR;
      }
      if (records.length < 200) break;
    }
  }
  return { added, changedFrom };
}

// ─── 6. Price series ─────────────────────────────────────────────────────────

async function rebuildPrice(env: Env, changedFrom: number | null) {
  const snapRow = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?")
    .bind(PRICE_SNAPSHOT_KEY)
    .first<{ json: string }>();
  const prev = snapRow ? (JSON.parse(snapRow.json) as PriceSnapshot) : null;

  let from = changedFrom;
  if (!prev) {
    const first = await env.DB.prepare("SELECT min(ts) AS ts FROM pool_reserves").first<{ ts: number | null }>();
    if (first?.ts == null) return { skipped: "no reserves yet" };
    from = hourOf(first.ts);
  }
  if (from === null) return { skipped: "no changes" };

  const priced = await loadPricedPools(env);
  if (!priced.length) return { skipped: "no priced pools" };
  const { reserves, seedReserves, quotes, seedQuotes } = await loadWindow(env, priced, from);

  const hours = computeHours({
    pools: priced,
    fromHour: from,
    toHour: hourOf(Date.now() / 1000),
    reserves,
    seedReserves,
    quotes,
    seedQuotes,
  });
  await insertMany(
    env.DB,
    "INSERT OR REPLACE",
    "price_hourly",
    ["hour", "price", "weights"],
    hours.map((h) => [h.hour, h.price, JSON.stringify(h.weights)])
  );
  const snapshot = mergeSnapshot(prev, hours, priced, new Date().toISOString());
  await env.DB.prepare(
    "INSERT OR REPLACE INTO snapshots (key, json, updated_at) VALUES (?, ?, ?)"
  )
    .bind(PRICE_SNAPSHOT_KEY, JSON.stringify(snapshot), snapshot.asOf)
    .run();
  return { from, hours: hours.length, points: snapshot.points.length };
}

async function loadPricedPools(env: Env): Promise<PoolMeta[]> {
  const { results } = await env.DB.prepare("SELECT * FROM pools WHERE active = 1").all<PoolRow>();
  return results.map(toPoolMeta).filter((p) => p.quoteKind !== "unpriced");
}

/**
 * Reserves and quote prices from `from` onward, plus each series' last value
 * before it (so forward-fill is right at the window start).
 */
async function loadWindow(env: Env, pools: PoolMeta[], from: number) {
  const seedReserves = new Map<string, { hitz: bigint; quote: bigint }>();
  const reserves: ReservePoint[] = [];
  for (const p of pools) {
    const seed = await env.DB.prepare(
      "SELECT hitz, quote FROM pool_reserves WHERE pool = ? AND ts < ? ORDER BY ts DESC, event_id DESC LIMIT 1"
    )
      .bind(p.address, from)
      .first<{ hitz: string; quote: string }>();
    if (seed) seedReserves.set(p.address, { hitz: BigInt(seed.hitz), quote: BigInt(seed.quote) });
    const { results } = await env.DB.prepare(
      "SELECT event_id, ts, hitz, quote FROM pool_reserves WHERE pool = ? AND ts >= ? ORDER BY ts, event_id"
    )
      .bind(p.address, from)
      .all<{ event_id: string; ts: number; hitz: string; quote: string }>();
    for (const r of results) {
      reserves.push({ pool: p.address, ts: r.ts, eventId: r.event_id, hitz: BigInt(r.hitz), quote: BigInt(r.quote) });
    }
  }

  const seedQuotes = new Map<string, number>();
  const quotes = new Map<string, [number, number][]>();
  for (const quoteId of new Set(pools.map((p) => p.quoteId).filter((q): q is string => !!q))) {
    const seed = await env.DB.prepare("SELECT usd FROM quote_prices WHERE quote = ? AND hour < ? ORDER BY hour DESC LIMIT 1")
      .bind(quoteId, from)
      .first<{ usd: number }>();
    if (seed) seedQuotes.set(quoteId, seed.usd);
    const { results } = await env.DB.prepare("SELECT hour, usd FROM quote_prices WHERE quote = ? AND hour >= ? ORDER BY hour")
      .bind(quoteId, from)
      .all<{ hour: number; usd: number }>();
    quotes.set(quoteId, results.map((r) => [r.hour, r.usd]));
  }
  return { reserves, seedReserves, quotes, seedQuotes };
}

// ─── 7. Liquidity ────────────────────────────────────────────────────────────

async function rebuildLiquidity(env: Env, changedFrom: number | null) {
  const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?")
    .bind(LIQUIDITY_SNAPSHOT_KEY)
    .first<{ json: string }>();
  const prev = row ? (JSON.parse(row.json) as LiquiditySnapshot) : null;
  const nowTs = Math.floor(Date.now() / 1000);
  // Volume windows slide with time, so rebuild at least once per hour even
  // when nothing on chain changed.
  const fresh = prev && hourOf(Date.parse(prev.asOf) / 1000) === hourOf(nowTs);
  if (changedFrom === null && fresh) return { skipped: "no changes" };

  const pools = await loadPricedPools(env);
  if (!pools.length) return { skipped: "no priced pools" };

  // Fees are fixed per pool contract: read once from chain, then carry forward.
  const feeBps = new Map<string, number>();
  for (const p of prev?.pools ?? []) if (p.feeBps !== null) feeBps.set(p.address, p.feeBps);
  for (const p of pools) {
    if (feeBps.has(p.address)) continue;
    try {
      feeBps.set(p.address, Number(await simulateView(env, p.address, "get_fee_fraction")));
    } catch {
      // Not an Aqua-style pool; volume still counts, fees show as unknown.
    }
  }

  const fromHour = hourOf(nowTs - LIQUIDITY_WINDOW_S);
  const data = await loadWindow(env, pools, fromHour);
  const snapshot = summarizeLiquidity({
    pools,
    fromHour,
    nowTs,
    ...data,
    feeBps,
    asOf: new Date().toISOString(),
  });
  await env.DB.prepare("INSERT OR REPLACE INTO snapshots (key, json, updated_at) VALUES (?, ?, ?)")
    .bind(LIQUIDITY_SNAPSHOT_KEY, JSON.stringify(snapshot), snapshot.asOf)
    .run();
  return { tvlUsd: snapshot.totals.tvlUsd, volume30dUsd: snapshot.volume.d30.usd, points: snapshot.history.length };
}
