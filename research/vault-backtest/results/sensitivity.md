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
| Contract: 1% floor, k=100, 2h | $3,094.75 | +47.27 | +43.49 | 468 | $23.07 | 3.36% |
| Dislocation fee, 3h memory | $3,099.16 | +51.68 | +47.90 | 428 | $21.23 | 3.63% |
| Dislocation fee, 6h memory | $3,104.46 | +56.98 | +53.20 | 373 | $18.98 | 4.10% |
| Dislocation fee, 0.5% floor | $3,084.81 | +37.33 | +33.56 | 546 | $27.80 | 2.18% |
| Dislocation fee, k=50 | $3,090.32 | +42.85 | +39.07 | 421 | $22.78 | 2.54% |
| Dislocation fee, k=200 | $3,099.35 | +51.87 | +48.09 | 472 | $22.59 | 4.70% |

## Arbs: competitive (Arb(hedge=0.001, gas=0.002, min_profit=0.003, max_calls=8)), close prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,059.40 | +11.92 | +0.00 | 4426 | $59.51 | 0.30% |
| Flat 0.3% | $3,081.18 | +33.70 | +21.78 | 2584 | $33.29 | 0.47% |
| Flat 1% | $3,096.37 | +48.89 | +36.97 | 1047 | $15.14 | 1.11% |
| Contract: 1% floor, k=100, 2h | $3,103.29 | +55.81 | +43.89 | 1590 | $11.26 | 2.26% |
| Dislocation fee, 3h memory | $3,108.43 | +60.95 | +49.03 | 1492 | $10.42 | 2.49% |
| Dislocation fee, 6h memory | $3,114.11 | +66.63 | +54.70 | 1272 | $9.26 | 3.06% |
| Dislocation fee, 0.5% floor | $3,093.82 | +46.35 | +34.42 | 1925 | $14.52 | 1.34% |
| Dislocation fee, k=50 | $3,098.45 | +50.97 | +39.05 | 1338 | $11.01 | 1.72% |
| Dislocation fee, k=200 | $3,109.84 | +62.36 | +50.44 | 1801 | $11.69 | 3.02% |

## Arbs: calibrated (Arb(hedge=0.003, gas=0.002, min_profit=0.003, max_calls=8)), ohlc prices

Start: $2,787.13 of XLM+USDC backing. Holding it untouched ends at $3,047.48.

| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $3,058.07 | +10.60 | +0.00 | 3927 | $79.05 | 0.37% |
| Flat 0.3% | $3,079.53 | +32.06 | +21.46 | 2389 | $47.37 | 0.52% |
| Flat 1% | $3,095.54 | +48.06 | +37.46 | 996 | $21.54 | 1.15% |
| Contract: 1% floor, k=100, 2h | $3,102.65 | +55.17 | +44.57 | 1555 | $13.63 | 2.32% |
| Dislocation fee, 3h memory | $3,107.59 | +60.12 | +49.52 | 1452 | $12.73 | 2.56% |
| Dislocation fee, 6h memory | $3,113.35 | +65.87 | +55.28 | 1240 | $11.22 | 3.13% |
| Dislocation fee, 0.5% floor | $3,093.35 | +45.87 | +35.27 | 1864 | $18.67 | 1.40% |
| Dislocation fee, k=50 | $3,098.51 | +51.04 | +40.44 | 1319 | $14.47 | 1.78% |
| Dislocation fee, k=200 | $3,109.13 | +61.65 | +51.06 | 1759 | $13.50 | 3.11% |
