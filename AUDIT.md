# Security review: Sovereign Vault and HITZ token v2

Internal review of pull request #1 (`sovereign-vault`), Nov 1, 2026, updated
for the multi-asset vault (trusted assets listed without new code). It is
not a substitute for an independent audit (see P-3), but every finding below
was checked against code, tests, or live mainnet state, and the fixed ones
have tests that fail on the code as it was before.

## Scope

| Component | What was reviewed |
|---|---|
| `contracts/gravity-token` | The diff from mainnet v1.0.0: fail-soft integrity, 7-day upgrade timelock, `renounce_admin` |
| `contracts/sovereign-vault` | All of it: swap and fee math, per-pool deviations, listing, deposits, seeding, upgrade, renounce |
| Upgrade path | The live mainnet bytecode (`befa64d9…`, 22,310 bytes) upgraded to this build |
| Economics | The fee replayed on the real XLM path and calibrated to the real arbitrage history, then with a third asset on the real EUR path |
| Release and CI | `release-sovereign-vault.yml`, Wasm build, contract size |

Mainnet facts used here were read from the ledger on Nov 1, 2026: total
supply 100,000,000 (fully minted), S = 98,489,073 HITZ, L = 9,924 HITZ.

## Summary

The vault's code is small and careful. I found no way to take value out of
it beyond ordinary trading: amounts round in the vault's favour, k cannot
fall, reserves cannot reach zero, overflow is unreachable within the HITZ
supply cap (and reverts if it ever happens, since `overflow-checks` is on),
and Soroban rules out re-entrancy. The token changes do what they claim,
and the upgrade from the live bytecode keeps all state.

The real risks are in what happens around the code: who keeps privileges
after renouncing (T-1, T-2), what can still change instantly before
renouncing (T-3), how the fee treats ordinary buyers while the vault is
small (V-1), that a bug could not be paused (V-2), and which assets get
listed (V-11).

| ID | Severity | Finding | Status |
|---|---|---|---|
| T-1 | High | Renouncing with today's registry would exempt two team keys from Gravity forever | Fixed: `renounce_admin` refuses classic registrations |
| T-2 | Medium | Fail-soft lets a third party's code change keep its privileges | Fixed before renounce (live check); runbook prunes the rest |
| T-3 | Medium | Until renounce, registry changes are instant, not timelocked | Open: renounce soon after migration, multisig until then |
| V-1 | Medium | At launch depth, ordinary swaps pay most of the exponential fee | Open: needs a product decision |
| V-2 | Medium | No pause: a bug stays live through the 7-day upgrade window | Open: needs a product decision |
| V-3 | Medium | Vault admin can't be rotated; multisig is only documented | Open |
| V-11 | Medium | A listed asset that goes bad can take its pool's HITZ | Open: listing criteria and seed size |
| P-1 | Medium | No CI ran the contract tests; Wasm build and size never checked | Fixed: `.github/workflows/contracts.yml` |
| P-2 | Medium | The fee study couldn't be reproduced | Fixed: `research/vault-backtest` |
| T-4 | Low | Registry entries archived every ~120 days despite daily use | Fixed: bumped on use |
| T-6 | Low | Token event names didn't follow SEP-41 (`transfer_event`, not `transfer`) | Fixed: SEP-41 names and layouts |
| V-4 | Low | The fee ratio rounded down (against the vault) | Fixed: rounds up |
| V-5 | Low | Tokens sent straight to the vault are stranded | Open: optional `sync` |
| V-6 | Low | Authorization was never tested (all tests mock auth) | Fixed: three auth tests |
| V-14 | Low | `renounce` would have ended listing along with upgrades | Fixed: `renounce_upgrades` |
| P-3 | Info | No independent audit yet | Open |
| T-5, V-7…V-10, V-12, V-13 | Info | Verified properties and accepted risks | See below |

## Token findings

### T-1 (High, fixed) Renouncing would freeze two team keys outside Gravity

The registry holds two classic accounts:

- the admin wallet `GCAETBNB…OKGU`, registered as a **pool**, holding
  9,963,900 HITZ (about 1,000 × L), and
- the sponsor `GBER7ROB…NJNB`, registered as a **router**, holding 32,965 HITZ.

Registered pools and routers are never vaulted and can send any amount to
anyone; a pool's balance also counts toward S. `renounce_admin` freezes the
registry, so renouncing today would make both keys permanently exempt from
the rule the token exists to enforce.

