# Arbitrage bot

Skyhitz trades the Sovereign Vault itself, with its own funds, so that the
vault's prices stay in line with the rest of Stellar. The code is public, and
anyone can run the same bot with their own account.

## What it does

The vault prices XLM against USDC through HITZ: an XLM to USDC swap goes XLM →
HITZ in the XLM pool, then HITZ → USDC in the USDC pool. It has no oracle, so
when XLM moves against USDC elsewhere, the vault's rate lags until someone
trades it back. The bot is that someone. Every five minutes it:

1. Reads the vault's pools, its own balances, and the Stellar DEX (SDEX) price
   of XLM in USDC: Horizon's best path for selling 10 XLM and for selling
   1.5 USDC, which covers the order book and the AMMs.
2. Sizes the round trip that earns the most: sell XLM into the vault and buy
   it back on the SDEX, or the mirror image with USDC. It runs the exact port
   of the contract's math ([`vaultMath.ts`](app/lib/vaultMath.ts)) over a
   log-spaced scan refined by a golden-section search, as the
   [integration guide](../contracts/sovereign-vault/INTEGRATION.md#arbitrage)
   describes.
3. Asks the SDEX for a quote at that exact size, and simulates the vault swap,
   which also says what the network will charge. It goes ahead only if the
   profit after those fees is at least 0.02 XLM and 0.3% of the trade.
4. **Buys back on the SDEX first**: a path payment that must return what the
   vault leg will sell, plus the fees.
5. **Then swaps in the vault**, with a minimum equal to what the SDEX leg
   spent.

Both minimums are enforced on chain, so a round trip that finishes is a
profit, in both assets, whatever happened in between.

### Why the SDEX leg goes first

The two legs are separate transactions (a Soroban call and a classic path
payment can't share one), so one of them lands first. The SDEX price is the
one that can move in the seconds between, or turn out not to be there at all;
the vault's price is fixed by its reserves and moves only when someone trades
it. So the uncertain leg goes first, while failing is free:

- If the buy-back doesn't go through, the bot has lost a 0.00001 XLM fee.
  Nothing reached the vault, so its fee (2% at least) was never paid on a
  quote that vanished. The next run tries again.
- If the buy-back lands and the vault leg then fails (someone else traded
  the vault in those seconds), the bot is left with a plain conversion at the
  SDEX price, which costs about a tenth of a percent.

The other order would put the 2% fee at risk on every trade for no gain.

It holds both XLM and USDC, since a round trip spends one on the SDEX before
the vault pays it back. When one side falls under a fifth of the total value
and there is nothing to trade, the bot converts back toward half and half on
the SDEX, unless that size would sell more than 1% under the going price. It
never holds HITZ: XLM ↔ USDC swaps leave all the HITZ inside the vault.

Limits: a trade is at most 150 XLM (or its value in USDC), and 5 XLM stay in
the account for fees on top of its reserve.

## What it earns, and what it does for the vault

Little for itself, by design. The vault's fee is 1% per hop when calm and
climbs exponentially as a trade dislocates XLM against USDC, then relaxes
over a couple of hours, so each profitable trade is small and the next one
closes a bit more of the gap.

The bot's own planner was [replayed](../research/arb-bot-replay/README.md) on
the SDEX's real prices from Jun 12 to Nov 11, 2026, at the vault's depth of
Nov 11 (about $5,800):

| | No bot | With the bot |
|---|---|---|
| Vault's XLM price off the SDEX, on average | 8.6% | 2.1% |
| Time spent more than 5% off | 64% | 3% |
| Round trips a day | 0 | 7.5 |
| Typical trade | | 4.6 XLM, earning 0.58% of it |
| Fees paid into the vault in five months | $0 | $37.72 |
| Bot's profit in five months | $0 | $6.78 (35 XLM) |

The profit floor decides who keeps the arbitrage. A bot that waits for a
larger profit keeps more for itself and pays less into the vault; one that
trades as soon as its costs are covered keeps the price closer and pays
more. Skyhitz runs the bot to keep the vault's prices honest and to give it
steady activity, not for the profit, so the floor is low: 0.02 XLM after
fees, about nine times what a round trip costs in network fees. Everything
scales with the vault's depth: at ten times today's, the same bot would make
about 12 round trips a day, $50 for itself and $400 in fees for the vault
over the same months.

## Run your own

You need Node 22.6 or later, this repository, and a Stellar account with XLM.
About 150 XLM is plenty today: the largest trade in the replay was 16 XLM.
On its first live runs the bot adds the trustline to Circle's USDC
(`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`) and converts
half its XLM to USDC on the SDEX.

```bash
git clone https://github.com/skyhitz/hitz-gravity && cd hitz-gravity/frontend
pnpm install

# Dry run: plans and simulates for any funded account, sends nothing.
node --experimental-strip-types scripts/arb-bot.mjs --address G...

# Live, every 5 minutes, with your account's secret key in the environment.
ARB_BOT_SECRET=S... node --experimental-strip-types scripts/arb-bot.mjs --live --every 300
```

Options: `--min-profit <xlm>` (default 0.02) and `--max-trade <xlm>` (default
150). `RPC_URL` and `HORIZON_URL` change the endpoints. Each run prints a JSON
report: the vault's rate, the SDEX bid and ask, the gap, the plan, and both
transactions. Its `action` is one of:

| Action | What happened |
|---|---|
| `none` | Nothing worth doing; `reason` says why |
| `would-trade` | A dry run found a trade |
| `trade` | Both legs done; `profitXlm` is what it made after fees |
| `missed` | The SDEX leg didn't go through; nothing changed but its fee |
| `trade-incomplete` | The SDEX leg ran and the vault leg didn't |
| `rebalance` | Converted back toward half XLM, half USDC |
| `setup` | Added the USDC trustline |
| `skip`, `error` | Couldn't run; `reason` or `error` says why |

Running it is at your own risk. The market can move between the two legs,
network fees are paid even when a leg fails, a key kept on a server can leak
(keep in the account only what the bot needs), and the contracts carry the
risks described in the [legal disclosure](../LEGAL.md). Several bots compete
for the same gap: whoever trades first takes it.

### Try it without funds

Two scripts check the bot before real money does:

```bash
# The live path on testnet: deploys the vault's mainnet bytecode with test
# assets, plays the SDEX with a market maker's offers, and runs the bot live
# through a trustline, a rebalance, a round trip each way and a bad quote.
node --experimental-strip-types scripts/arb-testnet-rehearsal.mjs

# The strategy on past prices: what any setting would have done.
node --experimental-strip-types scripts/arb-replay.mjs --fetch 2026-06-12 2026-11-12 > sdex.csv
node --experimental-strip-types scripts/arb-replay.mjs sdex.csv --min-profit 0.05
```

`pnpm test` runs the bot against a simulated network that decodes and applies
its real transactions ([`tests/arb.test.mjs`](tests/arb.test.mjs)): the
round trip both ways, every way either leg can fail, and the guards below.

## Skyhitz's own deployment

The bot runs in the skyhitz.io Worker on its own cron (`2-59/5 * * * *`),
offset from the data cron. Its account and every trade are public at
[`/api/v1/bot`](https://skyhitz.io/api/v1/bot).

- `ARB_BOT_MODE`: `off`, `dry-run` (plans and simulates, sends nothing) or
  `live`. `ARB_BOT_ADDRESS` is the bot's account.
- `ARB_BOT_SECRET` is a Worker secret, set with
  `npx wrangler secret put ARB_BOT_SECRET`. Live mode refuses a key for any
  other account, and runs dry without one.
- `ARB_BOT_MIN_PROFIT_XLM` and `ARB_BOT_MAX_TRADE_XLM` override the floor and
  the cap; `/api/v1/bot` shows the settings in force.
- Every action is logged in D1 (`arb_runs`, [migration 0004](migrations/0004_arb_bot.sql))
  and the last run in KV.
- Guards: the bot pauses itself for 24 hours after three round trips in a day
  that stopped after their first leg, a realized loss of more than 2 XLM in
  a day, or an hour of failing runs, and emails the operator. It also emails
  when its funds run low (under 30 XLM or 5 USDC to spend) and when the key
  doesn't match the account.
- The daily health check
  ([`data-health.yml`](../.github/workflows/data-health.yml)) fails when the
  bot is switched on and hasn't run for two hours.
- Its account counts as protocol infrastructure in the Monitor's traction
  numbers, never as a person.

Going live: set `ARB_BOT_ADDRESS` and watch the dry runs at `/api/v1/bot`;
fund the account; set the secret; switch `ARB_BOT_MODE` to `live`. The first
live run adds the trustline, the second converts half the XLM to USDC, and
the third trades.

Source: [`functions/_lib/arb.ts`](functions/_lib/arb.ts) (the strategy and
the two legs), [`functions/_lib/arb-ops.ts`](functions/_lib/arb-ops.ts) (the
cron run, log, guards and status),
[`functions/_lib/arb-worker.ts`](functions/_lib/arb-worker.ts) (the Worker's
bindings) and [`scripts/arb-bot.mjs`](scripts/arb-bot.mjs) (the runner).
