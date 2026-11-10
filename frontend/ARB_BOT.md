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
2. Sizes the round trip that earns the most: sell XLM for USDC in the vault and
   buy the XLM back on the SDEX, or the mirror image with USDC. It runs the
   exact port of the contract's math ([`vaultMath.ts`](app/lib/vaultMath.ts))
   over a log-spaced scan refined by a golden-section search, as the
   [integration guide](../contracts/sovereign-vault/INTEGRATION.md#arbitrage)
   describes.
3. Trades only when the profit, after an allowance of 0.02 XLM for network
   fees, is at least 0.05 XLM and 0.3% of the trade. It confirms the SDEX price
   at that exact size first.
4. Swaps in the vault, with a minimum output 0.5% under the simulated one.
5. Buys the sold asset back on the SDEX with a path payment whose minimum is
   the amount it sold, so a round trip can't lose more than its network fees.
   If the SDEX has moved by then, it skips the buy-back and keeps the other
   asset.

It holds both XLM and USDC. A buy-back that was skipped leaves the inventory
lopsided; when one side falls under a fifth of the total value and there is
nothing to trade, the bot converts back toward half and half on the SDEX. It
never holds HITZ: XLM ↔ USDC swaps leave all the HITZ inside the vault.

Limits: a trade is at most 150 XLM (or its value in USDC), and 5 XLM stay in
the account for fees on top of its reserve.

## What it earns

Little, by design. The vault's fee is 1% per hop when calm and climbs
exponentially as a trade dislocates XLM against USDC, so each profitable trade
is small: on November 10, 2026, with the vault 8.4% above the SDEX, the best
trade sold about 22 XLM for about 0.78 XLM of profit. The fee then relaxes over
a couple of hours, and the next trade closes a bit more of the gap. The
[fee backtest](../research/vault-backtest/README.md) puts a bot like this at a
few trades a day and a few dollars a month at today's depth. Skyhitz runs it to
keep the vault's prices honest and to give it steady activity, not for the
profit.

## Run your own

You need Node 22.6 or later, this repository, and a Stellar account with XLM,
a trustline to Circle's USDC
(`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`) and some USDC.

```bash
git clone https://github.com/skyhitz/hitz-gravity && cd hitz-gravity/frontend
pnpm install

# Dry run: plans and simulates for any funded account, sends nothing.
node --experimental-strip-types scripts/arb-bot.mjs --address G...

# Live, every 5 minutes, with your account's secret key in the environment.
ARB_BOT_SECRET=S... node --experimental-strip-types scripts/arb-bot.mjs --live --every 300
```

Options: `--min-profit <xlm>` (default 0.05) and `--max-trade <xlm>` (default
150). `RPC_URL` and `HORIZON_URL` change the endpoints. Each run prints a JSON
report: the vault's rate, the SDEX bid and ask, the gap, the plan, and both
transactions.

Running it is at your own risk. The two legs are separate transactions (a
Soroban call and a classic path payment can't share one), the market can move
between them, network fees are paid even when a leg fails, and the contracts
carry the risks described in the [legal disclosure](../LEGAL.md). Several bots
compete for the same gap: whoever trades first takes it.

## Skyhitz's own deployment

The bot runs in the skyhitz.io Worker on its own cron (`2-59/5 * * * *`),
offset from the data cron. Its account and every trade are public at
[`/api/v1/bot`](https://skyhitz.io/api/v1/bot).

- `ARB_BOT_MODE`: `off`, `dry-run` (plans and simulates, sends nothing) or
  `live`. `ARB_BOT_ADDRESS` is the bot's account.
- `ARB_BOT_SECRET` is a Worker secret, set with
  `npx wrangler secret put ARB_BOT_SECRET`. Live mode refuses a key for any
  other account.
- Every action is logged in D1 (`arb_runs`, [migration 0004](migrations/0004_arb_bot.sql))
  and the last run in KV.
- Guards: the bot pauses itself for 24 hours after a realized loss of more than
  2 XLM in a day, three unhedged trades in a day, or an hour of failing runs,
  and emails the operator. It also emails when its funds run low.
- Its account counts as protocol infrastructure in the Monitor's traction
  numbers, never as a person.

Source: [`functions/_lib/arb.ts`](functions/_lib/arb.ts) (the strategy),
[`functions/_lib/arb-worker.ts`](functions/_lib/arb-worker.ts) (the cron,
log and guards) and [`scripts/arb-bot.mjs`](scripts/arb-bot.mjs) (the runner).