**Fix.** `renounce_admin` now refuses while any registration has the
zero-hash (classic account) binding. Test:
`test_renounce_refuses_classic_account_registrations`. The runbook
(`contracts/sovereign-vault/MIGRATION.md`, step E) removes both after the
vault is seeded. Once removed, the sponsor is an ordinary account holding
about 3.3 × L, so it is vaulted and can only send HITZ into the vault: finish
the reparation campaign first, or move it to a wallet that stays under L.

### T-2 (Medium, fixed before renounce) Fail-soft keeps a changed contract's privileges

After this PR, a registered pool or router whose owner changes its code keeps
its classification and only triggers `integrity_drift_event`. That is the
right trade after the Oct 2 outage, but it means: a changed router stays an
account that is never vaulted, and a changed pool also keeps weighing in S.
Before renouncing, the admin can re-bind or remove it. After renouncing,
nobody can.

**Fix.** `renounce_admin` also refuses while any registered contract runs
code other than its approved hash. It reads the live bytecode, so it catches
changes no transfer has seen yet. Test:
`test_renounce_refuses_drifted_registrations`.

**Residual.** Changes made after renouncing can't be handled. Register only
contracts you control (the vault, which itself renounces) or immutable ones.
The two Aquarius routers (`CBQDHNBF…`, `CA7RQDMM…`) no longer route HITZ and
are on new code: remove them. Decide explicitly whether `CB4YHF4E…` and
`CAG5LRYQ…` stay.

### T-3 (Medium, open) Only upgrades are timelocked

Until renounce, the token admin can instantly: register any address as a
pool (never vaulted, counted in S), remove the vault (S collapses, nearly
every holder is vaulted on their next transfer), rotate the admin, and mint
whatever burns free up. The 7-day upgrade window does not constrain a
compromised admin key.

**Recommendation.** Keep the admin a Stellar multisig with a high threshold,
alert on `pool_registered`, `router_registered` and `admin_changed`, and
renounce soon after the migration. The T-1/T-2 guard makes sure the registry
is final when you do.

### T-4 (Low, fixed) Registry entries archived despite use

`ApprovedPools` / `ApprovedRouters` entries were TTL-bumped only at
registration, so they archived after the minimum persistent TTL (2,073,600
ledgers, ~120 days on mainnet) even while the pool traded every day, and the
next trade paid to restore them. On mainnet the admin wallet's and the
routers' registrations are already archived. They are now bumped whenever a
transfer reads them. Test: `test_registrations_are_kept_alive_by_use`.

### T-5 (Info, verified) The upgrade from the live bytecode keeps state

`tests/mainnet_migration.rs` loads the mainnet bytecode, rebuilds the
mainnet registry and balances, reproduces the Oct 2 outage (transfers to a
pool upgraded by its owner fail), installs this build with the old one-step
`upgrade`, and checks that supply, S, L, balances, vault flags, registry and
admin are unchanged, that the frozen pools flow again, and that the next
upgrade is timelocked. The new storage keys (`Drift`, `PendingUpgrade`,
`Renounced`) default correctly on existing state. It runs in CI.

### T-6 (Low, fixed) Token event names didn't follow SEP-41

The live token publishes `transfer_event`, `mint_event`, `burn_event` and
`approve_event` (`#[contractevent]` derives the names from the struct names),
and its approve data is a map keyed `expiration_ledger`, which matches
neither of SEP-41's formats. Wallets, explorers and indexers that follow
SEP-41 may not see HITZ movements.

**Fix.** The four events now use SEP-41 v0.5.2's names and layouts:
`transfer` `[from, to]`, `mint` `[to]` and `burn` `[from]` with the amount as
single-value data, and `approve` `[from, spender]` with `[amount,
expiration_ledger]` as vec data. The Gravity-specific events keep their
names. Test: `test_sep41_events_use_the_standard_names_and_layouts`; the
migration rehearsal checks the switch on the live bytecode. History before the
upgrade keeps the old names; the ingester already normalizes both, nothing
reads approve data, and mainnet has never emitted an approve event.

## Vault findings

### V-1 (Medium, open) Ordinary swaps pay most of the exponential fee at launch depth

