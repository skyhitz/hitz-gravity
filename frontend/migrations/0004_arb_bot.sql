-- The arbitrage bot's log (functions/_lib/arb-worker.ts): one row per action
-- (a hedged trade, an unhedged one, a rebalance, a dry-run decision, an error
-- or a skip), with the full run report as JSON. Read by GET /api/v1/bot.
CREATE TABLE arb_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,   -- ISO 8601
  mode       TEXT NOT NULL,   -- live | dry-run
  action     TEXT NOT NULL,   -- trade | trade-unhedged | rebalance | would-trade | skip | error
  sell       TEXT,            -- XLM | USDC: the asset sold into the vault
  amount_in  TEXT,            -- decimal, in the sold asset
  vault_out  TEXT,            -- decimal, what the vault paid (or would pay)
  hedge_out  TEXT,            -- decimal, what the SDEX buy-back returned (or would)
  profit_xlm REAL,            -- XLM-equivalent; realized net of fees for trades
  gap_pct    REAL,            -- the vault's XLM/USDC rate against the SDEX mid
  vault_tx   TEXT,
  hedge_tx   TEXT,
  report     TEXT NOT NULL
);

CREATE INDEX arb_runs_at ON arb_runs (at);
CREATE INDEX arb_runs_mode_action ON arb_runs (mode, action, at);
