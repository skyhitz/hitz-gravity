# Sovereign Vault

HITZ's own exchange. Every trusted asset has one constant-product pool
against HITZ, and all pools share HITZ:

| Pool | Reserves | Listed |
|---|---|---|
| XLM | HITZ / XLM | at deployment |
| USDC | HITZ / USDC | at deployment |
| any trusted asset | HITZ / asset | later, through a 7-day timelock, up to 16 |

Any two listed assets trade through HITZ inside the vault. When one asset
moves against another on other venues, the gap between their pools is
arbitraged back through the vault, and the fee keeps that value in the
reserves. HITZ is backed by every listed asset and compounds with their
volatility.

Listing an asset changes no code: routing, the fee, the views and the events
already handle any number of pools.

No other contract can halt it: the vault calls nothing but the HITZ contract
and the listed assets' contracts, and the HITZ token treats a changed
third-party contract as an alert, never a stop.

## Fee

### One asset relative to another

Each pool prices HITZ in its asset: `price(A) = reserve_A / hitz_A`. Two
pools give the vault's exchange rate between their assets:
`rate(A, B) = price(B) / price(A)`, how much B one A is worth. XLM/USDC is
`(usdc / hitz_usdc) / (xlm / hitz_xlm)`.

Every pool keeps an exponential average of its own price in log space
(2-hour time constant) and stores its **deviation**: how far its log price
sits from that average. Because the averages are logarithmic, the difference
of two pools' deviations is exactly how far their exchange rate sits from its
own average: the pair's **dislocation**.

```text
dislocation(A, B) = deviation(B) − deviation(A) = ln(rate(A, B) ÷ its average)
```

- **Consistent across pairs.** dislocation(A, C) = dislocation(A, B) +
  dislocation(B, C) for any three assets, so every pair is measured on one
  scale.
- **HITZ moves don't count.** A move in HITZ itself shifts every pool's
  price alike and cancels out. Only one asset moving against another is a
  dislocation.

### What a hop pays

A swap passes through one pool (asset ↔ HITZ) or two (asset ↔ asset), and
each hop pays

```text
fee = 1% × e^(100 × D)     capped at 10%
D   = the largest |dislocation| of the hop's asset against any reference
      asset, in the state the hop leaves behind
```

| D | Fee |
|---|---|
| 0 | 1.00% |
| 0.5% | 1.65% |
| 1% | 2.72% |
| 2% | 7.39% |
| 2.30% or more | 10.00% (cap) |

D is close to the percentage gap: a rate 1% above its average is D = 0.995%
and a 2.70% fee.

- **With XLM and USDC only**, both hops of every swap pay for the XLM/USDC
  dislocation, and e^(100·D) is (rate ÷ average)^100: the backtested curve.
- **The worst pair, not the traded pair.** A hop pays for its asset's most
  dislocated pair, whatever the swap's other side. Each hop's fee then
  depends only on its own pool and the pools it references, never on the
  route: splitting A→B into A→HITZ and HITZ→B changes nothing, and a detour
  A→C→B only adds hops. Pricing only the traded pair would leak. The fee is
  convex, so two half-size dislocations cost less than one full one: with the
  contract's math, routing X→U through a third asset C halfway between them
  would pay out up to 11.9% more than the direct swap
  ([`research/vault-backtest/detours.py`](../../research/vault-backtest/detours.py)).
- **References.** A pool counts as a reference for another only if it holds
  at least 1/8 of that pool's HITZ (`REFERENCE_DEPTH_RATIO`). A shallow pool
  is cheap to push around, so it can't raise the fees of deep ones; it still
  pays for its own dislocation against them.
- **The trade-off.** A dislocated asset raises the fee of every pool that
  references it. While XLM is dislocated, a USDC→EURC swap pays for it too,
  just as a USDC→HITZ purchase already does with two assets. A calm asset
  changes nothing: with EURC listed next to XLM and USDC, the XLM/USDC fees
  stay where they were (see the backtest below).
- **Decay.** Deviations shrink toward zero by e^−1 every 2 hours, so after a
  move the fee falls back to 1%.
- **Priced at the end state.** The fee is set by the dislocation the hop
  leaves behind. Splitting a trade never gets below the fee schedule along
  the path, so there is no size threshold to slip under.
- **Fee to the depleted side.** The fee is withheld from the output, so it
  stays in the reserve being drained (in a crash, the USDC pool keeps its
  USDC).
- **No oracle.** Everything is read from the vault's own pools.
- k never decreases in any pool. Rounding always favours the vault, including
  the fee rate.

