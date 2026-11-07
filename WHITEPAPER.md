# The Invariant Gravity Model

**A decentralization primitive for Soroban tokens**

*v6.0 · 2026*

---

> HITZ applies a square-root invariant to every transfer. As total liquidity
> grows, individual holding limits rise, but always slower than the reserves
> themselves, permanently bounding concentration. Since November 2026 HITZ
> trades on its own exchange, the Sovereign Vault, whose fee rises while one
> asset is dislocated against another.

> **Note.** This markdown is the canonical text of the whitepaper. It mirrors
> the rendered version at `/whitepaper` on the mainnet site. Keep the two in
> sync: any structural edit here must land in
> `frontend/app/whitepaper/page.tsx` (or vice versa) so readers on both
> surfaces see the same content.

---

## I. The Concentration Problem

Most fungible tokens have no mechanism to prevent a single address from
accumulating an unbounded fraction of supply. Whales can silently dominate
governance, markets, and liquidity without triggering any on-chain constraint.

Existing approaches, such as vesting schedules, transfer limits and
blacklists, are either static, admin-dependent, or trivially circumvented.
None of them self-adjust as the ecosystem grows.

HITZ solves this with a *dynamic, self-adjusting holding limit* rooted in the
amount of real liquidity the protocol has attracted. The more value the
ecosystem holds in trusted pools, the more any individual can hold. But the
relationship is a square root, perpetually sub-linear.

---

## II. The Gravity Model

Define **S** as the **Total Mass**, the sum of HITZ balances held by the
admin-registered pools: today the Sovereign Vault (Section V) and the
treasury account. **S** is an O(1) accumulator updated on every transfer in or
out of a pool.

The **Safety Limit** **L**, displayed in the interface as the
**Event Horizon**, is computed as:

```
L = ⌊ √( S × 10^d ) ⌋
```

