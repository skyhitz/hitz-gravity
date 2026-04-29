# HITZ Gravity Token — Testnet Deployment

**Date:** 2026-04-25
**Network:** Stellar Testnet
**Architecture:** V5 — V4 + Pool/Router Enumeration + Initialized/AdminChanged Events + Mainnet-Hardened
**SDK:** soroban-sdk 25.3.1, Rust 1.95
**Gateway:** Lazy-restore gas station (Soroban TTL is invisible to users)

---

## Contract

| | |
|---|---|
| **Contract ID** | `CCWURGGZMECUABLCNKZMWKSR6TXFJX6AYWYR7R756ZXUHM2HLULTV4LK` |
| **WASM Hash** | `6dba0f1f8be9035fe448ac415b3b5ec2c86a0c969c271d09c0afd328249a0529` |
| **WASM Size** | 42,170 bytes |
| **Max Supply** | 100,000,000 HITZ (hard-coded, 7 decimals = 10¹⁵ stroops) |
| **Explorer** | https://stellar.expert/explorer/testnet/contract/CCWURGGZMECUABLCNKZMWKSR6TXFJX6AYWYR7R756ZXUHM2HLULTV4LK |
| **Lab** | https://lab.stellar.org/r/testnet/contract/CCWURGGZMECUABLCNKZMWKSR6TXFJX6AYWYR7R756ZXUHM2HLULTV4LK |

## Admin Account

| | |
|---|---|
| **Alias** | `gravity-admin` |
| **Public Key** | `GD5GKOYT2T65KDM3JQ2VXOU4CGZQQ3NFBCXY2FMJWGKRMKJYNPDP46CV` |

> The admin secret is held locally in the `stellar` CLI keystore under
> the `gravity-admin` alias. Do not commit it. Use
> `stellar keys show gravity-admin` if you need to copy it to another
> machine.

## Initial State

| | |
|---|---|
| **Name** | Gravity HITZ |
| **Symbol** | HITZ |
| **Decimals** | 7 |
| **Max Supply** | 100,000,000 HITZ |
| **Initial Mint** | _none — fresh deploy. Run the bootstrap commands below._ |
| **Initial L** | 0 (no mass yet) |
| **Prev Contract (deprecated)** | `CBQJN654JB3DILLHSBBZBSH4JPZZM2PCL5VYCE3YJXUN5JLBIIML2DP7` |
| **Older (deprecated)** | `CDXMCZYKLRAL6HSYCMEL6WMDFSUWR2JIEY63CE7HRWLX3LSTBSJ2MBI5` |

---

## What's New in V5

This release is the mainnet-hardening pass on top of V4. No protocol
math changes — the additions are operational hygiene and audit-driven
cleanups.

### 1. On-chain Pool / Router Enumeration

Two new view functions: `list_pools()` and `list_routers()`. Both return
`Vec<Address>` of every currently-registered entry, kept in lockstep
with `register_*` / `remove_*` writes. Clients no longer need to scrape
event logs + localStorage to know what's registered — one read.

### 2. Initialized + AdminChanged Events

- `InitializedEvent { admin (topic), name, symbol }` fires exactly once
  on `initialize`.
- `AdminChangedEvent { previous (topic), new (topic) }` fires on every
  `set_admin`. Topic on both sides so monitors can alert on outgoing
  transfers from the current admin and incoming tooling can pick up the
  role transition.

### 3. Strict Init Validation

`initialize` now panics on empty `name` or `symbol` to catch deploy-script
typos before they cement an unrecoverable nameless token.

### 4. Audit Cleanup

- Removed legacy `check_release` (lazy evaluation made it redundant; any
  action auto-syncs the vault flag).
- Removed redundant `current_limit` alias.
- Wrapped delegated-path integrity probes in
  `enforce_integrity_if_registered` so a future cleanup pass can't
  silently delete the side-effect calls as dead code.

### Carried over from V4

**Lazy Evaluation ("Just-In-Time Correction")** — every balance-changing
operation (transfer, transfer_from, mint, burn, burn_from) re-syncs the
vault flag against current `L` for both sides. A user who was trapped
but is now under `L` (because the protocol grew) is released inline, no
dummy tx required. A user who just crossed `L` is silently trapped. Use
`is_actually_vaulted(address)` for UI banners — it evaluates the
physics live without a state change.

**Hard Mint Cap — 100,000,000 HITZ** — `mint` refuses any call that
would push `total_supply` above the compile-time constant `MAX_SUPPLY =
100_000_000 × 10⁷` stroops. `burn` / `burn_from` decrement
`total_supply`, re-opening headroom. Once the `upgrade` entrypoint is
removed for mainnet (path-b plan), the cap is truly immutable.

**Auto-captured WASM Integrity Hash** — `register_pool_address` /
`register_router_address` read the address's current on-chain
executable hash and bind it automatically. A subsequent in-place WASM
swap trips the integrity guard on the next state-changing call. Classic
(non-Wasm) accounts get a zero-hash sentinel that skips the check.

**First-time Pool Balance Reconciliation** — tokens deposited to an
address BEFORE it was registered as a pool are folded into `TotalMass`
on the first registration call. Re-registration is idempotent.

---

## Two-Tier Identity Model (unchanged from V3)

**Pools** (`register_pool_address` — persistent storage):
- Admin-registered addresses whose balances count toward `TotalMass`
- The ONLY valid sink for a vaulted sender (sacrifice path)
- Exempt from vault logic