All parameters are constants in `src/lib.rs` (`FEE_FLOOR`, `FEE_CAP`,
`STEEPNESS`, `ANCHOR_TAU_SECS`, `ANCHOR_DECAY_PER_SEC`,
`REFERENCE_DEPTH_RATIO`, `MAX_ASSETS`). Changing one takes a timelocked
upgrade.

### Why these numbers

Backtested on the real thing: the arbitrage that ran on HITZ's two Aquarius
pools calibrates a rational arbitrageur, which then trades each fee design on
the real minute-by-minute XLM price from May 22 to Oct 31, 2026, starting
from the pools' real reserves ([`research/vault-backtest`](../../research/vault-backtest)).

| May 22 to Oct 31 | Backing gained over holding | Taken by arbs | Avg price lag |
|---|---|---|---|
| Aquarius as it was (0.1%, pool kept half) | +$8.02 | $62.44 | 0.39% |
| Flat 1% | +$44.79 | $19.44 | 1.21% |
| **This fee** | **+$54.15** | **$13.35** | 2.37% |
| This fee, 6 h memory | +$65.26 | $11.05 | 3.17% |

Starting backing: $2,787.

- About 6.8× what the Aquarius pools kept, with 79% less taken by
  arbitrage.
- Log-space averages change nothing with two assets: the arithmetic average
  of the XLM price that they replace gained +$54.10 on the same run.
- A 0.5% floor earns 19% less: arbitrage trades on calm days too and pays
  the same fee a swapper pays at that moment.
- Against flat 1%, this fee won $14 in the fast late-May pump and was within
  ±$2.4 in every other month, slightly behind in both crash months.
- A 3 h memory adds ~9% and 6 h ~21% to the gain, with the vault's price
  further off the market.
- At launch depth the fee also taxes ordinary purchases: a $20 HITZ buy
  pays ~9% with ~$2,800 of backing (AUDIT.md, V-1).

Taking the fee on the output rather than the input changes the backing by
less than 0.1%.

### With a third asset

The same run with EURC listed next to XLM and USDC from the start, seeded at
the market price with as much HITZ as the USDC pool, on the real EUR/USD
path (`run.py three`):

| May 22 to Oct 31, three assets | Backing gained over holding | Taken by arbs | Arb txs |
|---|---|---|---|
| Aquarius-style (0.1%, pool keeps half) | +$8.64 | $90.72 | 4,029 |
| Flat 1% | +$61.18 | $31.46 | 1,284 |
| **This fee** | **+$75.74** | **$20.92** | 2,147 |

Starting backing: $3,887.

| Average fee of a small swap (two hops; 1.99% at the floor) | XLM and USDC only | With EURC |
|---|---|---|
| XLM/USDC | 2.46% | 2.48% |
| XLM/EURC | | 2.47% |
| USDC/EURC | | 2.45% |

- A calm asset leaves the others alone: the XLM/USDC fee and the vault's XLM
  price lag (2.37%, then 2.39%) barely move.
- The gain grows with the backing: XLM now dislocates against two stable
  assets and both gaps are arbitraged through the vault. +$75.74 on $3,887
  against +$54.15 on $2,787, 1.9% of the starting backing either way.
- The spillover is real: a USDC↔EURC swap paid 2.45% on average, close to
  the XLM pairs, because both of its pools reference XLM. No arbitrage ever
  traded that pair; EUR/USD never moved enough.

## Listing a trusted asset

1. `propose_listing(asset)` (admin). Public for 7 days; `cancel_listing()`
   withdraws it, and a new proposal replaces it.
2. `list_asset(asset)` (admin), after the 7 days. The asset gets an empty
   pool, which takes no part in trading or in other pools' fees until it is
   seeded.
3. `seed(asset, hitz, amount)` (admin, once per asset), at the asset's market
   price. The pool's deviation starts at the HITZ-weighted average of the
   other pools' deviations, so a HITZ move that every pool already shows isn't
   read as a dislocation of the new asset.

