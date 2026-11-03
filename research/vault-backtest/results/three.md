# A third trusted asset

`python3 run.py three` (calibrated arbitrageur; XLM and EUR minute paths from Binance, May 22 to Oct 31).

## A third trusted asset: EURC listed next to XLM and USDC (arbs: calibrated)

EURC is seeded at the market price with as much HITZ as the USDC pool. Start: $3,887.03 of backing; holding it untouched ends at $4,117.92.

| Policy | Backing at end | vs holding | Arb txs | Extracted by arbs | XLM price lag | EURC price lag |
|---|---|---|---|---|---|---|
| Aquarius 0.1% (pool keeps half) | $4,126.55 | +8.64 | 4029 | $90.72 | 0.39% | 0.28% |
| Flat 1% | $4,179.10 | +61.18 | 1284 | $31.46 | 1.20% | 0.36% |
| Contract: 1% floor, k=100, 2h | $4,193.66 | +75.74 | 2147 | $20.92 | 2.39% | 0.33% |

### The contract's fee, pair by pair

Average fee of a small swap over the whole window (two hops; 1.99% at the floor), and the arb swaps each pair saw.

| Pair | Avg small-swap fee, XLM+USDC only | Avg small-swap fee, with EURC | Arb swaps, with EURC |
|---|---|---|---|
| XLM/USDC | 2.46% | 2.48% | 1141 |
| XLM/EURC | - | 2.47% | 1024 |
| USDC/EURC | - | 2.45% | 0 |

All pools at the floor: 41% of minutes with XLM+USDC, 38% with EURC listed.
XLM+USDC alone: backing +54.15 vs holding, 1535 arb txs, XLM lag 2.37%.
