# Security review: Sovereign Vault and HITZ token v2

Internal review of pull request #1 (`sovereign-vault`), Nov 1, 2026. It is
not a substitute for an independent audit (see P-3), but every finding below
was checked against code, tests, or live mainnet state, and the fixed ones
have tests that fail on the code as it was before.

## Scope

| Component | What was reviewed |
|---|---|
| `contracts/gravity-token` | The diff from mainnet v1.0.0: fail-soft integrity, 7-day upgrade timelock, `renounce_admin` |
| `contracts/sovereign-vault` | All of it: swap and fee math, anchor, deposits, seeding, upgrade, renounce |
| Upgrade path | The live mainnet bytecode (`befa64d9…`, 22,310 bytes) upgraded to this build |
| Economics | The fee replayed on the real XLM path and calibrated to the real arbitrage history |
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
small (V-1), and that a bug could not be paused (V-2).

| ID | Severity | Finding | Status |
|---|---|---|---|
| T-1 | High | Renouncing with today's registry would exempt two team keys from Gravity forever | Fixed: `renounce_admin` refuses classic registrations |
| T-2 | Medium | Fail-soft lets a third party's code change keep its privileges | Fixed before renounce (live check); runbook prunes the rest |
| T-3 | Medium | Until renounce, registry changes are instant, not timelocked | Open: renounce soon after migration, multisig until then |
| V-1 | Medium | At launch depth, ordinary swaps pay most of the exponential fee | Open: needs a product decision |
| V-2 | Medium | No pause: a bug stays live through the 7-day upgrade window | Open: needs a product decision |
| V-3 | Medium | Vault admin can't be rotated; multisig is only documented | Open |
| P-1 | Medium | No CI ran the contract tests; Wasm build and size never checked | Fixed: `.github/workflows/contracts.yml` |
| P-2 | Medium | The fee study couldn't be reproduced | Fixed: `research/vault-backtest` |
| T-4 | Low | Registry entries archived every ~120 days despite daily use | Fixed: bumped on use |
| T-6 | Low | Token event names don't follow SEP-41 (`transfer_event`, not `transfer`) | Open: one attribute per event |
| V-4 | Low | The fee ratio rounded down (against the vault) | Fixed: rounds up |
| V-5 | Low | Tokens sent straight to the vault are stranded | Open: optional `sync` |
| V-6 | Low | Authorization was never tested (all tests mock auth) | Fixed: three auth tests |
| P-3 | Info | No independent audit yet | Open |
| T-5, V-7…V-10 | Info | Verified properties and accepted risks | See below |

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

### T-6 (Low, open) Token event names don't follow SEP-41

The token publishes `transfer_event`, `mint_event`, `burn_event` and
`approve_event`: `#[contractevent]` derives the names from the struct names.
SEP-41 calls them `transfer`, `mint`, `burn` and `approve`. This is already the
case on mainnet. The ingester strips the suffix, but wallets, explorers and
indexers that follow SEP-41 may not see HITZ transfers. The fix is one
attribute per event, e.g. `#[contractevent(topics = ["transfer"],
data_format = "single-value")]`; the Gravity-specific events can keep their
names. It changes the event format, so update anything that matches the old
names (the ingester already handles both). If you want it, this upgrade is the
time: the next one waits 7 days.

## Vault findings

### V-1 (Medium, open) Ordinary swaps pay most of the exponential fee at launch depth

The fee is priced on the XLM cross-rate a trade leaves behind. Any trade that
moves the cross-rate pays it, including a plain HITZ purchase, and the
arbitrage that moves it back pays close to the floor. With the vault seeded
from the Aquarius liquidity (about $2,800 of XLM + USDC), a $20 HITZ purchase
moves the cross-rate about 2%:

| XLM → HITZ, all-in cost | $5 | $20 | $100 |
|---|---|---|---|
| Aquarius today (0.1%) | 0.37% | 1.17% | 5.24% |
| Flat 1% | 1.27% | 2.06% | 6.10% |
| Proposal, k=50 | 1.58% | 3.99% | 14.63% |
| Proposal, k=100 | **1.99%** | **9.64%** | **14.63%** |
| Proposal, k=100, at 10× depth (~$28k) | 1.08% | 1.35% | 3.48% |

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

There is no `set_admin`. A compromised key can propose an upgrade, and only
the same key can cancel it. The README says the admin is a multisig, but
nothing enforces it. Use a Stellar multisig account with a high threshold
from deployment; add a two-step rotation if `renounce` is far off.

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

Circle can freeze the vault's USDC balance; the USDC pool and XLM↔USDC route
would stop while HITZ↔XLM keeps working. The vault calls only the three token
contracts, so no other contract can halt it.

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
- `quote` equals `swap` in the same ledger; the anchor is an exact
  exponential average however often it updates; deposits keep the price.
- `tests/mainnet_migration.rs` and the golden vectors pin the math across
  the contract and the backtest port.

### V-10 (Info) L is about $0.31 today

S ≈ 98.5M HITZ gives L ≈ 9,924 HITZ, roughly $0.31 at today's price. Nearly
every buyer is vaulted and can only sell back into the vault. That is the
Gravity model, but the swap UI has to say it before anyone buys.

## Process findings

- **P-1 (fixed)** `.github/workflows/contracts.yml` runs the tests, builds the
  release Wasm and checks it against the 128 KiB mainnet limit (token 55.8 KB
  and vault 40.1 KB unoptimized), runs the mainnet migration rehearsal, and
  fails if test snapshots weren't committed.
