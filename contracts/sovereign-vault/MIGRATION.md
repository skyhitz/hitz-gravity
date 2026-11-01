# Mainnet migration runbook

Moves HITZ liquidity from the two Aquarius pools into the Sovereign Vault,
installs the new token code, and ends with a final registry and a renounced
admin. Every step below is rehearsed by
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

### D. Deploy, register and seed the vault

1. Deploy the vault from the `sovereign-vault-v*` release WASM with
   `(admin, HITZ, XLM SAC, USDC SAC)`. The vault admin should be a Stellar
   multisig account.
2. `register_pool_address(vault)` on the token **before** seeding.
3. `seed(hitz_xlm, xlm, hitz_usdc, usdc)` from the admin wallet, with the
   amounts chosen so the vault's XLM price (`(usdc / hitz_usdc) / (xlm /
   hitz_xlm)`) equals the market XLM/USDC price at that moment. Check
   `market()` right after: `xlm_price` within 0.1% of the market and `fee`
   at 1%.

S does not change in this step (HITZ moves from one registered pool to
another).

### E. Final registry, then renounce

`renounce_admin` refuses until the registry is final, so:

1. `remove_pool_address(GCAETBNB…)`: the admin wallet is no longer
   exempt from vaulting. Seed first so its HITZ is already in the vault.
2. `remove_router_address(GBER7ROB…)`: finish or move the reparation
   campaign first; afterwards the sponsor is an ordinary account (vaulted
   while it holds more than L).
3. Remove `CBQDHNBF…` and `CA7RQDMM…` (Aquarius routers that no longer
   route HITZ), or re-bind them after review. Decide whether `CB4YHF4E…`
   and `CAG5LRYQ…` stay: after renouncing, a registered third-party
   contract keeps its exemption even if its owner later changes its code.
4. Check `list_pools` (the vault only), `list_routers`, `total_mass` (equal
   to the vault's HITZ) and `safety_limit` (within ~0.1% of 9,924).
5. Renounce: `renounce_admin` on the token and `renounce` on the vault,
   once the vault has run long enough that no fix is expected (see
   AUDIT.md, finding V-2).

## After the migration

- Ingest vault events (`swap`, `hop`, `deposit`) and point the price and
  liquidity cards at the vault instead of the Aquarius pools.
- Monitor `integrity_drift_event`, `upgrade_proposed` on both contracts,
  and silence (no HITZ events for 24 h).
