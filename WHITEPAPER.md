# The Invariant Gravity Model

**A decentralization primitive for Soroban tokens**

*v4.0 · 2026*

---

> HITZ applies a square-root invariant to every transfer. As total liquidity
> grows, individual holding limits rise — but always slower than the reserves
> themselves, permanently bounding concentration.

> **Note.** This markdown is the canonical text of the whitepaper. It mirrors
> the rendered version at `/whitepaper` on the mainnet site. Keep the two in
> sync: any structural edit here must land in
> `frontend/app/whitepaper/page.tsx` (or vice-versa) so readers on both
> surfaces see the same content.

---

## I. The Concentration Problem

Most fungible tokens have no mechanism to prevent a single address from
accumulating an unbounded fraction of supply. Whales can silently dominate
governance, markets, and liquidity without triggering any on-chain constraint.

Existing approaches — vesting schedules, transfer limits, blacklists — are
either static, admin-dependent, or trivially circumvented. None of them
self-adjust as the ecosystem grows.

HITZ solves this with a *dynamic, self-adjusting holding limit* rooted in the
amount of real liquidity the protocol has attracted. The more value the
ecosystem holds in trusted pools, the more any individual can hold. But the
relationship is a square root — perpetually sub-linear.

---

## II. The Gravity Model

Define **S** as the **Total Mass** — the sum of HITZ balances held across all
admin-approved liquidity pools. **S** is an O(1) accumulator updated on every
transfer in or out of a pool.

The **Safety Limit** **L** — displayed in the interface as the
**Event Horizon** — is computed as:

```
L = ⌊ √( S × 10^d ) ⌋
```