where **d** = 7 (Stellar's standard decimal precision). Any account whose
balance exceeds **L** is **vaulted**: it can only send HITZ to a registered
pool until its balance is back under **L**, or until the ecosystem grows
enough that **L** rises above it.

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

**Pools**: `register_pool_address`

- Affect Total Mass S
- Vaulted users can send to them
- A sale into the vault, or a sacrifice, can release a vault
- Never vaulted themselves
- Balance reconciled into S on registration

**Routers**: `register_router_address`

- Never affect Total Mass S
- Pass-through only (the gas sponsor, aggregators)
- Vaulted users CANNOT send to them
- Never vaulted themselves
- No mass reconciliation needed

Both tiers are registered by the admin on a per-address basis, and each
registration binds the address's current Wasm hash. Earlier versions of HITZ
used Wasm hash detection, automatically treating any contract whose bytecode
matched an approved hash as a pool. This was abandoned because DEX factories
allow anyone to deploy a contract with any Wasm hash, enabling laundering via
fake pools. **Strict address whitelisting is the only secure approach.**

---

## IV. Transfer Physics

### The Roach Motel (Silent Trap)

Incoming transfers *never* revert due to vault logic. If a recipient's new
balance exceeds **L**, they are silently vaulted, but the transfer succeeds
and returns a clean SEP-41 void. This is what lets an exchange pay out a
swap's output without ever failing on the buyer's balance.

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
to an approved pool: not to a router, not to any other address. Sending to a
pool reduces the sender's balance and increases **S**, potentially releasing
the vault if the new balance falls below the updated **L**.

### Correction on Receive

After every balance-changing call (transfer, transfer_from, mint, burn) the
recipient's vault flag is re-evaluated against their new balance and the
current **L**, after **S** has been updated. A previously trapped holder whose
balance now sits below **L** (because the ecosystem expanded) is released in
the same transaction. Stored flags are never stale for longer than one
state-changing call.

### Vault Release

An account is released when its balance ≤ **L**. Thanks to lazy evaluation,
release happens automatically on the user's next touch:

1. Sell HITZ into the Sovereign Vault. The vault is a registered pool, so the
   sale is always allowed; the seller is paid in XLM or USDC, and the HITZ
   that enters the vault raises **S** and **L**.
2. Sacrifice: transfer HITZ to a registered pool as a gift. Same effect on
   **S**, nothing back.
3. The ecosystem grows: **S** increases, **L** rises past the account's
   balance, and the next action auto-releases.

The smallest release is the least `x` with `balance − x ≤ √((S + x) × 10^7)`.
For UIs that want to reflect physics without triggering a state change,
`is_actually_vaulted(address)` evaluates the current **L** live, ignoring the
stored flag.

---

## V. The Sovereign Vault

HITZ's own exchange: one constant-product pool per trusted asset, each
against HITZ, all sharing HITZ. It started on November 4, 2026 with XLM and
USDC; more can be listed later without new code, up to 16 in all. HITZ ↔ asset is
one hop through that asset's pool; asset ↔ asset is two hops through HITZ in
one call, and never moves HITZ out of the vault.

**Why HITZ needs its own.** Each pool registration binds the pool's code. On
October 2, 2026 Aquarius upgraded both HITZ pools, the token's integrity guard
stopped trusting them, and trading froze. Rebinding external pools to code
nobody reviewed would hand their price gaps to arbitrageurs and trust code
HITZ doesn't control. The vault is code HITZ controls, under the same 7-day
timelock as the token, and it compounds: HITZ is backed by every listed asset
at once.

### The dislocation fee

Each pool prices HITZ in its asset, and two pools together give the vault's
exchange rate between their assets. Every pool keeps an exponential average
of its own log price (2-hour time constant) and stores how far it sits from
that average: its *deviation*. A pair's *dislocation* is the difference of
the two deviations, so a move in HITZ itself shifts every pool alike and
dislocates nothing. A hop through the pool of asset A pays:

```
fee = 1% × e^(100 × D)     capped at 10%
D   = the largest |dislocation| of A against any reference pool,
      in the state the hop leaves behind
```

| D | Fee |
| --- | --- |
| 0 | 1.00% |
| 0.5% | 1.65% |
| 1% | 2.72% |
| 1.5% | 4.48% |
| 2% | 7.39% |
| 2.30% or more | 10.00% |

- **One asset relative to another.** HITZ's own price never enters D.
- **The worst pair.** A hop pays for its asset's most dislocated pair, so no
  route through a third asset and no split into single hops is cheaper.
- **References.** A pool counts as a reference only if it holds at least 1/8
  of the other pool's HITZ, so a shallow pool can't raise a deep one's fee.
- **Decay.** Deviations decay toward zero with the 2-hour time constant, so
  after a move the fee falls back to 1% on its own.

The fee is withheld from each hop's output and stays in the pool it was
drained from: k never decreases. When the market moves one asset against
another, the vault's rate falls behind; closing that gap is the arbitrage,
and its fee is what deepens the pools.

### Liquidity

The admin seeds each listed asset's pool once, at its market price. After
that anyone can deposit at the pool's current ratio. There are no LP shares
and no withdrawals: nothing leaves the vault except swap outputs.

### Gravity inside the vault

The vault is a registered pool, so the HITZ it holds is Total Mass. A
purchase moves HITZ out of the vault and lowers **S** a little; a sale moves
it in and raises **S**. The token judges a buyer against the **L** the
purchase leaves behind. A vaulted account can always sell into the vault.

### Admin and timelocks

The vault's admin has two powers, both public for 7 days before they can
run: upgrading the code and listing a new trusted asset. Seeding a listed
asset is the admin's too. `renounce_upgrades` ends upgrades for good and
keeps listing; `renounce` ends everything.

---

## VI. Hard Mint Cap

HITZ compiles an absolute supply ceiling into the contract bytecode:

```
MAX_SUPPLY = 100,000,000 × 10^7 stroops
```

The mint entrypoint refuses any call that would push `total_supply` past this
constant. Rejection panics before any state moves: no partial writes, no
dangling events. Burns decrement `total_supply`, so the ceiling re-opens
headroom as tokens exit circulation.

> **Immutability path.** The cap is a Rust `const`. Since v2.0.0 every token
> upgrade is public for 7 days before it can run (`propose_upgrade`, then
> `upgrade`), and `renounce_admin` ends minting, upgrades and registry
> changes for good, at which point the cap is unalterable by any actor.

Two queries expose the state: `total_supply()` returns current circulating
supply, and `max_supply()` returns the compiled ceiling.

---

## VII. On-Chain Implementation

HITZ is a [Soroban](https://stellar.org/developers/soroban) smart contract on
the Stellar network, fully implementing the **SEP-41** token interface.

| Property | Description |
| --- | --- |
| **O(1) Accumulator** | TotalMass is a stateful i128 updated on every pool transfer. No iteration required. |
| **Checked Arithmetic** | Every arithmetic operation uses `checked_add` / `checked_sub` / `checked_neg` to prevent overflow. |
| **TTL Management** | Balance and Vault keys are always extended together (~30 days) to prevent silent expiry. |
| **Infallible Limit** | `current_limit_safe()` returns `i128::MAX` on overflow so no address is spuriously vaulted. |
| **SEP-41 Compliant** | `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `name`, `symbol`, `decimals`, `balance`, with the standard `transfer`, `mint`, `burn` and `approve` events. |
| **Gravity Events** | `vaulted_event`, `pool_registered_event`, `router_registered_event`, `integrity_drift_event`, `initialized_event`, `admin_changed_event`, `upgrade_proposed_event`, `upgrade_cancelled_event`, `upgraded_event`, `admin_renounced_event`. |
| **Timelocked Upgrades** | `propose_upgrade`, a 7-day wait (`pending_upgrade` shows it), then `upgrade`; `renounce_admin` ends it all. |

---

## VIII. State Archival (TTL)

Soroban persistent storage has a ~30-day TTL. An entry left untouched past
that window is archived to cold storage until it is restored. A holder
dormant for months will find their balance and vault state archived. Since
Stellar Protocol 23 a transaction restores the archived entries it touches by
itself, and simulation accounts for them; HITZ's frontend keeps the explicit
restore path below for any RPC that still answers with a restore preamble.

### The Lazy-Restore Pattern

1. Simulate the user's intended call.
2. If the RPC returns a `restorePreamble`, extract the archived footprint.
3. Submit a one-op restore tx with that footprint; wait for finalization.
4. Re-simulate against live state and proceed.

**Email (custodial): gas station**

- Gas sponsor signs and pays for the restore
- User derivation key stays idle
- `RestoreFootprintOp` needs no owner auth
- User sees zero extra prompts

**Wallet (non-custodial): Stellar Wallets Kit**

- User signs and pays for the restore in XLM
- Consistent with their gas posture
- One additional signature prompt
- Labelled as a state restore

No UI component or page-level code branches on archival. The primitive
`callContract(id, method, args)` carries the restore logic end to end.
Clicking Send after a year-long dormancy is indistinguishable from clicking
Send after a day.

---

## IX. Security Properties

- **No Wasm Hash Laundering.** Pool status is tied to a specific address, not
  a bytecode fingerprint. A malicious actor cannot deploy a fake pool to
  inflate S.
- **Bounded Supply.** The 100M HITZ ceiling is a compile-time constant. Admin
  mint authority exists, but mints that would exceed `MAX_SUPPLY` panic
  atomically. Changing the cap takes a public, 7-day upgrade, and none after
  `renounce_admin`.
- **No Stale Vault.** Lazy evaluation re-syncs the stored vault flag against
  live L on every state-changing call. An outdated flag can't block a user
  whose balance is already safe, nor let a now-oversized holder escape.
- **Integrity-Bound Registrations.** Each registered pool and router stores
  its current Wasm hash. A bytecode upgrade trips the integrity check on the
  next state-changing call, and the token stops trusting the address until
  the admin re-registers it.
- **No Burn Escape.** Vaulted accounts cannot burn their tokens. Burn is
  treated as an exit route and blocked.
- **No Router Escape.** Vaulted accounts cannot route tokens through a
  router. Only a transfer to an approved pool, such as a sale into the vault,
  releases the vault.
- **No Silent Expiry.** Vault flags and balance keys share TTL extension
  calls. An expired vault key would silently free a trapped whale; we prevent
  this by always extending both together.
- **No Mass Underflow.** TotalMass is guarded against underflow. Pool removal
  subtracts the current balance; `adjust_total_mass` panics before going
  negative.
- **Timelocked Code.** Neither the token nor the vault can change code, and
  the vault can't list an asset, without a public 7-day notice.
- **No Vault Drain.** The vault has no withdrawals and no LP shares; its
  reserves leave only as swap outputs, and its fee keeps k from ever falling.

---

## X. Deployed Contracts

**Stellar Mainnet**

| HITZ token | |
| --- | --- |
| **Contract ID** | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| **Wasm Hash** | `af53185dfc0e73a4502425d30cea74487ee4bf4d23fcabd32c5f1013626c5d2d` |
| **Release** | `v2.0.0`, validated on Stellar Expert |
| **Standard** | SEP-41 (Soroban Token Interface) |
| **Decimals** | 7 |
| **Max Supply** | 100,000,000 HITZ |

| Sovereign Vault | |
| --- | --- |
| **Contract ID** | `CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU` |
| **Wasm Hash** | `7dea47b29b9ab94c1ea78fa647afc7b7aa065d952cbbf38e3f326dec29547763` |
| **Release** | `sovereign-vault-v1.0.0` |
| **Assets** | XLM, USDC |
| **Integration** | [`INTEGRATION.md`](./contracts/sovereign-vault/INTEGRATION.md) |

[Token on Stellar Expert →](https://stellar.expert/explorer/public/contract/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU) ·
[Vault on Stellar Expert →](https://stellar.expert/explorer/public/contract/CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU)

---

Gravity HITZ · 2026 · [Legal](./LEGAL.md) · [Open Mainnet](https://skyhitz.io/)