The fee is priced on the dislocation a trade leaves behind. Any trade that
moves one pool against the others pays it, including a plain HITZ purchase,
and the arbitrage that moves it back pays close to the floor. With the vault
seeded from the Aquarius liquidity (about $2,800 of XLM + USDC), a $20 HITZ
purchase moves the XLM/USDC rate about 2%:

| XLM → HITZ, all-in cost | $5 | $20 | $100 |
|---|---|---|---|
| Aquarius today (0.1%) | 0.37% | 1.17% | 5.24% |
| Flat 1% | 1.27% | 2.06% | 6.10% |
| Dislocation fee, k=50 | 1.58% | 3.99% | 14.63% |
| Dislocation fee, k=100 (contract) | **1.99%** | **9.64%** | **14.63%** |
| Dislocation fee, k=100, at 10× depth (~$28k) | 1.08% | 1.35% | 3.48% |

(`research/vault-backtest/results/retail.md`.) The curve is tuned for a much
deeper vault. Options, in order of preference:

1. Hold off on the UI swap path until backing is ~$30k.
2. Launch with `STEEPNESS = 50` and raise it by timelocked upgrade as depth
   grows. In the backtest k=50 keeps ~90% of k=100's gain over holding.
3. Keep k=100 and show the fee prominently (`quote` vs. a no-fee quote).

### V-2 (Medium, open) No pause

The only fix for a bug is a timelocked upgrade, so a live bug stays
exploitable for 7 days; after `renounce`, forever. The vault holds all of
HITZ's backing and nothing can be withdrawn, so a math bug would drain the
backing directly. Options: a guardian that can only pause swaps and
deposits (never move funds), expires on its own and is removed by
`renounce`; or rely on small TVL and delay `renounce` until after the
independent audit and some weeks in production. At ~$2,800 of backing the
second is defensible, but decide it explicitly.

### V-3 (Medium, open) The vault admin can't be rotated

There is no `set_admin`. A compromised key can propose an upgrade or a
listing, and only the same key can cancel it. The README says the admin is a
multisig, but nothing enforces it. Use a Stellar multisig account with a high
threshold from deployment: its signers can be rotated at the account level
without changing the admin address. That matters more now that the admin
may keep the listing power for years after `renounce_upgrades` (V-14).

### V-4 (Low, fixed) The fee ratio rounded against the vault

`fee_for_price` truncated `price / anchor`, so the fee rate rounded down by up
to one unit in 10⁹. Amounts already rounded in the vault's favour; now the
rate does too, which makes the README's claim true. The golden vectors moved
by 1-2 stroops per trade, all toward the vault.

### V-5 (Low, open) Tokens sent straight to the vault are stranded

Transfers to the vault outside `swap` / `deposit` are not added to reserves
and can never leave. HITZ sent this way (a "sacrifice") still counts toward
S. An optional permissionless `sync` could fold any surplus into reserves; it
only ever adds backing.

### V-6 (Low, fixed) Authorization was untested

Every vault test ran under `mock_all_auths()`. New tests assert the exact
signature tree for `swap` (the trader signs all its terms and the one
transfer it pulls), that `deposit` needs the depositor, that `seed`,
`propose_upgrade`, `cancel_upgrade` and `renounce` need the admin, and that
all of them fail with no signature. Removing `from.require_auth()` from
`swap` makes the test fail.

### V-7 (Info, accepted) External dependencies

Circle can freeze the vault's USDC balance; every swap through the USDC pool
would stop while the other pools keep trading with each other and with HITZ.
Any listed asset's issuer has the same power over its own pool. A swap calls
only the HITZ contract and the contracts of the assets it trades, so no other
contract can halt it.

### V-8 (Info) Arbitrage costs 10× what it did, through a new interface

An XLM↔USDC cycle pays two end-state fees: at least ~2%, against 0.2% on
Aquarius. The historical arbitrage bots worked at a median edge of 0.5-0.6%
and never above 1.3% at the 90th percentile, so none of their past trades
would have cleared the new fee at the time. They will trade larger gaps
(see Economic validation), but only once they integrate the vault's ABI.

### V-9 (Info, verified) Invariants

- k never decreases: `gross = ⌊r_out·a / (r_in + a)⌋` and the fee is
  withheld from `gross`, so `(r_out − out)(r_in + a) ≥ r_out · r_in`.
