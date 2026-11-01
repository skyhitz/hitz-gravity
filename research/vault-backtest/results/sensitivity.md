# Sensitivity

The same comparison as `compare.md` with different arbitrageurs and price paths:

```bash
python3 run.py compare very-picky competitive
python3 run.py compare calibrated --ohlc
```

The ranking does not change in any of them.

## Arbs: very-picky (Arb(hedge=0.003, gas=0.01, min_profit=0.03, max_calls=8)), close prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,051.25 | +3.78 | +0.00 | 855 | $65.05 | 0.65% |
| Flat 0.3% | $3,066.47 | +18.99 | +15.22 | 647 | $47.77 | 0.79% |
| Flat 1% | $3,085.98 | +38.50 | +34.73 | 356 | $27.20 | 1.48% |
| Proposal: 1% floor, k=100, 2h | $3,094.40 | +46.92 | +43.14 | 464 | $22.99 | 3.35% |
| Dynamic, 3h memory | $3,099.21 | +51.73 | +47.96 | 430 | $21.33 | 3.61% |
| Dynamic, 6h memory | $3,104.16 | +56.68 | +52.90 | 376 | $19.11 | 4.11% |
| Dynamic, 0.5% floor | $3,085.29 | +37.82 | +34.04 | 546 | $27.84 | 2.19% |
| Dynamic, k=50 | $3,090.40 | +42.93 | +39.15 | 423 | $22.86 | 2.54% |
| Dynamic, k=200 | $3,099.33 | +51.85 | +48.07 | 472 | $22.59 | 4.69% |

## Arbs: competitive (Arb(hedge=0.001, gas=0.002, min_profit=0.003, max_calls=8)), close prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,059.40 | +11.92 | +0.00 | 4426 | $59.51 | 0.30% |
| Flat 0.3% | $3,081.18 | +33.70 | +21.78 | 2584 | $33.29 | 0.47% |
| Flat 1% | $3,096.37 | +48.89 | +36.97 | 1047 | $15.14 | 1.11% |
| Proposal: 1% floor, k=100, 2h | $3,103.25 | +55.77 | +43.85 | 1588 | $11.30 | 2.26% |
| Dynamic, 3h memory | $3,108.27 | +60.79 | +48.87 | 1491 | $10.43 | 2.49% |
| Dynamic, 6h memory | $3,113.94 | +66.47 | +54.54 | 1270 | $9.18 | 3.05% |
| Dynamic, 0.5% floor | $3,094.01 | +46.53 | +34.61 | 1931 | $14.59 | 1.34% |
| Dynamic, k=50 | $3,098.51 | +51.03 | +39.11 | 1340 | $11.03 | 1.72% |
| Dynamic, k=200 | $3,109.75 | +62.27 | +50.35 | 1801 | $11.69 | 3.02% |


## Arbs: calibrated (Arb(hedge=0.003, gas=0.002, min_profit=0.003, max_calls=8)), ohlc prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,058.07 | +10.60 | +0.00 | 3927 | $79.05 | 0.37% |
| Flat 0.3% | $3,079.53 | +32.06 | +21.46 | 2389 | $47.37 | 0.52% |
| Flat 1% | $3,095.54 | +48.06 | +37.46 | 996 | $21.54 | 1.15% |
| Proposal: 1% floor, k=100, 2h | $3,102.52 | +55.04 | +44.44 | 1564 | $13.63 | 2.32% |
| Dynamic, 3h memory | $3,107.36 | +59.89 | +49.29 | 1456 | $12.73 | 2.57% |
| Dynamic, 6h memory | $3,113.28 | +65.80 | +55.21 | 1241 | $11.21 | 3.13% |
| Dynamic, 0.5% floor | $3,093.34 | +45.86 | +35.27 | 1871 | $18.70 | 1.40% |
| Dynamic, k=50 | $3,098.61 | +51.13 | +40.53 | 1320 | $14.51 | 1.78% |
| Dynamic, k=200 | $3,109.17 | +61.69 | +51.09 | 1767 | $13.53 | 3.11% |