- **P-2 (fixed)** `research/vault-backtest` holds the data fetcher, an exact
  Python port of the vault math (checked against the contract's golden
  vectors), the calibrated arbitrage simulator and the results.
- **P-3 (open)** Get an independent audit of both contracts and the
  migration before mainnet.

## Economic validation

Method: `research/vault-backtest/README.md`. In short, the real arbitrage on
the two Aquarius pools from May 22 to Oct 2 (3,031 cycles, $7,503 volume,
$52.78 taken from the pools against the Binance price) was used to calibrate
a rational arbitrageur. Every fee design was then replayed on the real
minute-by-minute XLM price from May 22 to Oct 31, starting from the real
reserves, with the vault's exact integer math.

| From May 22 to Oct 31 | Gain over holding | vs Aquarius | Arb txs | Taken by arbs | Avg price lag |
|---|---|---|---|---|---|
| Aquarius history (0.1%, pool kept half) | +$8.02 | | 3,274 | $62.44 | 0.39% |
| Flat 1% | +$44.79 | +$36.77 | 959 | $19.44 | 1.21% |
| **Proposal (1%, k=100, 2h)** | **+$54.10** | **+$46.08** | 1,539 | **$13.37** | 2.37% |
| Proposal, 6h memory | +$65.19 | +$57.18 | 1,238 | $11.00 | 3.17% |
| Proposal, 0.5% floor | +$43.99 | +$35.97 | 1,826 | $17.34 | 1.44% |

Starting backing $2,787; holding it untouched ends at $3,047.

- **The design is right in direction.** It earns about 6.7× what the
  Aquarius setup kept, and arbitrage takes 79% less. The result holds with
  pickier arbitrageurs (1-3¢ minimum profit), more competitive ones (0.1%
  hedge cost), and intra-minute price swings.
- **The 1% floor is right.** The same curve with a 0.5% floor earns 19% less,
  and flat fees below 1% earn less still (flat 0.3%: half as much).
- **The exponential part wins in fast shocks, not in every shock.** Against
  flat 1% it gained $14.2 in the sharp late-May pump, tied in the calm months
  and the September pump, and lost about $2.3 in each of the June and October
  crashes. The earlier synthetic study's "+27% in crash months" did not show
  up in the two real crash months.
- **Longer memory earns more but lags more.** 6 hours adds ~20% to the gain
  over holding, with the vault's price 3.2% off the market on average.
- **It depends on arbitrageurs integrating.** Without them the vault's price
  goes stale, though the fee then protects it: a vault reopened with a 31%
  stale gap gave up $2.56 over three days, where an Aquarius-style pool gives
  up $13.26 at once.

## Production checklist

### Contracts

- [x] Unit tests: 96 token, 25 vault (`cargo test --workspace`)
- [x] Release Wasm builds; under the 128 KiB limit
- [x] Upgrade from the live mainnet bytecode rehearsed; state preserved
- [x] Authorization tested; golden vectors tie the backtest to the contract
- [x] `renounce_admin` refuses a non-final registry (T-1, T-2)
- [ ] Decide the launch fee steepness or depth gate (V-1)
- [ ] Decide on a pause guardian and the renounce date (V-2)
- [ ] Vault admin and token admin as high-threshold multisig accounts (T-3, V-3)
- [ ] Independent audit of both contracts and the migration (P-3)
- [ ] Tag `vX.Y.Z` and `sovereign-vault-vX.Y.Z`; confirm Stellar Expert validates both
- [ ] Measure swap resource fees on testnet; confirm arbitrage still pays at real gas

### Migration (`contracts/sovereign-vault/MIGRATION.md`)

- [ ] Testnet run of steps A-E with real Aquarius contracts
- [ ] Remove the Aquarius pools before anything lets HITZ out of them (stale 27% gap)
- [ ] Seed at the market cross-rate; check `market()` (price within 0.1%, fee 1%)
- [ ] Finish or move the reparation campaign, then remove the sponsor router
- [ ] Prune the registry to the vault; renounce passes its guard

### Arbitrage and integration

- [x] Integration guide: [`contracts/sovereign-vault/INTEGRATION.md`](contracts/sovereign-vault/INTEGRATION.md),
      with its patterns tested in `tests/integration_guide.rs`. Fill in the
      vault address at deployment.
- [ ] Send it to the four operators behind 92% of past volume (by the
      account that deployed each bot): `GA6RKSBP…` (`CDCAZUHZ…`,
      `CC6QAV7J…`), `GDJMOSUF…` (`CBNVK5PE…`), `GDXGYASW…` (`CDWMA5P5…`),
      `GAXY7IZA…` (`CA6XIZJX…`)
- [ ] Run the example bot against the vault on testnet end to end

### Product

- [ ] Swap UI: show fee and price impact from `quote`, warn above 2%, explain
      vaulting (L ≈ $0.31 today) before purchase
- [ ] Update `LEGAL.md` for the vault: no withdrawals, the fee, the upgrade
      timelock, renouncing

### Data and monitoring

- [ ] Ingest vault events; move the price and liquidity cards to the vault
- [ ] Alerts: `integrity_drift_event`; `upgrade_proposed` on both contracts;
      registry and admin changes; no HITZ or vault events for 24 hours (the
      Oct 2 outage went unnoticed for 17 days)