- Reserves stay ≥ 1: `gross < r_out` whenever `r_in ≥ 1`.
- Overflow: the HITZ cap bounds every product (dumping the whole supply
  moves the XLM pool's XLM reserve by ~42% at today's k), and any overflow
  reverts.
- `quote` equals `swap` in the same ledger; deviations decay as an exact
  exponential however often they update; deposits keep the price.
- The fee is route-independent: a hop's fee depends only on its own pool and
  the pools it references, so splitting an asset-to-asset swap into single
  hops gives exactly the same output and a detour through a third asset only
  adds hops. Pair dislocations are consistent (the dislocation of A/C is that
  of A/B plus B/C), and a HITZ move shown by every pool dislocates nothing.
- A newly seeded pool starts at the HITZ-weighted average deviation, so a
  recent HITZ move isn't read as a dislocation of the new asset.
- `tests/mainnet_migration.rs` and the golden vectors pin the math across
  the contract and the backtest port.

### V-10 (Info) L is about $0.31 today

S ≈ 98.5M HITZ gives L ≈ 9,924 HITZ, roughly $0.31 at today's price. Nearly
every buyer is vaulted and can only sell back into the vault. That is the
Gravity model, but the swap UI has to say it before anyone buys.

### V-11 (Medium, open) A listed asset that goes bad can take its pool's HITZ

Every listed asset is trusted with the HITZ in its pool. If its contract
mints unbacked units (a hack, a broken bridge, a compromised issuer), those
units can be sold into its pool for that pool's HITZ, and the HITZ then sold
into every other pool for real assets. The fee slows this (it climbs to 10%
as the asset dislocates) but doesn't stop it. The loss is about the bad
pool's share of the vault's HITZ, taken out of the other pools' backing: a
pool seeded with a tenth of the HITZ exposes about a tenth of the rest.
Fee-on-transfer, rebasing and clawback lose the asset's own reserve instead:
the vault books the amount it asked for, not what arrived, and never re-reads
its balance.

Already in place: listings are public for 7 days; HITZ, duplicates and a
17th asset are refused; a pool affects other pools' fees only if it holds at
least 1/8 of their HITZ; a frozen asset stops only its own pool.

Before each listing:

1. Trust the issuer and the contract with the pool's HITZ. For a classic
   asset, read the issuer's flags (`AUTH_REVOCABLE`, `AUTH_CLAWBACK_ENABLED`)
   and policy; for a Soroban token, who can upgrade it.
2. Transfers must move exactly the amount asked: no transfer fees, no
   rebasing.
3. Size the seed to the trust: a newer or riskier asset gets a smaller share
   of the HITZ.
4. Run `MIGRATION.md`'s listing steps, and keep the listing power with the
   multisig until the asset list is final.

### V-12 (Info, accepted) A dislocated asset raises the fees of every pool that references it

A hop pays for its asset's most dislocated pair, not the pair being traded.
While XLM is dislocated, a USDC→EURC swap pays for XLM's dislocation, just as
a USDC→HITZ purchase already does with two assets. This is what makes the fee
route-independent. Pricing only the traded pair would leak: the fee is
convex, so a detour through an asset halfway between the two pays for two
half-size dislocations instead of one full one. With the contract's own math
such a detour would pay out up to 11.9% more than the direct swap; with
worst-pair pricing every detour costs at least 1.96% more
(`research/vault-backtest/detours.py`). A calm asset adds nothing: see the
three-asset backtest under Economic validation.

### V-13 (Info, verified) The cost of a swap grows with the listed assets

A hop reads every pool to find its asset's worst pair. On the release Wasm,
the worst-case asset-to-asset swap costs 3.4M instructions with two assets
and 10.1M with all 16 (the cap, `MAX_ASSETS`), against a network limit of
100M or more; memory stays at 1.5 MB, and the resource fee goes from ~0.013
to ~0.015 XLM. `tests/release_budget.rs` measures it in CI. Going past 16
assets takes an upgrade, so 16 is final once the code is frozen.

### V-14 (Low, fixed) Renouncing would have ended listing

The vault's admin had one exit, `renounce`, which also ended listing. The
runbook renounces the vault once no fix is expected, so the team would have
had to choose between an immutable vault and adding trusted assets later.
`renounce_upgrades` now freezes the code for good and keeps the timelocked
listing; `renounce` still ends everything. `upgradable()` reports which.
Test: `renouncing_upgrades_freezes_the_code_and_keeps_listing`; the migration
rehearsal lists a third asset after freezing the code on the renounced token.

