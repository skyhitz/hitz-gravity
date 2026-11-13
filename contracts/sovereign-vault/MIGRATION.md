# Mainnet migration runbook

Moves HITZ liquidity from the two Aquarius pools into the Sovereign Vault,
installs the new token code, and ends with a final registry and a renounced
admin.

## Status: steps A to D done on Nov 3-4, 2026; liquidity completed on Nov 9 (UTC)

| Step | Call | Ledger | Transaction |
|---|---|---|---|
| upload | token release Wasm `af53185d…` | 65290884 | `fa0366a8…` |
| upload | vault release Wasm `7dea47b2…` | 65290894 | |
| deploy | vault `CDEISYZM…NNBWU`, `(GCAETBNB…, HITZ, [XLM, USDC])` | 65290898 | |
| A1 | `remove_pool_address(CBMOEJUO…)` (Aquarius HITZ/USDC) | 65292464 | [`103f2d1d…`](https://stellar.expert/explorer/public/tx/103f2d1dfb3eec09e0693ef867fefe4ae89854c0d9734f4a8e23a68302702012) |
| A2 | `remove_pool_address(CCCDPF74…)` (Aquarius HITZ/XLM) | 65292511 | [`d06321bd…`](https://stellar.expert/explorer/public/tx/d06321bd8e677207673ac62e6d9083ab4bb640a3d2b6459ec8b4bc9ca9682f49) |
| B1 | withdraw 100% of the HITZ/XLM shares: 57,697,978.70 HITZ + 10,859.06 XLM | 65292557 | [`29b96326…`](https://stellar.expert/explorer/public/tx/29b96326b717b7065ea3dcaef916d4879f46705e88be0a4eb93bbc2b110ee11d) |
| B2 | withdraw 100% of the HITZ/USDC shares: 30,727,048.10 HITZ + 1,273.33 USDC | 65292601 | [`ef6eb6e4…`](https://stellar.expert/explorer/public/tx/ef6eb6e4bdc6c2fcececaab284c3cf8141c01056dc0f32f625b837b7f05e3ea5) |
| C | `upgrade(af53185d…)`: token v2.0.0, same address | 65293237 | [`b7912b4b…`](https://stellar.expert/explorer/public/tx/b7912b4befbce045f956e1f8ed2ab77b608ad0426e6d74e634a161a952ad3f57) |
| D1 | `register_pool_address(vault)` | 65293292 | [`3b4e9501…`](https://stellar.expert/explorer/public/tx/3b4e9501d828f309578d0948b30f2596b7f5aa04f9e8d57ef4dbd0468e1899ff) |
| D2 | `seed(XLM, 5,097,394.18 HITZ, 1,085.91 XLM)` | 65293357 | [`ce519fd0…`](https://stellar.expert/explorer/public/tx/ce519fd0872dff7bcce540c74ffacc04a5a8cabd4c7eb45c31f7b14d32284e8c) |
| D3 | `seed(USDC, 3,745,108.50 HITZ, 127.33 USDC)` | 65293433 | [`24c4c4f6…`](https://stellar.expert/explorer/public/tx/24c4c4f6374a452afac22eaa7f3794c1193590ca3ba7c729b068c2014ab00f6c) |

The seed was a soft launch: 10% of what came out of Aquarius, at XLM =
$0.1596, so HITZ entered the vault at $0.0000340. The other 90%, and the
admin's own HITZ, stays in the admin wallet (a registered pool, so it is
still Total Mass) until it is deposited. Verified right after: the token runs
`af53185d…` at the same address, `admin()` is `GCAETBNB…`, no pending
upgrade, S = 98,388,926.92 HITZ, L = 9,919.12 HITZ, `list_pools` is the admin
wallet and the vault, `rate(XLM, USDC)` = 0.1596, `dislocation` 0 and a 1%
fee on both pools. Stellar Expert verifies both contracts against commit
`2807ed1`. Step E is still ahead.

Since then (from the admin account's transactions):

- Nov 8, 2026: `remove_router_address` for the four third-party routers
  (`CBQDHNBF…`, `CA7RQDMM…`, `CB4YHF4E…`, `CAG5LRYQ…`). The gas sponsor is the
  only router left.
- Nov 9, 2026: `deposit` of the other 90%, 9,773.16 XLM and 1,146.00 USDC
  with their HITZ, bringing the vault to about $5,800. The admin wallet keeps
  its own 9.96M HITZ as the treasury, still a registered pool.

## Rehearsal

Every step below is rehearsed by
[`tests/mainnet_migration.rs`](tests/mainnet_migration.rs), which starts
from the token bytecode that is live on mainnet today
(`befa64d9…`, committed as `contracts/gravity-token/test_fixtures/gravity_token_mainnet_v1.0.0.wasm`).

```bash
cargo build --target wasm32v1-none --release -p gravity-token
cargo test -p sovereign-vault --features migration-rehearsal --test mainnet_migration
```

Run the whole sequence on testnet first with real Aquarius contracts, then on
mainnet. Keep the steps in this order.

## State on Nov 1, 2026

| | Address | HITZ | Registered as |
|---|---|---|---|
| Admin wallet | `GCAETBNB…OKGU` | 9,963,900 | pool (classic, zero hash) |
| Aquarius HITZ/USDC | `CBMOEJUO…5F5A` | 30,776,176 | pool, bound to `ae0da5a8…`, running `d691135a…` |
| Aquarius HITZ/XLM | `CCCDPF74…USPH` | 57,748,996 | pool, bound to `ae0da5a8…`, running `d691135a…` |
| Sponsor | `GBER7ROB…NJNB` | 32,965 | router (classic, zero hash) |
| Aquarius routers | `CBQDHNBF…`, `CA7RQDMM…` | 0 | routers, bound to `1c64fa2c…`, running `c99539b0…` |
| Other routers | `CB4YHF4E…`, `CAG5LRYQ…` | 0 | routers, hashes match |

Total supply 100,000,000 (fully minted). S = 98,489,073. L = 9,924 HITZ.

The two Aquarius pools have been frozen since Oct 2 with their implied XLM
prices 27% apart. Anything that lets HITZ flow out of them before the
liquidity is withdrawn (re-registering them, or installing the fail-soft
token first) hands that gap to arbitrageurs at a 0.1% fee.

## Steps

### A. Remove the Aquarius pools from the registry (old token code)

```bash
stellar contract invoke --id $HITZ --source admin --network mainnet -- remove_pool_address --address CBMOEJUO…
stellar contract invoke --id $HITZ --source admin --network mainnet -- remove_pool_address --address CCCDPF74…
```

- Their balances leave S (S drops to the admin wallet's 9.96M; L to ~3,157).
- They become ordinary accounts far above L, so they can no longer pay HITZ
  to traders: the stale gap can't be arbitraged.
- Holders between 3,157 and 9,924 HITZ who transact during the window get
  vaulted until step B restores S. Keep A and B back to back.

### B. Withdraw the Aquarius liquidity

Withdraw both LP positions with Aquarius's `withdraw` to the admin wallet.
A vaulted account can always send to a registered pool, and the admin wallet
is one, so the HITZ moves; its arrival puts S back (to ~98.39M). XLM and USDC
come out normally. Aquarius's protocol fees (~100k HITZ) stay in the pool
contracts and are not ours.

### C. Install the new token code (one-step, last time)

Use the WASM from the tagged GitHub release (validated by Stellar Expert),
not a local build.

```bash
stellar contract upload --wasm gravity-token_vX.wasm --source admin --network mainnet   # -> NEW_HASH
stellar contract invoke --id $HITZ --source admin --network mainnet -- upgrade --new_wasm_hash NEW_HASH
```

The live code's `upgrade` installs immediately. From here on every upgrade
is `propose_upgrade`, 7 days, `upgrade`. Verify `admin`, `total_mass`,
`safety_limit` and `pending_upgrade` right after.

From this step the token's SEP-41 events use the standard names (`transfer`,
`mint`, `burn`, `approve`) instead of `transfer_event` and the rest. The
ingester handles both; anything else that matches the old names needs to
accept the new ones before this step.

### D. Deploy, register and seed the vault

1. Deploy the vault from the `sovereign-vault-v*` release WASM with
   `(admin, HITZ, [XLM SAC, USDC SAC])`. The vault admin should be a Stellar
   multisig account. `seed` pulls the tokens from the vault admin, so the
   simplest is to make the admin wallet (`GCAETBNB…`) that multisig: its
   HITZ goes straight from one registered pool to another. Moving it to a
   different account first takes it out of S until it is seeded.
2. `register_pool_address(vault)` on the token **before** seeding.
3. From the vault admin, `seed(XLM SAC, hitz_xlm, xlm)` then
   `seed(USDC SAC, hitz_usdc, usdc)`, with the amounts chosen so the vault's
   XLM price (`(usdc / hitz_usdc) / (xlm / hitz_xlm)`) equals the market
   XLM/USDC price at that moment. Check right after: `rate(XLM, USDC)` within
   0.1% of the market, `dislocation(XLM, USDC)` zero, and `pools()` showing a
   1% fee for both.

S does not change in this step (HITZ moves from one registered pool to
another).

### E. Final registry, then renounce

`renounce_admin` refuses until the registry is final, so:

1. `remove_pool_address(GCAETBNB…)`: the admin wallet is no longer
   exempt from vaulting. Seed first so its HITZ is already in the vault.
   The HITZ Terminal sends its payments to the treasury and takes them only
   while the treasury is a registered pool
   (`frontend/functions/_lib/terminal/chain.ts`). Before this step, point
   `TERMINAL_TREASURY` at another registered pool that is a contract on its
   approved code, or Terminal payments stop.
2. `remove_router_address(GBER7ROB…)`: finish or move the reparation
   campaign first; afterwards the sponsor is an ordinary account (vaulted
   while it holds more than L).
3. Remove `CBQDHNBF…` and `CA7RQDMM…` (Aquarius routers that no longer
   route HITZ), or re-bind them after review. Decide whether `CB4YHF4E…`
   and `CAG5LRYQ…` stay: after renouncing, a registered third-party
   contract keeps its exemption even if its owner later changes its code.
4. Check `list_pools` (the vault only), `list_routers`, `total_mass` (equal
   to the vault's HITZ) and `safety_limit` (within ~0.1% of 9,924).
5. Renounce: `renounce_admin` on the token. On the vault,
   `renounce_upgrades` once it has run long enough that no fix is expected
   (see AUDIT.md, finding V-2): the code is then final, and the multisig keeps
   only the timelocked listing of new trusted assets. `renounce` ends that
   too; run it once the asset list is final.

## After the migration

- [x] Ingest vault events (`seeded`, `hop`, `deposit`) and point the price
  and liquidity cards at the vault instead of the Aquarius pools: the
  Worker cron reads them from Stellar Expert into D1 (pool keys
  `<vault>:<asset>`), and the app's swap, release card and Monitor read the
  vault directly.
- [x] Deposit the rest of the withdrawn liquidity (Nov 9, 2026). At this
  depth a $20 purchase still pays about 11% all in (AUDIT.md, V-1).
- [ ] Monitor `integrity_drift_event` and `upgrade_proposed` on both
  contracts, `listing_proposed` on the vault, and silence (no HITZ events
  for 24 h).

## Listing a trusted asset later

No code changes and nothing on the token: the vault stays one registered
pool.

1. Check the asset against the listing criteria in AUDIT.md (V-11): who can
   mint it, freeze or claw back the vault's balance, or change its contract,
   and whether its transfers move exactly the amount asked.
2. `propose_listing(asset)` on the vault and announce it. Integrators see
   `listing_proposed`; anyone can object during the 7 days.
   `cancel_listing()` if something comes up.
3. After 7 days, `list_asset(asset)`: an empty pool, outside trading and
   fees until seeded.
4. `seed(asset, hitz, amount)` from the vault admin at the market price:
   `amount / hitz` is the asset per HITZ, so `rate(asset, USDC)` must land
   within 0.1% of the asset's market price in USDC. Check `pools()` right
   after.

How much HITZ to seed is the main decision. It sets the new pool's depth,
whether it counts as a reference for the other pools (at least 1/8 of their
HITZ), and the most the vault can lose if the asset goes bad (V-11). After
step E the admin wallet is an ordinary account: holding more than L, it is
vaulted, which still lets it seed (seeding sends HITZ to the vault). Keep the
HITZ for future seeds there, or buy it from the vault when needed; the
migration rehearsal does the latter.
