## Sensitivity, Jun 12 to Nov 11, 2026

On the SDEX mid recorded every minute. Everything is as in the comparison (0.02 XLM floor after
0.0023 XLM of fees, 0.3% of the trade, a run every 5 minutes, the SDEX leg 8 basis points from the
mid, the depth of Nov 11, 2026) except the one thing each table varies. The bot's defaults are in bold.

### The profit floor

`--min-profit <xlm> --min-bps 30`

| Floor after fees | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| 0.005 XLM | 1,599 | 10.5 | 26.07 XLM ($5.04) | $1 | $39.23 | 1.98% | 46% of the time | 2% |
| 0.01 XLM | 1,497 | 9.9 | 27.78 XLM ($5.39) | $1.06 | $38.85 | 1.99% | 46% of the time | 2% |
| **0.02 XLM** | 1,143 | 7.5 | 35.05 XLM ($6.78) | $1.34 | $37.72 | 2.08% | 50% of the time | 3% |
| 0.03 XLM | 961 | 6.3 | 40.37 XLM ($7.79) | $1.54 | $36.92 | 2.16% | 52% of the time | 3% |
| 0.05 XLM | 751 | 4.9 | 48.3 XLM ($9.32) | $1.84 | $35.7 | 2.32% | 57% of the time | 4% |
| 0.1 XLM | 515 | 3.4 | 62.57 XLM ($12.07) | $2.38 | $33.71 | 2.62% | 64% of the time | 5% |
| 0.2 XLM | 345 | 2.3 | 77.71 XLM ($14.93) | $2.95 | $30.97 | 3.04% | 71% of the time | 10% |

| Floor after fees | Median trade | Largest | Median profit, share of the trade | 5% of trades earn under | XLM a trade | Minutes between trades, median |
|---|---|---|---|---|---|---|
| 0.005 XLM | 3.45 XLM | 13.69 XLM | 0.38% | 0.31% | 0.0163 | 25 |
| 0.01 XLM | 3.62 XLM | 13.69 XLM | 0.42% | 0.31% | 0.0186 | 30 |
| **0.02 XLM** | 4.62 XLM | 16.25 XLM | 0.58% | 0.44% | 0.0307 | 40 |
| 0.03 XLM | 5.45 XLM | 15.98 XLM | 0.7% | 0.55% | 0.042 | 55 |
| 0.05 XLM | 6.7 XLM | 15.29 XLM | 0.91% | 0.72% | 0.0643 | 70 |
| 0.1 XLM | 8.96 XLM | 13.82 XLM | 1.29% | 1.05% | 0.1215 | 100 |
| 0.2 XLM | 12.05 XLM | 15.55 XLM | 1.83% | 1.56% | 0.2253 | 155 |

### How often it runs

`--min-profit 0.02 --min-bps 30 --cadence <seconds>`

| A run every | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| 1 minute | 1,272 | 8.4 | 31.13 XLM ($6) | $1.19 | $38.31 | 2.05% | 49% of the time | 2% |
| **5 minutes** | 1,143 | 7.5 | 35.05 XLM ($6.78) | $1.34 | $37.72 | 2.08% | 50% of the time | 3% |
| 15 minutes | 995 | 6.5 | 41.2 XLM ($8.01) | $1.58 | $36.7 | 2.14% | 51% of the time | 3% |
| 60 minutes | 714 | 4.7 | 58.43 XLM ($11.48) | $2.27 | $33.09 | 2.35% | 56% of the time | 5% |

### What the SDEX leg costs

`--min-profit 0.02 --min-bps 30 --hedge-bps <bps>`

| From the mid, each way | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| 3 basis points | 1,148 | 7.6 | 35.5 XLM ($6.87) | $1.36 | $38.01 | 2.05% | 49% of the time | 2% |
| **8 basis points** | 1,143 | 7.5 | 35.05 XLM ($6.78) | $1.34 | $37.72 | 2.08% | 50% of the time | 3% |
| 15 basis points | 1,130 | 7.4 | 34.47 XLM ($6.67) | $1.32 | $37.21 | 2.12% | 51% of the time | 3% |
| 30 basis points | 1,095 | 7.2 | 33.54 XLM ($6.49) | $1.28 | $36.09 | 2.21% | 54% of the time | 3% |

### Each half on its own

`--min-profit 0.02 --min-bps 30 --to 2026-08-27` and `--from 2026-08-27`

| Period | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| Jun 12 to Aug 27 | 654 | 8.7 | 20.41 XLM ($4.02) | $1.6 | $23.2 | 2.19% | 52% of the time | 4% |
| Aug 27 to Nov 11 | 481 | 6.3 | 14.53 XLM ($2.74) | $1.07 | $14.19 | 1.97% | 47% of the time | 1% |

### The vault's depth

`--min-profit 0.02 --min-bps 30 --depth <x>` (and `--max-trade 1000000` for no cap)

| Depth | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| A tenth | 323 | 2.1 | 7.29 XLM ($1.4) | $0.28 | $3.04 | 3.12% | 71% of the time | 11% |
| **Nov 11, 2026** | 1,143 | 7.5 | 35.05 XLM ($6.78) | $1.34 | $37.72 | 2.08% | 50% of the time | 3% |
| 10 times | 1,898 | 12.5 | 260.17 XLM ($50.25) | $9.92 | $397.37 | 1.94% | 44% of the time | 2% |
| 100 times, trades capped at 150 XLM | 3,752 | 24.7 | 3866.6 XLM ($756.48) | $149.37 | $3734.04 | 1.95% | 44% of the time | 2% |
| 100 times, no cap | 1,935 | 12.7 | 2601.11 XLM ($502.82) | $99.28 | $3980.04 | 1.93% | 44% of the time | 2% |

| Depth | Median trade | Largest | Median profit, share of the trade | 5% of trades earn under | XLM a trade | Minutes between trades, median |
|---|---|---|---|---|---|---|
| A tenth | 1.25 XLM | 1.63 XLM | 1.77% | 1.49% | 0.0226 | 165 |
| **Nov 11, 2026** | 4.62 XLM | 16.25 XLM | 0.58% | 0.44% | 0.0307 | 40 |
| 10 times | 28.73 XLM | 135.72 XLM | 0.38% | 0.3% | 0.1371 | 20 |
| 100 times, trades capped at 150 XLM | 150 XLM | 150 XLM | 0.47% | 0.31% | 1.0305 | 10 |
| 100 times, no cap | 283.67 XLM | 1360.58 XLM | 0.38% | 0.31% | 1.3442 | 20 |
