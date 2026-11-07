-- hitz-data: our own holder index.
--
-- Every address known to have held HITZ, so the Monitor (traction card,
-- holder map) and /api/holders know which `Balance(addr)` entries to read.
-- Amounts never come from here: they are read from the ledger itself
-- (getLedgerEntries), so a pre-upgrade `transfer_event` and a post-upgrade
-- SEP-41 `transfer` can never disagree with what an account really holds.
--
-- Replaces Stellar Expert's contract-data index, which went behind a paid
-- API (x402, 0.01 USDC a call) in November 2026. Sources:
--   events    every address in a transfer / mint / burn / vaulted event in
--             hitz_events (both the v1 `*_event` and the SEP-41 names are
--             stored without the suffix), kept current by the ingestion cron;
--   backfill  holders from before the event store's first event (May 11,
--             2026), found by scripts/backfill-holders.mjs and inserted by a
--             later migration.

CREATE TABLE holders (
  address  TEXT PRIMARY KEY,
  source   TEXT NOT NULL,       -- events | backfill
  added_at TEXT NOT NULL        -- ISO 8601
);

INSERT OR IGNORE INTO holders (address, source, added_at)
SELECT DISTINCT a, 'events', strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM (
  SELECT json_extract(topics, '$[0]') AS a FROM hitz_events WHERE name IN ('transfer', 'mint', 'burn', 'vaulted')
  UNION
  SELECT json_extract(topics, '$[1]') FROM hitz_events WHERE name = 'transfer'
) WHERE a IS NOT NULL AND length(a) = 56;
