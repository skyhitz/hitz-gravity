-- Abuse controls for the email gateway (rate limits, and a record of every
-- reserve the sponsor locks), and the queue for operator jobs.

-- Fixed-window rate limits (functions/_lib/rate-limit.ts). One row per bucket
-- and window; `bucket` ends in "|<window seconds>". Old windows are pruned by
-- the cron.
CREATE TABLE rate_counters (
  bucket TEXT    NOT NULL,   -- e.g. "login:ip:203.0.113.7|600"
  win    INTEGER NOT NULL,   -- window start, unix seconds
  n      INTEGER NOT NULL,
  PRIMARY KEY (bucket, win)
);

-- Every email account the sponsor has locked a reserve for
-- (functions/_lib/gateway-accounts.ts): the accounts the gateway creates,
-- and accounts it only sponsors a USDC trustline for. `email_sha256` is the
-- digest the key is derived from (functions/_lib/derive.ts): with
-- MASTER_SECRET it re-derives the account's key, so an unused account can be
-- merged back and its reserve reclaimed. The email itself is not stored.
CREATE TABLE gateway_accounts (
  address      TEXT PRIMARY KEY,
  email_sha256 TEXT NOT NULL,
  reason       TEXT NOT NULL,   -- execute | reparation | trustline
  created_at   TEXT NOT NULL    -- ISO 8601
);

CREATE INDEX gateway_accounts_created ON gateway_accounts (created_at);

-- Operator jobs (functions/_lib/admin-jobs.ts). Nothing public writes here:
-- a row is inserted with `wrangler d1 execute`, the cron runs it, and the
-- result is written back.
CREATE TABLE admin_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL,                     -- JSON: {"type": "...", ...}
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  result      TEXT,                              -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at  TEXT,
  finished_at TEXT
);
