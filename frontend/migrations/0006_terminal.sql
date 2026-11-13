-- The HITZ Terminal (functions/_lib/terminal/): checkouts, purchases, API keys, alert webhooks.
-- No market data is stored here: the terminal reads it from the data worker through the MARKET
-- service binding on every request.

-- One row per checkout: a plan priced in dollars, paid in USDC or XLM by a vault swap whose HITZ
-- goes to the treasury. `tx_hash` is the transaction the checkout built; `paid_tx` the one that paid
-- it (the same, or a fee bump or email-gateway transaction doing the same swap). A transaction pays
-- one checkout only.
CREATE TABLE terminal_checkouts (
  id          TEXT PRIMARY KEY,                  -- random, hex
  account     TEXT NOT NULL,                     -- the paying account (G...)
  plan        TEXT NOT NULL,                     -- trader | pro | institutional
  periods     INTEGER NOT NULL,                  -- 1 or 12 periods of 30 days
  asset       TEXT NOT NULL,                     -- USDC | XLM
  amount      TEXT NOT NULL,                     -- the asset amount sold, decimal
  amount_raw  TEXT NOT NULL,                     -- the same in the asset's smallest unit
  usd         REAL NOT NULL,                     -- the price
  treasury    TEXT NOT NULL,                     -- where the HITZ goes
  tx_hash     TEXT,                              -- the built transaction
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | expired
  paid_tx     TEXT UNIQUE,
  hitz_bought TEXT,                              -- HITZ the treasury received, decimal
  created_at  INTEGER NOT NULL,                  -- ms
  expires_at  INTEGER NOT NULL,                  -- ms: the transaction's valid_until
  paid_at     INTEGER                            -- ms: the paying ledger's close time
);
CREATE INDEX terminal_checkouts_account ON terminal_checkouts (account, created_at);
CREATE INDEX terminal_checkouts_status ON terminal_checkouts (status, created_at);

-- Append-only: one row per paid checkout. The plan an account has at any moment is folded from its
-- purchases in order (functions/_lib/terminal/billing.ts), so nothing here is ever updated.
CREATE TABLE terminal_purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account     TEXT NOT NULL,
  plan        TEXT NOT NULL,
  periods     INTEGER NOT NULL,
  usd         REAL NOT NULL,
  paid_at     INTEGER NOT NULL,                  -- ms
  checkout_id TEXT NOT NULL UNIQUE,
  tx_hash     TEXT NOT NULL UNIQUE
);
CREATE INDEX terminal_purchases_account ON terminal_purchases (account, paid_at);

-- API keys: only the SHA-256 is kept; the key is shown once.
CREATE TABLE terminal_keys (
  hash         TEXT PRIMARY KEY,                 -- SHA-256 hex of the key
  prefix       TEXT NOT NULL,                    -- its first characters, for display
  account      TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,                 -- ms
  last_used_at INTEGER,                          -- ms, updated at most once a minute
  revoked_at   INTEGER                           -- ms
);
CREATE INDEX terminal_keys_account ON terminal_keys (account);

-- Alert webhooks. The signing secret is derived from MASTER_SECRET and the id, never stored.
CREATE TABLE terminal_webhooks (
  id          TEXT PRIMARY KEY,                  -- random, hex
  account     TEXT NOT NULL,
  url         TEXT NOT NULL,
  format      TEXT NOT NULL DEFAULT 'json',      -- json | discord | slack
  kinds       TEXT,                              -- JSON array of alert kinds; null for every kind
  created_at  INTEGER NOT NULL,                  -- ms
  failures    INTEGER NOT NULL DEFAULT 0,        -- in a row; switched off at 50
  last_status INTEGER,
  last_at     INTEGER,
  disabled_at INTEGER
);
CREATE INDEX terminal_webhooks_account ON terminal_webhooks (account);

-- One row per alert sent to a webhook, so an alert is never sent twice. Pruned after 14 days.
CREATE TABLE terminal_deliveries (
  webhook_id  TEXT NOT NULL,
  alert_id    TEXT NOT NULL,
  status      INTEGER,                           -- HTTP status, 0 when the request failed
  at          INTEGER NOT NULL,                  -- ms
  PRIMARY KEY (webhook_id, alert_id)
);
CREATE INDEX terminal_deliveries_at ON terminal_deliveries (at);

-- Small cursors for the cron (the alert cursor).
CREATE TABLE terminal_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
