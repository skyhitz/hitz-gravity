# Fee designs on the real XLM path

`python3 run.py compare` (two assets, XLM and USDC).

## Arbs: calibrated (Arb(hedge=0.003, gas=0.002, min_profit=0.003, max_calls=8)), close prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,055.49 | +8.02 | +0.00 | 3274 | $62.44 | 0.39% |
| Flat 0.3% | $3,074.59 | +27.11 | +19.09 | 2112 | $39.14 | 0.55% |
| Flat 1% | $3,092.27 | +44.79 | +36.77 | 959 | $19.44 | 1.21% |
| Contract: 1% floor, k=100, 2h | $3,101.63 | +54.15 | +46.14 | 1535 | $13.35 | 2.37% |
| Dislocation fee, 3h memory | $3,106.76 | +59.28 | +51.26 | 1441 | $12.39 | 2.60% |
| Dislocation fee, 6h memory | $3,112.73 | +65.26 | +57.24 | 1237 | $11.05 | 3.17% |
| Dislocation fee, 0.5% floor | $3,091.56 | +44.08 | +36.06 | 1823 | $17.35 | 1.44% |
| Dislocation fee, k=50 | $3,095.89 | +48.41 | +40.40 | 1273 | $13.42 | 1.82% |
| Dislocation fee, k=200 | $3,108.52 | +61.04 | +53.03 | 1748 | $13.39 | 3.13% |

### Gain over holding, by month (exact)

| Month | Aquarius 0.1% (pool keeps half) | Flat 0.3% | Flat 1% | Contract: 1% floor, k=100, 2h | Dislocation fee, 3h memory | Dislocation fee, 6h memory |
|---|---|---|---|---|---|---|
| 2026-05 | -67.99 | -62.53 | -56.84 | -42.49 | -35.97 | -28.52 |
| 2026-06 | +63.21 | +69.05 | +73.39 | +71.12 | +69.96 | +68.80 |
| 2026-07 | +8.09 | +9.14 | +9.57 | +9.17 | +8.97 | +8.46 |
| 2026-08 | -0.41 | +2.10 | +5.30 | +5.17 | +5.32 | +6.04 |
| 2026-09 | -28.25 | -22.69 | -17.49 | -17.34 | -16.70 | -16.42 |
| 2026-10 | +33.36 | +32.04 | +30.87 | +28.52 | +27.71 | +26.89 |

## Arbs: picky (Arb(hedge=0.003, gas=0.005, min_profit=0.01, max_calls=8)), close prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,053.30 | +5.83 | +0.00 | 1690 | $63.34 | 0.49% |
| Flat 0.3% | $3,070.79 | +23.31 | +17.49 | 1189 | $43.11 | 0.65% |
| Flat 1% | $3,089.36 | +41.88 | +36.06 | 583 | $22.61 | 1.31% |
| Contract: 1% floor, k=100, 2h | $3,098.96 | +51.48 | +45.66 | 845 | $17.76 | 2.75% |
| Dislocation fee, 3h memory | $3,103.97 | +56.50 | +50.67 | 792 | $16.68 | 2.97% |
| Dislocation fee, 6h memory | $3,109.78 | +62.30 | +56.47 | 684 | $14.78 | 3.52% |
| Dislocation fee, 0.5% floor | $3,088.25 | +40.77 | +34.95 | 985 | $22.03 | 1.70% |
| Dislocation fee, k=50 | $3,092.79 | +45.31 | +39.49 | 726 | $17.19 | 2.06% |
| Dislocation fee, k=200 | $3,104.47 | +56.99 | +51.17 | 910 | $17.77 | 3.71% |
