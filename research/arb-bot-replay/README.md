# Arbitrage bot replay

Replays Skyhitz's vault/SDEX arbitrage bot over five months of real SDEX
prices, to choose its settings on evidence and to say what it does for the
vault. The replay runs the bot's own planner
([`planTrade`](../../frontend/functions/_lib/arb.ts)) and the exact port of the
contract's math ([`vaultMath.ts`](../../frontend/app/lib/vaultMath.ts)), so
what is measured is what runs.

```bash
cd frontend && pnpm install
# Prices: Horizon's public 5-minute XLM/USDC trade averages (about 4 minutes).
node --experimental-strip-types scripts/arb-replay.mjs --fetch 2026-06-12 2026-11-12 > sdex.csv
# No bot, the first settings and the defaults, side by side (about 40 seconds).
node --experimental-strip-types scripts/arb-replay.mjs sdex.csv
# One setting of your own.
node --experimental-strip-types scripts/arb-replay.mjs sdex.csv --min-profit 0.05 --cadence 900
```

Saved output is in [`results/`](results/): the [comparison](results/comparison.md)
on both price series and the [sensitivity runs](results/sensitivity.md).

## What it found

From Jun 12 to Nov 11, 2026, at the vault's depth of Nov 11 (about $5,800):

| | No bot | First settings | Defaults now |
|---|---|---|---|
| Vault's XLM price off the SDEX, on average | 8.6% | 2.4% | 2.1% |
| Time spent more than 5% off | 64% | 4% | 3% |
| Round trips a day | 0 | 4.2 | 7.5 |
| Fees paid into the vault | $0 | $34.99 | $37.72 |
| Bot's profit | $0 | $10.48 | $6.78 |

1. **Without a bot the vault's price is far from the market most of the time.**
   Nobody else trades it yet: in its first week it saw four swaps of 1 to
   2 XLM. XLM moves about 3.7% a day, and the vault has no oracle.
2. **The profit floor decides who keeps the arbitrage, the bot or the vault.**
   The vault's fee grows with the dislocation a trade leaves behind and fades
   over two hours, so a bot that trades as soon as a small profit is there
   pays more fee for the same correction than one that waits for a larger
   one. Bot profit plus vault fees stayed between $44 and $46 for every
   floor from 0.005 to 0.2 XLM; the floor moved the split, and the price a
   little. Skyhitz runs the bot to keep the vault's price fair, so the floor
   is set low: 0.02 XLM after fees, about nine times the network fees of a
   round trip. That is also the edge outside bots have worked at: 0.5 to
   0.6% of the trade at the median on the old Aquarius pools
   ([AUDIT.md, V-8](../../AUDIT.md)), against 0.58% here.
3. **Running more often than every 5 minutes changes little.** Every minute:
   the price 2.05% off instead of 2.08%. What limits the bot is the fee's
   two-hour memory, not its reaction time. Running less often earns the bot
   more, by leaving more of each move untraded for longer.
4. **The numbers hold on each half of the period**, and on a second,
   independent price series (Horizon's public trade averages against our
   own minute recordings): 1,182 trades against 1,143, $6.49 against $6.78.
5. **The cost of the SDEX leg hardly matters**: from 3 to 30 basis points each
   way, the bot's profit goes from $6.87 to $6.49. The vault's fee is the
   cost that counts.
6. **Everything scales with depth.** At 10 times the depth: 12.5 trades a
   day, $50 for the bot, $397 in fees. The median trade is 4.6 XLM and the
   largest 16 XLM today, so the 150 XLM cap is far away; at 100 times the
   depth it binds.

## Data

- **SDEX mid, every minute** (the main series): 438,088 readings of the best
  bid and ask of Horizon's XLM/USDC order book, Jun 12 to Nov 11, 2026,
  recorded by the monitor in
  [skyhitz/stellar-arbitrage](https://github.com/skyhitz/stellar-arbitrage)
  (`arb_readings.stellar_price`, 12 looks a minute, one kept per exchange it
  is compared with). Exported on Nov 11, 2026 with read-only queries as
  `ts,price`; sha256 `e428637b…89c793`. The table is not public.
- **Horizon's 5-minute trade averages** (the series anyone can rebuild):
  `--fetch` reads `trade_aggregations` for XLM against Circle's USDC, takes
  each 5 minutes' volume-weighted average and stamps it with the end of its
  5 minutes, so a run never sees a price before it existed. 44,053 prices;
  sha256 of the file used here `799ed544…7e73fc`.
- **The vault**: its reserves of Nov 11, 2026, seeded at the first price of
  the series, as the real vault was seeded at the market price.

Other measurements the settings rest on, from the same recordings:

- **How fast the SDEX moves.** The mid's change has a standard deviation of
  0.10% over 1 minute, 0.22% over 5 minutes, 1.10% over 2 hours and 3.74%
  over a day. It moved more than 0.3% within a minute 1.8% of the time. The
  bot asks for at least 0.3% of the trade so that a leg landing a few
  seconds later still has room.
- **Whether the SDEX is the market.** Against Kraken's and Coinbase's XLM/USD
  over the same five months, the SDEX mid was within 0.03% at the median,
  0.14% for 99% of the minutes and 0.40% for 99.9%; it was more than 1% away
  in 21 minutes out of 219,000, all of them in the fastest moves. So the
  bot prices and buys back on the SDEX alone, with no exchange leg and no
  oracle.
- **What the SDEX leg costs.** On Nov 11, 2026, selling 10 to 150 XLM on the
  SDEX got 1.6 to 6.2 basis points under the order book's mid and buying
  paid 7.4 to 8.5 over: 8 basis points each way in the replay.
- **What the network charges.** A swap in the vault on mainnet was charged
  0.0019 XLM, and the simulation of an XLM to USDC swap asks for 0.0022 XLM;
  a path payment costs 0.00001 XLM. The replay uses 0.0023 XLM a round trip.
  The first version of the bot allowed 0.02.

## Method

Every 300 seconds (the cron's cadence) the replay takes the last price at or
before that moment, sets the SDEX bid and ask 8 basis points either side of
it, and asks the bot's planner for its best round trip against the vault's
pools as they stand. If the profit after fees clears the floor (the bot's own
`floorXlm`), the trade is applied to the pools with the contract's math, and
the vault's fee, the volume and the profit are counted. The pools then carry
their dislocation forward, decaying as the contract decays it. A price older
than 15 minutes is no price: that run is skipped (the recordings have one
gap of 11 hours, on Oct 18, 2026, when Cloudflare's crons stopped).

"First settings" is the bot as first merged (0.05 XLM after a 0.02 XLM fee
allowance); with fees really at 0.0023 XLM that is a floor of 0.0677 XLM.

## Limits

- The SDEX leg always fills at its quote. Over the few seconds a leg takes
  the SDEX moves about 0.04%, against a median profit of 0.58% of the
  trade; a leg that misses costs 0.00001 XLM and is tried again on the next
  run. The live bot's two legs were rehearsed on testnet
  (`frontend/scripts/arb-testnet-rehearsal.mjs`).
- The bot is alone. A faster outside bot would take the larger gaps first;
  the vault's fees would be the same or higher, the bot's profit lower.
- Its funds never run short. The largest trade was 16 XLM.
- The recorded mid is the top of the order book, not a price for size. The
  two series agreeing says this matters little at these sizes.
- One price path. The fee design itself was tested on the same months in
  the [fee backtest](../vault-backtest/README.md), with an arbitrageur who
  had unlimited capital and split every trade; its average lag of 2.37%
  matches the 2.1 to 2.4% here.