## Process findings

- **P-1 (fixed)** `.github/workflows/contracts.yml` runs the tests, builds the
  release Wasm and checks it against the 128 KiB mainnet limit (token 55.7 KB
  and vault 53.0 KB unoptimized), runs the mainnet migration rehearsal and the
  16-asset swap budget on the release Wasm, and fails if test snapshots
  weren't committed.
- **P-2 (fixed)** `research/vault-backtest` holds the data fetcher, an exact
  Python port of the vault math for any number of assets (checked against the
  contract's golden vectors), the calibrated arbitrage simulator, the detour
  experiment and the results.
- **P-3 (open)** Get an independent audit of both contracts and the
  migration before mainnet.

## Economic validation

Method: `research/vault-backtest/README.md`. In short, the real arbitrage on
the two Aquarius pools from May 22 to Oct 2 (3,031 cycles, $7,503 volume,
$52.78 taken from the pools against the Binance price) was used to calibrate
a rational arbitrageur. Every fee design was then replayed on the real
minute-by-minute XLM price from May 22 to Oct 31, starting from the real
reserves, with the vault's exact integer math, and again with a third asset
(EURC) on the real EUR/USD price.

| From May 22 to Oct 31 | Gain over holding | vs Aquarius | Arb txs | Taken by arbs | Avg price lag |
|---|---|---|---|---|---|
| Aquarius history (0.1%, pool kept half) | +$8.02 | | 3,274 | $62.44 | 0.39% |
| Flat 1% | +$44.79 | +$36.77 | 959 | $19.44 | 1.21% |
| **Contract (1%, k=100, 2h)** | **+$54.15** | **+$46.14** | 1,535 | **$13.35** | 2.37% |
| Contract, 6h memory | +$65.26 | +$57.24 | 1,237 | $11.05 | 3.17% |
| Contract, 0.5% floor | +$44.08 | +$36.06 | 1,823 | $17.35 | 1.44% |

Starting backing $2,787; holding it untouched ends at $3,047.

- **The design is right in direction.** It earns about 6.8× what the
  Aquarius setup kept, and arbitrage takes 79% less. The multi-asset
  rewrite (log-space averages per pool) changes nothing with two assets: the
  arithmetic average of the XLM price it replaced gained +$54.10. The result holds with
  pickier arbitrageurs (1-3¢ minimum profit), more competitive ones (0.1%
  hedge cost), and intra-minute price swings.
- **The 1% floor is right.** The same curve with a 0.5% floor earns 19% less,
  and flat fees below 1% earn less still (flat 0.3%: half as much).
- **The exponential part wins in fast shocks, not in every shock.** Against
  flat 1% it gained $14.4 in the sharp late-May pump, tied in the calm months
  and the September pump, and lost about $2.3 in each of the June and October
  crashes. The earlier synthetic study's "+27% in crash months" did not show
  up in the two real crash months.
- **Longer memory earns more but lags more.** 6 hours adds ~21% to the gain
  over holding, with the vault's price 3.2% off the market on average.
- **A calm third asset changes nothing for the others.** With EURC listed
  next to XLM and USDC on the real EUR/USD path (seeded with as much HITZ as
  the USDC pool), the vault gained +$75.74 over holding on $3,887 of backing,
  against +$61.18 for flat 1% and +$8.64 for Aquarius-style pools; that is
  1.9% of the starting backing, as with two assets. The XLM/USDC small-swap
  fee averaged 2.48% (2.46% without EURC) and the XLM price lag 2.39% (2.37%).
  The spillover shows: a USDC↔EURC swap paid 2.45% on average, near the XLM
  pairs, because both pools reference XLM (V-12). Arbitrage never traded that
  pair.
- **It depends on arbitrageurs integrating.** Without them the vault's price
  goes stale, though the fee then protects it: a vault reopened with a 31%
  stale gap gave up $2.56 over three days, where an Aquarius-style pool gives
  up $13.26 at once.

## Production checklist

Status on Nov 4, 2026: migration steps A to D are done on mainnet (token
v2.0.0 at the same address, vault `CDEISYZM…NNBWU` registered and seeded with
10% of the Aquarius liquidity); see MIGRATION.md for the transaction record.
Step E, the audit and the multisig are still ahead.

Update on Nov 13, 2026: the rest of the Aquarius liquidity was deposited on
Nov 9 (about $5,800 in the vault), the four third-party routers were removed
on Nov 8, and the arbitrage bot has traded live since Nov 12. Step E, the
audit and the multisig are still ahead: one single-signature account holds
both admin roles and the treasury.

### Contracts

- [x] Unit tests: 97 token, 43 vault, 5 integration (`cargo test --workspace`)
- [x] Release Wasm builds; under the 128 KiB limit
- [x] Upgrade from the live mainnet bytecode rehearsed; state preserved; a
      third asset listed after the code is frozen
- [x] Authorization tested; golden vectors tie the backtest to the contract
- [x] `renounce_admin` refuses a non-final registry (T-1, T-2)
- [x] A swap with all 16 assets listed fits the network limits (V-13)
- [ ] Decide the launch fee steepness or depth gate (V-1)
- [ ] Decide on a pause guardian and the date for `renounce_upgrades` (V-2)
- [ ] Vault admin and token admin as high-threshold multisig accounts (T-3, V-3)
- [ ] Write down the listing criteria and seed sizing before the first
      listing (V-11)
- [ ] Independent audit of both contracts and the migration (P-3)
- [x] Tag `vX.Y.Z` and `sovereign-vault-vX.Y.Z`; confirm Stellar Expert validates both
      (`v2.0.0` and `sovereign-vault-v1.0.0`, both verified against `2807ed1`)
- [x] Confirm swap resource fees; confirm arbitrage still pays at real gas
      (measured on mainnet instead of testnet: a vault swap was charged
      0.0019 XLM, and the bot's round trips clear a 0.02 XLM floor after fees;
      `research/arb-bot-replay`)

### Migration (`contracts/sovereign-vault/MIGRATION.md`)

- [ ] Testnet run of steps A-E with real Aquarius contracts (skipped: steps
      A-D ran on mainnet after the rehearsal against the live bytecode)
- [x] Remove the Aquarius pools before anything lets HITZ out of them (stale 27% gap)
- [x] Seed at the market cross-rate; check `rate(XLM, USDC)` within 0.1%,
      `dislocation` zero and a 1% fee in `pools()` (10% soft-launch seed)
- [x] Deposit the remaining withdrawn liquidity (Nov 9, 2026). V-1 still
      applies at this depth: a $20 purchase pays about 11% all in
- [ ] Finish or move the reparation campaign, then remove the sponsor router
- [ ] Prune the registry to the vault; renounce passes its guard (the four
      third-party routers were removed on Nov 8, 2026; the treasury and the
      sponsor remain, and the HITZ Terminal now needs a registered treasury:
      MIGRATION.md, step E)

### Arbitrage and integration

- [x] Integration guide: [`contracts/sovereign-vault/INTEGRATION.md`](contracts/sovereign-vault/INTEGRATION.md),
      with its patterns tested in `tests/integration_guide.rs`, and the vault
      address filled in.
- [ ] Send it to the four operators behind 92% of past volume (by the
      account that deployed each bot): `GA6RKSBP…` (`CDCAZUHZ…`,
      `CC6QAV7J…`), `GDJMOSUF…` (`CBNVK5PE…`), `GDXGYASW…` (`CDWMA5P5…`),
      `GAXY7IZA…` (`CA6XIZJX…`)
- [x] Run the example bot against the vault on testnet end to end
      (`frontend/scripts/arb-testnet-rehearsal.mjs`, with the vault's mainnet
      bytecode); the bot trades on mainnet since Nov 12, 2026

### Product

- [x] Swap UI: per-hop fee and price impact from the exact fee math,
      confirmed by `quote`; warns above 1.5% and at the cap; explains vaulting
      before purchase, judged against the L the purchase leaves
- [x] Vaulted accounts: sell into the vault to release (the Vault tab
      computes the smallest sale)
- [x] Update `LEGAL.md` for the vault: no withdrawals, the fee, the upgrade
      timelock, renouncing

### Data and monitoring

- [x] Ingest vault events; move the price and liquidity cards to the vault
      (deploy the Worker to take effect)
- [ ] Alerts: `integrity_drift_event`; `upgrade_proposed` on both contracts;
      `listing_proposed` on the vault; registry and admin changes; no HITZ or
      vault events for 24 hours (the Oct 2 outage went unnoticed for 17 days)
