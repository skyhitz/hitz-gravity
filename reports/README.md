# Reports

On-chain activity reports for the HITZ contract
(`CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU`).

## Files

| File | Content |
|---|---|
| `YYYY-MM.md` | Auto-generated monthly report (cron) |
| `launch-window-*.md` | One-off backfilled launch analysis |

The event data behind the reports is **not** in this repo anymore — it
lives in Cloudflare D1. (Until September 2026 it was an append-only
`data/events.jsonl` plus `tx-info.json` / `contract-info.json` caches,
committed daily; those files were imported into D1 and removed. They
remain in git history.)

## How it works

```
Soroban RPC ──getEvents──▶ Worker cron (every 5 min) ──▶ D1 `hitz-data` ──▶ /api/data/* ──▶ contract-report.mjs ──▶ reports/YYYY-MM.md
Horizon / Stellar Expert ──enrichment──┘                     │
Aqua pool events + Horizon XLM/USD ──────────────────────────┴──▶ /api/price/history (Monitor tab price card)
```

- **Ingestion** — `frontend/functions/_lib/ingest.ts`, run by the Worker's
  Cron Trigger every 5 minutes (`frontend/wrangler.toml`). It pulls new
  contract events (`transfer`, `vaulted`, `pool_registered`, …) from Soroban
  RPC, and enriches them the way the report generator used to on demand:
  Horizon tx envelopes (`tx_info`) and Stellar Expert contract metadata
  (`contract_info`). Public RPC nodes keep only ~7 days of events, so the
  5-minute cadence leaves a wide safety margin. The same cron maintains the
  HITZ/USD price history used by the Monitor tab.
- **Storage** — D1 database `hitz-data`, schema in
  `frontend/migrations/`. `hitz_events` rows are exactly the old JSONL rows.
- **Read API** — `frontend/functions/api/data.ts`, public and edge-cached
  (it's all public chain data):
  - `GET /api/data/events?after=<id>&limit=<≤1000>`
  - `GET /api/data/tx-info?after=<hash>&limit=<≤2000>`
  - `GET /api/data/contract-info`
  - `GET /api/data/status` — ingestion health
- **Reports** — `frontend/scripts/contract-report.mjs generate` reads the
  store through the read API and renders markdown. No credentials needed.

> **Pagination note:** `getEvents` scans in bounded ledger chunks. A
> short or empty page does NOT mean "done" — only the cursor reaching
> `latestLedger` does. The cron pages on that condition; do not
> "optimise" it back to a page-size check or it silently truncates.

## Run it manually

```bash
cd frontend

# Report for the current month (or pass YYYY-MM explicitly)
node scripts/contract-report.mjs generate
node scripts/contract-report.mjs generate 2026-06

# Against a local Worker (`npx wrangler dev`) instead of production
REPORTS_API_BASE=http://localhost:8787 node scripts/contract-report.mjs generate 2026-06
```

## Automation

- [`.github/workflows/monthly-report.yml`](../.github/workflows/monthly-report.yml)
  runs on the **1st of each month**, generates the previous month's report
  from the API and commits it.
- [`.github/workflows/data-health.yml`](../.github/workflows/data-health.yml)
  runs **every day** and fails (GitHub emails the owners) if event
  ingestion or the price feed hasn't moved in 2 hours — a stalled cron
  would otherwise lose history once RPC retention rolls past it.

## Setup / recovery

One-time, from `frontend/` (Wrangler logged in to the Skyhitz account):

```bash
npx wrangler d1 create hitz-data            # then put the id in wrangler.toml
npx wrangler d1 migrations apply hitz-data --remote
node scripts/migrate-to-d1.mjs --remote     # import the legacy reports/data files
node --experimental-strip-types scripts/backfill-prices.mjs --remote   # price history since launch
```

Both import scripts are idempotent (`INSERT OR IGNORE`, cursors only move
forward). `migrate-to-d1.mjs` needs the legacy files, so check them out
from git history first if you ever need to re-run it.

## Extending

Add a report section in `generateReport` in `contract-report.mjs`. For new
ingested data, add a table in a new `frontend/migrations/000N_*.sql`, a
step in `ingest.ts`, and (if reports need it) a read route in `data.ts`.