From then on the asset trades against HITZ and every other listed asset.
Assets are never delisted. What to check before listing, and why each pool's
HITZ bounds the damage a bad asset can do: [AUDIT.md, V-11](../../AUDIT.md#v-11-medium-open-a-listed-asset-that-goes-bad-can-take-its-pools-hitz).

A swap reads every pool to find its asset's worst pair. With all 16 assets
listed, the worst case is about 10M instructions and ~0.015 XLM in resource
fees (3.4M and ~0.013 XLM with two), well inside the network's limits
(`tests/release_budget.rs`, run in CI on the release Wasm).

## Liquidity

- `seed(asset, hitz, amount)`: admin, once per asset. Sets the pool's
  starting price.
- `deposit(from, asset, hitz, min_amount, max_amount)`: anyone, at the
  pool's current ratio. `hitz` is exact; the matching amount of the asset
  (rounded up) must fall in `[min_amount, max_amount]`, so a deposit can't be
  sandwiched at a moved price. The price doesn't move, so neither does the
  pool's deviation.
- No LP shares and no withdrawals. Nothing leaves the vault except swap
  outputs.

## Trading

- `swap(from, to, token_in, token_out, amount_in, min_out) -> amount_out`:
  exact input. HITZ ↔ any listed asset is one hop; any two listed assets are
  two hops through HITZ (two fees; the HITZ never leaves the vault). Expiry
  comes from the transaction's time bounds.
- `quote(token_in, token_out, amount_in) -> amount_out`: what `swap` would
  pay now.
- `pool(asset)`, `pools()`: reserves, deviation, D and the fee a small hop
  pays now, per pool.
- `rate(base, quote)`, `dislocation(base, quote)`: a pair's exchange rate
  and its dislocation now.
- `assets()`, `hitz()`.

Events: `swap` (one per swap), `hop` (one per pool passed, with the asset,
the D it was priced at, fee rate, fee amount and reserves after),
`deposit`, `seeded`, `listing_proposed`, `listing_cancelled`, `listed`.

## Admin

The admin is a Stellar multisig account with two powers, both public for
7 days before they run: upgrading the code and listing a trusted asset (then
seeding it).

- `propose_upgrade(wasm_hash)` → 7 days → `upgrade(wasm_hash)`;
  `cancel_upgrade()` withdraws it.
- `propose_listing(asset)` → 7 days → `list_asset(asset)` → `seed`;
  `cancel_listing()` withdraws it.
- `renounce_upgrades()` freezes the code for good and keeps listing, so the
  vault can become immutable while trusted assets are still added later.
- `renounce()` ends everything: no upgrades, listings or seeding.

A fee change or any way to move reserves can only arrive as new code, through
the same 7-day public window. Events: `upgrade_proposed`,
`upgrade_cancelled`, `upgraded`, `upgrades_renounced`, `renounced`.

## HITZ token integration

Register the vault with `register_pool_address` **before** seeding. Then:

- the vault's HITZ is the token's Total Mass (S), so L = √S tracks the vault;
- vaulted holders (balance > L) can always sell into the vault;
- the vault can always pay HITZ out (pools are exempt from vaulting).

Listing an asset changes nothing on the token: the vault is one registered
pool however many assets it lists.

When the vault is upgraded, the token emits `integrity_drift_event` once and
keeps working; the token admin re-binds with `register_pool_address`.

## Invariants (tested)

- k never decreases in any pool, under random trading across three assets.
- Reserves equal the vault's token balances; Total Mass equals the vault's
  HITZ.
- The fee is always within [1%, 10%] and is the floor when nothing is
  dislocated.
- Pair dislocations are consistent across all pairs, and a HITZ move that
  every pool shows is not a dislocation.
- Route independence: splitting an asset-to-asset swap into single hops
  changes nothing; a detour through a third asset never prices a dislocation
  cheaper; a hop pays for its asset's worst pair whatever it trades against.
- A shallow pool can't raise the fees of deep ones; a deep asset's
  dislocation counts in every pool.
- Listing waits 7 days and must match the proposal; HITZ, duplicates and a
  17th asset are refused; a new pool starts where the others already are.
- The fee withheld stays in the output reserve. Round trips lose money.
  Asset-to-asset swaps don't move HITZ out of the vault.
- `quote` equals `swap` in the same ledger.
- Deviations decay as a true exponential: updating more often doesn't make
  them decay faster.
- Upgrades wait 7 days and must match the proposal; `renounce_upgrades`
  freezes the code and keeps listing; `renounce` ends both; trading carries
  on.
- Swaps need exactly the trader's signature; deposits the depositor's;
  seeding, listing, upgrades and renouncing the admin's.
- The fee math reproduces fixed golden vectors across three assets, shared
  with the backtest's port.

`cargo test -p sovereign-vault`

The migration from the live mainnet token is rehearsed by
`tests/mainnet_migration.rs`, and the cost of a swap with every asset listed
by `tests/release_budget.rs`. Both need the release Wasm (see
[`MIGRATION.md`](MIGRATION.md)):

```bash
cargo build --target wasm32v1-none --release -p gravity-token -p sovereign-vault
cargo test -p sovereign-vault --features migration-rehearsal --test mainnet_migration --test release_budget
```

Integrating a bot, wallet or app: [`INTEGRATION.md`](INTEGRATION.md).
Security review and production checklist: [`AUDIT.md`](../../AUDIT.md).
