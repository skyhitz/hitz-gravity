## Comparison, Jun 12 to Nov 11, 2026

`node --experimental-strip-types scripts/arb-replay.mjs <prices.csv>`, from `frontend/`. A run
every 300 seconds, the vault's depth of Nov 11, 2026, the SDEX leg 8 basis points from the mid each
way, 0.0023 XLM of network fees a round trip, and at least 0.3% of the trade in every row.

### On the SDEX mid recorded every minute (stellar-arbitrage, `arb_readings`)

438,088 prices, 2026-06-12 19:30 to 2026-11-11 17:57 UTC.

| Settings | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| No bot | 0 | 0 | 0 XLM ($0) | $0 | $0 | 8.59% | 85% of the time | 64% |
| First settings: 0.05 XLM floor after a 0.02 XLM fee allowance | 643 | 4.2 | 54.36 XLM ($10.48) | $2.07 | $34.99 | 2.42% | 60% of the time | 4% |
| **Defaults: 0.02 XLM floor after the real fees** | 1,143 | 7.5 | 35.05 XLM ($6.78) | $1.34 | $37.72 | 2.08% | 50% of the time | 3% |

| Settings | Median trade | Largest | Median profit, share of the trade | 5% of trades earn under | XLM a trade | Minutes between trades, median |
|---|---|---|---|---|---|---|
| First settings: 0.05 XLM floor after a 0.02 XLM fee allowance | 7.64 XLM | 15.05 XLM | 1.06% | 0.85% | 0.0845 | 85 |
| **Defaults: 0.02 XLM floor after the real fees** | 4.62 XLM | 16.25 XLM | 0.58% | 0.44% | 0.0307 | 40 |

### On Horizon's public 5-minute trade averages (`--fetch 2026-06-12 2026-11-12`)

44,053 prices, 2026-06-12 00:05 to 2026-11-11 23:05 UTC.

| Settings | Trades | A day | Bot profit | Per 30 days | Fees into the vault | Off the SDEX, on average | Over 2% off | Over 5% off |
|---|---|---|---|---|---|---|---|---|
| No bot | 0 | 0 | 0 XLM ($0) | $0 | $0 | 8.95% | 86% of the time | 66% |
| First settings: 0.05 XLM floor after a 0.02 XLM fee allowance | 652 | 4.3 | 53.58 XLM ($10.31) | $2.02 | $35.04 | 2.42% | 60% of the time | 4% |
| **Defaults: 0.02 XLM floor after the real fees** | 1,182 | 7.7 | 33.65 XLM ($6.49) | $1.27 | $37.86 | 2.08% | 50% of the time | 3% |

| Settings | Median trade | Largest | Median profit, share of the trade | 5% of trades earn under | XLM a trade | Minutes between trades, median |
|---|---|---|---|---|---|---|
| First settings: 0.05 XLM floor after a 0.02 XLM fee allowance | 7.59 XLM | 15.86 XLM | 1.04% | 0.84% | 0.0822 | 85 |
| **Defaults: 0.02 XLM floor after the real fees** | 4.6 XLM | 11.32 XLM | 0.57% | 0.44% | 0.0285 | 40 |
