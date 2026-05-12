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

[`.github/workflows/monthly-report.yml`](../.github/workflows/monthly-report.yml)
runs on the 1st of every month, fetches the latest events, generates
the previous month's report, and commits both the report and the
updated event store back to `main`.

## Extending

The script today reports: event counts, daily activity, top
addresses, sponsor transfers, governance ops, and vault transitions.
To add a new section, edit the `generateReport` function in
`contract-report.mjs`. The event store is just JSONL — write whatever
analytics you want against it without re-fetching anything.
