-- hitz-data: the on-chain data store behind the Monitor tab and the
-- monthly reports. Replaces the git-committed reports/data/ files.
--
-- Ingestion runs in the Worker's cron (functions/_lib/ingest.ts); the
-- one-time imports live in scripts/migrate-to-d1.mjs (reports/data) and
-- scripts/backfill-prices.mjs (pool reserve + quote price history).

-- ─── HITZ contract events (was reports/data/events.jsonl) ─────────────
-- One row per Soroban event, same fields as the JSONL rows. `id` is the
-- RPC event id (zero-padded TOID + index), so ORDER BY id is chronological.
CREATE TABLE hitz_events (
  id      TEXT PRIMARY KEY,
  ledger  INTEGER NOT NULL,
  ts      TEXT NOT NULL,     -- ISO 8601 ledger close time
  tx_hash TEXT NOT NULL,
  name    TEXT NOT NULL,     -- `transfer`, `vaulted`, … (`_event` suffix dropped)
  topics  TEXT NOT NULL,     -- JSON array (topics after the event name)
  data    TEXT               -- JSON value (bigints as strings)
);
CREATE INDEX hitz_events_ts ON hitz_events (ts);
CREATE INDEX hitz_events_tx ON hitz_events (tx_hash);

-- Ingestion cursors: `hitz-rpc` (Soroban RPC getEvents), `pool:<addr>`
-- (Stellar Expert contract events), `quote:<id>` (Horizon hours).
CREATE TABLE cursors (
  source     TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Enrichment caches (were contract-info.json / tx-info.json) ───────
CREATE TABLE contract_info (
  address TEXT PRIMARY KEY,
  info    TEXT NOT NULL      -- JSON, same shape as the old cache entries
);

CREATE TABLE tx_info (
  hash TEXT PRIMARY KEY,
  info TEXT NOT NULL         -- JSON, same shape as the old cache entries
);

-- ─── Price history ────────────────────────────────────────────────────
-- Registered HITZ pools that are AMMs pairing HITZ with a quote token.
CREATE TABLE pools (
  address      TEXT PRIMARY KEY,
  hitz_index   INTEGER NOT NULL,  -- position of HITZ in get_tokens()
  quote_token  TEXT NOT NULL,     -- quote token contract address
  quote_kind   TEXT NOT NULL,     -- usd | native | classic | unpriced
  quote_id     TEXT,              -- key into quote_prices (e.g. XLM, CODE:ISSUER)
  label        TEXT NOT NULL,     -- e.g. "HITZ/XLM"
  active       INTEGER NOT NULL DEFAULT 1
);

-- Reserves after every trade, decoded from the pool's `update_reserves`
-- events. Raw 7-decimal integers kept as TEXT to avoid float loss.
CREATE TABLE pool_reserves (
  pool     TEXT NOT NULL,
  event_id TEXT NOT NULL,         -- zero-padded TOID-index, sortable
  ts       INTEGER NOT NULL,      -- unix seconds
  hitz     TEXT NOT NULL,
  quote    TEXT NOT NULL,
  PRIMARY KEY (pool, event_id)
);
CREATE INDEX pool_reserves_ts ON pool_reserves (pool, ts);

-- Hourly USD price for each non-USD quote token: the volume-weighted
-- average (`avg`) of Horizon's hourly trade aggregation vs USDC. The VWAP,
-- not the close, because single off-market prints happen on the DEX
-- (e.g. an XLM/USDC trade at 1.00 when the market was 0.186).
CREATE TABLE quote_prices (
  quote TEXT NOT NULL,
  hour  INTEGER NOT NULL,         -- unix seconds, floored to the hour
  usd   REAL NOT NULL,
  PRIMARY KEY (quote, hour)
);

-- Materialized liquidity-weighted HITZ/USD, one row per hour.
CREATE TABLE price_hourly (
  hour    INTEGER PRIMARY KEY,
  price   REAL NOT NULL,
  weights TEXT NOT NULL           -- JSON { poolAddress: share 0..1 }
);

-- Ready-to-serve API payloads, rebuilt by the cron when inputs change.
CREATE TABLE snapshots (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
