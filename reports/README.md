# Reports

On-chain activity reports for the HITZ contract
(`CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU`).

## Files

| File | Content |
|---|---|
| `YYYY-MM.md` | Auto-generated monthly report (cron) |
| `launch-window-*.md` | One-off backfilled launch analysis |
| `data/events.jsonl` | Append-only event store (committed) |
| `data/cursor.json` | Last RPC cursor — drives incremental fetch |

## How it works

Soroban RPC's `getEvents` exposes structured contract events
(`transfer`, `mint`, `burn`, `pool_registered`, `router_registered`,
`admin_changed`, `vaulted`, …). Public RPC nodes retain only ~24h, so
we **persist** events to `data/events.jsonl` after each fetch. Each
cron run picks up from the saved cursor, appends new events, and never
loses ground. The store is committed to the repo, so the data
is durable across runs and reviewable in PRs.

Reports are sliced from the JSONL store by month and rendered as
markdown by [`frontend/scripts/contract-report.mjs`](../frontend/scripts/contract-report.mjs).

## Run it manually

```bash
cd frontend

# Pull anything new since the last cursor
pnpm contract-report fetch

# Build a report for the current month (or pass YYYY-MM explicitly)
pnpm contract-report generate
pnpm contract-report generate 2026-06

# Or do both
pnpm contract-report all
```

## Automation

Two workflows, because the data and the report have different cadences:

- [`.github/workflows/daily-fetch.yml`](../.github/workflows/daily-fetch.yml)
  runs **every day**. Soroban public RPC only retains ~7 days of events,
  so the fetch must run well inside that window or history is lost
  permanently. It commits the updated `data/events.jsonl` back to `main`.
- [`.github/workflows/monthly-report.yml`](../.github/workflows/monthly-report.yml)
  runs on the **1st of each month**, generates the previous month's
  report from the (already-complete) event store, and commits it.

> **Pagination note:** `getEvents` scans in bounded ledger chunks. A
> short or empty page does NOT mean "done" — only the cursor reaching
> `latestLedger` does. `fetchEvents` pages on that condition; do not
> "optimise" it back to a page-size check or it silently truncates.

## Extending

The script today reports: event counts, daily activity, top
addresses, sponsor transfers, governance ops, and vault transitions.
To add a new section, edit the `generateReport` function in
`contract-report.mjs`. The event store is just JSONL — write whatever
analytics you want against it without re-fetching anything.
