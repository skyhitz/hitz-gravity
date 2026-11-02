# Vault fee backtest

Replays the Sovereign Vault's fee on the real arbitrage history of HITZ's
two Aquarius pools and the real XLM price, to check the design against what
arbitrageurs actually did, and then with a third trusted asset (a euro
stablecoin such as EURC) on the real EUR price. Standard-library Python only.

```bash
python3 fetch_data.py            # ~10 min: pool events + XLM and EUR minute candles into ./data
python3 vaultmath.py --check     # the port still matches the contract
python3 detours.py               # why a hop pays for its asset's worst pair
python3 run.py history           # what the real arbs did
python3 run.py calibrate         # fit the arb cost model to it (~4 min)
python3 run.py compare           # fee designs on the real XLM path (~20 min)
python3 run.py compare very-picky competitive   # arb cost sensitivity
python3 run.py compare calibrated --ohlc        # intra-minute paths
python3 run.py three             # EURC listed next to XLM and USDC (~15 min)
python3 run.py retail            # what ordinary swaps pay, by depth
```

Saved output is in [`results/`](results/). The findings are summarised in
[`AUDIT.md`](../../AUDIT.md#economic-validation).

## Data

- **Pool events**: every `trade`, `update_reserves`, `deposit_liquidity` and
  `withdraw_liquidity` event of the Aquarius HITZ/XLM (`CCCDPF74…`) and
  HITZ/USDC (`CBMOEJUO…`) pools, from Stellar Expert.
- **Market prices**: Binance XLMUSDC and EURUSDC one-minute candles, Apr 25
  to Nov 1, 2026. EURUSDC stands in for a euro stablecoin's market.

Aquarius charged traders 0.1% per pool; half stayed in the pool and half
left as Aquarius's protocol fee (visible in `update_reserves`).

## Method

1. **History.** Trades are grouped by operation. An operation that trades
   both pools is an XLM↔USDC cycle through HITZ; its edge is what it took
   from the pools, valued at the Binance price that minute. 3,249 of the
   3,266 operations were such cycles.
2. **Window.** From the last liquidity change (May 22) to the last trade
   (Oct 2) the pools saw trades only, so the simulation starts from their
   real reserves on May 22.
3. **Arbitrageur.** Every minute it compares the vault's exchange rate of
   every pair of listed assets with the market, searches for its most
   profitable trade size using the exact contract quote, best edge first,
   and repeats while anything stays profitable (so it splits big trades the
   way a bot would). It pays a hedge cost on each non-USDC external leg, gas
   per swap, and ignores profits below a minimum.
4. **Calibration.** Run on the Aquarius fee over the window, a 0.3% hedge
   cost, $0.002 gas and a $0.003 minimum reproduce the real history: 3,013
   trades against 3,031, $7,982 of volume against $7,503, and $58.44 taken
   from the pools against $52.78.
5. **Comparison.** The same arbitrageur trades each fee design from May 22 to
   Oct 31, which adds October's 25% fall, when the real pools were frozen.
   The score is the vault's backing at market prices.
6. **A third asset.** The same run with EURC seeded on May 22 at the market
   price, with as much HITZ as the USDC pool, against XLM and USDC alone.

`vaultmath.py` is an integer-exact port of the contract's math for any
number of assets (Rust truncating division, rounding up where the contract
does, the same log and exp series, saturating powers). Its `--check` replays
the golden vectors that the contract test
`fee_math_matches_the_golden_vectors` asserts, across XLM, USDC and a
listed EURC; if the contract's math changes, both must be updated together.

`detours.py` uses the same math to compare the contract's fee with the
obvious alternative, pricing only the pair a swap trades, on swaps that
detour through a third asset.

## Limits

- Arbitrage only. Retail flow was $53 over five months, so it is left out.
- Minute bars, with one trading opportunity per minute. Running on
  open-high-low-close paths instead changes no ranking.
- The vault's own fee schedule is the only thing that differs between runs;
  the depth, the arbitrageur and the price path are the same for all.
- The three-asset run assumes arbitrageurs trade EURC as readily as XLM,
  with the same costs; there is no EURC arbitrage history to calibrate on.