**Routers** (`register_router_address` — persistent storage):
- Pass-through entities (DEX aggregators, swap contracts)
- NEVER affect `TotalMass`
- Vaulted users CANNOT send to routers — only to pools
- Exempt from vault logic

---

## Quick Commands

```bash
CONTRACT=CCWURGGZMECUABLCNKZMWKSR6TXFJX6AYWYR7R756ZXUHM2HLULTV4LK
SRC="--source gravity-admin --network testnet"

# ── Reads ─────────────────────────────────────────────────
stellar contract invoke --id $CONTRACT $SRC -- total_supply
stellar contract invoke --id $CONTRACT $SRC -- max_supply
stellar contract invoke --id $CONTRACT $SRC -- total_mass
stellar contract invoke --id $CONTRACT $SRC -- safety_limit
stellar contract invoke --id $CONTRACT $SRC -- balance --id <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC -- is_account_vaulted --id <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC -- is_actually_vaulted --id <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC -- is_pool --address <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC -- is_router --address <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC -- list_pools
stellar contract invoke --id $CONTRACT $SRC -- list_routers

# ── Admin — registration ──────────────────────────────────
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- register_pool_address --address <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- remove_pool_address --address <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- register_router_address --address <ADDRESS>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- remove_router_address --address <ADDRESS>

# ── Admin — mint (capped at 100M total) ───────────────────
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- mint --to <ADDRESS> --amount <AMOUNT>

# ── User — transfer / burn ────────────────────────────────
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- transfer --from <ADDRESS> --to <ADDRESS> --amount <AMOUNT>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- approve --from <ADDRESS> --spender <ADDRESS> --amount <AMOUNT> --expiration_ledger <LEDGER>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- transfer_from --spender <ADDRESS> --from <ADDRESS> --to <ADDRESS> --amount <AMOUNT>
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- burn --from <ADDRESS> --amount <AMOUNT>

# ── Admin — role rotation (emits AdminChangedEvent) ───────
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- set_admin --new_admin <NEW_ADMIN_ADDRESS>

# ── Upgrade (TEMPORARY — to be removed before mainnet via
#                 the path-b "burn-the-key" final WASM) ────
stellar contract upload \
  --wasm target/wasm32v1-none/release/gravity_token.wasm \
  --source gravity-admin --network testnet
# → get NEW_HASH, then:
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- upgrade --new_wasm_hash <NEW_HASH>
```

---

## Try Lazy Evaluation

1. Mint HITZ to a user until they're vaulted (> current L)
2. Confirm `is_actually_vaulted` returns `true`
3. Mint more HITZ to the admin/pool to grow L past the user's balance
4. Confirm `is_actually_vaulted` now returns `false`
   — while `is_account_vaulted` (stale flag) still returns `true`
5. Have the user send anything — the transfer succeeds, no release call
6. `is_account_vaulted` now matches physics

## TTL Archive Restoration (Gateway-level Lazy Evaluation)

Soroban persistent storage has a finite TTL (~30 days on testnet). After
that window with no touch, an entry is **archived** to cold storage — it
stops responding to reads/writes until a `RestoreFootprintOp` pays to
bring it back. A user who holds HITZ but doesn't transact for a month
will see their `Balance`, `Vaulted`, and (transitively) any instance
storage keys they depend on archived out.

**The UX rule:** the user never sees this. They click "Send", and it
works.

The frontend handles archival at the transaction layer, not the user's
layer. Every contract call in both the custodial (email) and
non-custodial (wallet) path follows the same pattern:

1. Build the contract-call tx and call `simulateTransaction`.
2. If the simulation returns a `restorePreamble`:
   - Extract `sim.restorePreamble.transactionData` (the footprint of
     archived entries the call would touch).
   - Build a separate single-op `RestoreFootprintOp` tx with that
     footprint attached via `setSorobanData`.
   - Submit the restore tx; poll to finalization.
   - Re-fetch the user's account (sequence advanced) and re-simulate
     the original call against now-live state.
3. Assemble and submit the original call as normal.

### Who pays for the restore?

| Connection | Restore source / signer | Fee payer |
|---|---|---|
| **Email (custodial)** | Gas sponsor | Gas sponsor (same account the fee-bumps come from) |
| **Wallet (non-custodial)** | User | User |

The custodial path routes the restore through the sponsor because
`RestoreFootprintOp` doesn't require Soroban auth from the data's owner
— anyone can pay to bring entries back. This keeps the user's derived
sequence clean and avoids an extra round-trip to the deterministic
signer. Wallet users see one additional signature prompt when returning
after a long absence, labelled as a state restore.

### Where the code lives

- Gateway (custodial):
  `frontend/functions/_lib/stellar.ts` → `prepareContractCall` detects
  `restorePreamble`, calls the internal `maybeRestoreFootprint` helper,
  then re-simulates. `runSponsoredContractCall` is a single external
  entrypoint — callers pass `{contractId, method, argsXdr[]}` and the
  restore flow is entirely transparent.
- Wallet (non-custodial):
  `frontend/app/lib/stellar.ts` → `restoreArchivedState` helper; called
  inline from `buildAndSend` and from `WalletContext.walletCallContract`.

No scenario component or page-level code branches on archival. The
entire flow lives in the Stellar helpers.

## Try the Mint Cap

```bash
# This succeeds — takes supply to exactly 100M
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- mint --to $ADMIN --amount 900000000000000

# This panics — would push past 100M
stellar contract invoke --id $CONTRACT $SRC --send=yes \
  -- mint --to $ADMIN --amount 1
```