where **d** = 7 (Stellar's standard decimal precision). Any account whose
balance exceeds **L** is **vaulted** — outbound transfers are blocked until
the account reduces its balance below **L**, or until the ecosystem grows
enough that **L** rises above the account's balance.

> **Law of Decentralization.** A 10,000× growth in pool reserves only yields a
> 100× growth in individual holding limits. Concentration can never keep pace
> with liquidity.

| Pool Reserves (S) | Event Horizon (L) | Max single holder |
| --- | --- | --- |
| 100 HITZ | 10 HITZ | 10% |
| 10,000 HITZ | 100 HITZ | 1% |
| 1,000,000 HITZ | 1,000 HITZ | 0.1% |
| 100,000,000 HITZ | 10,000 HITZ | 0.01% |

---

## III. Two-Tier Identity

Not all contract addresses are equal. HITZ distinguishes two classes of
trusted infrastructure, each with distinct physics:

**Pools** — `register_pool_address`

- Affect Total Mass S
- Vaulted users can send to them
- Sacrifice to pool can release vault
- Never vaulted themselves
- Balance reconciled into S on registration

**Routers** — `register_router_address`

- Never affect Total Mass S
- Pass-through only (DEX aggregators)
- Vaulted users CANNOT send to them
- Never vaulted themselves
- No mass reconciliation needed

Both tiers are registered by the admin on a per-address basis. Earlier versions
of HITZ used WASM hash detection — automatically treating any contract whose
bytecode matched an approved hash as a pool. This was abandoned because DEX
factories allow anyone to deploy a contract with any WASM hash, enabling
laundering via fake pools. **Strict address whitelisting is the only secure
approach.**

---

## IV. Transfer Physics

### The Roach Motel (Silent Trap)

Incoming transfers *never* revert due to vault logic. If a recipient's new
balance exceeds **L**, they are silently vaulted — but the transfer succeeds
and returns a clean SEP-41 void. This is essential for DEX router
compatibility: Aqua, Soroswap, and similar protocols depend on the output leg
of a swap never throwing.

### The Sender Gate (Lazy-Synced)

Before the sender gate fires, the sender's stored vault flag is re-synced
against the current **L**. If the protocol grew past the sender's balance
since they were last trapped, the flag clears inline and the transfer
proceeds. No panic wall around an account whose balance is already safe.
After the live re-sync, a still-vaulted sender is blocked unless all four
conditions hold:

```
!is_pool(from)
&& !is_router(from)
&& is_vaulted(from)   // evaluated against live L
&& !is_pool(to)
→ panic("Account is vaulted: transfers locked.")
```

Pools and routers are always exempt as senders. Vaulted users can only send
to an approved pool — not to a router, not to any other address. Sending to a
pool (sacrifice) reduces the sender's balance and increases **S**, potentially
releasing the vault if the new balance falls below the updated **L**.

### Correction on Receive

After every balance-changing call — transfer, transfer_from, mint, burn —
the recipient's vault flag is re-evaluated against their new balance and the
current **L**. A previously trapped holder whose balance now sits below **L**
(because the ecosystem expanded) is released in the same transaction. Stored
flags are never stale for longer than one state-changing call.

### Vault Release

An account is released when its balance ≤ **L**. Thanks to lazy evaluation,
release happens automatically on the user's next touch:

1. Sacrifice tokens to a pool (instant, on-chain, updates **S**).
2. The ecosystem grows: **S** increases, **L** rises past the account's
   balance — the next action auto-releases.

For UIs that want to reflect physics without triggering a state change,
`is_actually_vaulted(address)` evaluates the current **L** live, ignoring the
stored flag.

---

## V. Hard Mint Cap

HITZ compiles an absolute supply ceiling into the contract bytecode:

```
MAX_SUPPLY = 100,000,000 × 10^7 stroops
```

The mint entrypoint refuses any call that would push `total_supply` past this
constant. Rejection panics before any state moves — no partial writes, no
dangling events. Burns decrement `total_supply`, so the ceiling re-opens
headroom as tokens exit circulation.

> **Immutability path.** The cap is a Rust `const`. Once the `upgrade`
> entrypoint is removed for mainnet, the cap becomes unalterable by any
> actor.

Two new queries expose the state: `total_supply()` returns current circulating
supply, and `max_supply()` returns the compiled ceiling.

---

## VI. On-Chain Implementation

HITZ is a [Soroban](https://stellar.org/developers/soroban) smart contract on
the Stellar network, fully implementing the **SEP-41** token interface.

| Property | Description |
| --- | --- |
| **O(1) Accumulator** | TotalMass is a stateful i128 updated on every pool transfer — no iteration required. |
| **Checked Arithmetic** | Every arithmetic operation uses `checked_add` / `checked_sub` / `checked_neg` to prevent overflow. |
| **TTL Management** | Balance and Vault keys are always extended together (~30 days) to prevent silent expiry. |
| **Infallible Limit** | `current_limit_safe()` returns `i128::MAX` on overflow so no address is spuriously vaulted. |
| **SEP-41 Compliant** | `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `name`, `symbol`, `decimals`, `balance`. |
| **Typed Events** | `InitializedEvent`, `AdminChangedEvent`, `PoolRegisteredEvent`, `RouterRegisteredEvent`, `TransferEvent`, `ApproveEvent`, `VaultedEvent`, `MintEvent`, `BurnEvent`. |

---

## VII. State Archival (TTL)

Soroban persistent storage has a ~30-day TTL. An entry left untouched past
that window is archived to cold storage — unreadable and unwritable until a
`RestoreFootprintOp` pays to bring it back. A holder dormant for months will
find their balance and vault state archived. HITZ handles this at the
frontend layer using the same lazy-evaluation discipline the contract uses
for vault flags.

### The Lazy-Restore Pattern

1. Simulate the user's intended call.
2. If the RPC returns a `restorePreamble`, extract the archived footprint.
3. Submit a one-op restore tx with that footprint; wait for finalization.
4. Re-simulate against live state and proceed.

**Email (custodial) — gas station**

- Gas sponsor signs and pays for the restore
- User derivation key stays idle
- `RestoreFootprintOp` needs no owner auth
- User sees zero extra prompts

**Wallet (non-custodial) — Stellar Wallets Kit**

- User signs and pays for the restore in XLM
- Consistent with their gas posture
- One additional signature prompt
- Labelled as a state restore

No UI component or page-level code branches on archival. The primitive
`callContract(id, method, args)` carries the restore logic end to end.
Clicking Send after a year-long dormancy is indistinguishable from clicking
Send after a day.

---

## VIII. Security Properties

- **No WASM Hash Laundering.** Pool status is tied to a specific address, not
  a bytecode fingerprint. A malicious actor cannot deploy a fake pool to
  inflate S.
- **Bounded Supply.** The 100M HITZ ceiling is a compile-time constant. Admin
  mint authority exists, but mints that would exceed `MAX_SUPPLY` panic
  atomically. Once the `upgrade` entrypoint is removed for mainnet, the cap
  is unalterable.
- **No Stale Vault.** Lazy evaluation re-syncs the stored vault flag against
  live L on every state-changing call. An outdated flag can't block a user
  whose balance is already safe, nor let a now-oversized holder escape.
- **Integrity-Bound Registrations.** Each registered pool and router stores
  its current WASM hash. A bytecode upgrade trips the integrity check on the
  next state-changing call, forcing admin re-registration before the token
  trusts the address again.
- **No Burn Escape.** Vaulted accounts cannot burn their tokens — burn is
  treated as an exit route and blocked.
- **No Router Escape.** Vaulted accounts cannot route tokens through a DEX
  router. Only a direct sacrifice to an approved pool releases the vault.
- **No Silent Expiry.** Vault flags and balance keys share TTL extension
  calls. An expired vault key would silently free a trapped whale; we prevent
  this by always extending both together.
- **No Mass Underflow.** TotalMass is guarded against underflow. Pool removal
  subtracts the current balance; `adjust_total_mass` panics before going
  negative.

---

## IX. Deployed Contract

**Stellar Mainnet**

| | |
| --- | --- |
| **Contract ID** | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| **WASM Hash** | `6dba0f1f8be9035fe448ac415b3b5ec2c86a0c969c271d09c0afd328249a0529` |
| **Standard** | SEP-41 (Soroban Token Interface) |
| **Decimals** | 7 |
| **Max Supply** | 100,000,000 HITZ |
| **Architecture** | V5 — V4 + Pool/Router Enumeration + Initialized/AdminChanged Events + Mainnet-Hardened |

[View on Stellar Expert →](https://stellar.expert/explorer/public/contract/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU)

---

Gravity HITZ · 2026 · [Legal](./LEGAL.md) · [Open Mainnet](https://skyhitz.io/)
