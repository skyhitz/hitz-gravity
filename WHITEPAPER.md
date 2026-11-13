# HITZ Protocol

**Oracle-free, protocol-owned liquidity on Stellar**

*Whitepaper v7.0 · November 2026*

---

> HITZ Protocol is an oracle-free financial primitive on Stellar (Soroban).
> Its goal is to solve liquidity provisioning without depending on outside
> capital (mercenary LPs) or outside price feeds (oracles). Two contracts
> form a closed loop. The Sovereign Vault, HITZ's own exchange, owns its
> liquidity, follows the market through arbitrage instead of an oracle, and
> keeps part of every arbitrage profit in its pools as a fee, so the
> liquidity compounds. The HITZ token bounds concentration per account: an
> account holding more than the Event Horizon L = √S, where S is the HITZ in
> the protocol's pools, can send HITZ only back into a pool.

> **Note.** This markdown is the canonical text of the whitepaper. It mirrors
> the rendered version at `/whitepaper` on the mainnet site. Keep the two in
> sync: any structural edit here must land in
> `frontend/app/whitepaper/page.tsx` (or vice versa) so readers on both
> surfaces see the same content.

---

## I. The Liquidity Problem

A token is only as usable as the liquidity behind it, and most tokens rent
theirs.

- **Mercenary liquidity.** Liquidity providers deposit for incentives and
  withdraw when the incentives end, often when the market needs them most.
  Paying them costs the project tokens, and the depth leaves with them.
- **Oracles.** A pool that prices itself from an outside feed trusts the
  feed's operator and inherits its failures: stale updates, outages and
  manipulation.
- **Arbitrage leakage.** A plain constant-product pool needs neither, but
  every time the market moves, arbitrageurs take the price gap out of the
  pool, and a flat fee keeps only a small share of it.

HITZ's first pools, on Aquarius, show the last point: from May 22 to
October 2, 2026, 3,031 arbitrage cycles took $52.78 from about $2,800 of
liquidity, while the pools' half of the 0.1% fee kept about $4.

HITZ Protocol answers all three with liquidity the protocol owns, priced by
arbitrage, behind a fee that keeps most of what the arbitrage is worth.

---

## II. The Closed Loop

Two contracts, each with one job, feed each other:

1. **The vault owns the liquidity.** One constant-product pool per trusted
   asset (XLM and USDC today), each against HITZ. The protocol seeded it,
   anyone can add to it, and nothing leaves it except swap outputs
   (Section III).
2. **Arbitrage keeps its prices.** When one asset moves against another
   elsewhere, the vault's rate between them falls behind until someone
   trades it back. There is no oracle to wait for.
3. **The fee keeps the profit.** The fee rises with how far a trade moves
   one asset against another and stays in the pool it came from, so the
   arbitrage that restores the price pays the vault for most of the gap.
   Every trade leaves k, the pools' depth, a little higher.
4. **The token ties holdings to that depth.** The HITZ in the protocol's
   pools is Total Mass S, and no account can hold more than L = √S HITZ and
   still move it freely (Section IV). Above L, HITZ can only go back into a
   pool, which adds to S.

The loop needs no price feed and no liquidity provider who can leave. What
it needs is trading: arbitrage to keep the price honest, and flow
(purchases, sales, the HITZ Terminal's subscriptions) for the fee to
compound on.

---

## III. The Sovereign Vault

HITZ's own exchange: one constant-product pool per trusted asset, each
against HITZ, all sharing HITZ. It started on November 4, 2026 with XLM and
USDC; more can be listed later without new code, up to 16 in all. HITZ ↔
asset is one hop through that asset's pool; asset ↔ asset is two hops
through HITZ in one call, and never moves HITZ out of the vault.

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

### Protocol-owned liquidity

The admin seeds each listed asset's pool once, at its market price. After
that anyone can deposit at the pool's current ratio, as a contribution:
there are no LP shares and no withdrawals, and nothing leaves the vault
except swap outputs. The liquidity HITZ trades against can't be pulled.

The vault's liquidity came from the protocol's own Aquarius positions: 10%
seeded on November 4, 2026 and the rest deposited on November 9, about
$5,800 in all (live figures at `https://skyhitz.io/api/v1/vault`).

### Arbitrage instead of an oracle

The vault reads no price feed. When the market moves, its rate lags until
an arbitrageur trades it back, and anyone may: the integration guide
documents the calls and how to size a trade. Skyhitz runs an open-source bot
that does it every five minutes from a public account
(`https://skyhitz.io/api/v1/bot`), paying the same fees as everyone. It buys
on the Stellar DEX the asset the vault overpays for, then sells it into the
vault, with on-chain minimums on both legs.

Replayed on the Stellar DEX's real prices from June 12 to November 11,
2026, at the vault's depth of November 11: without a bot the vault's XLM
price sat 8.6% off the market on average, and more than 5% off 64% of the
time; with the bot, 2.1% off on average, and more than 5% off 3% of the
time.

### What the fee keeps

The fee prices how far a trade moves one asset's rate from its recent
average. The trade that brings the vault to a new market price therefore
pays most of the gap, in steps as the average catches up.

- **Against a flat fee.** Replayed from May 22 to October 31, 2026 on the
  real XLM price, from the old pools' reserves, with an arbitrageur
  calibrated to their real history, the vault's fee gained $54.15 over
  holding the assets, against $8.02 for the Aquarius pools' 0.1%, and
  arbitrage took $13.35 from the pools instead of $62.44.
- **Who keeps the arbitrage.** In the bot replay, the vault's fees came to
  67% to 89% of what the arbitrage made in all, depending on how large a
  profit the arbitrageur waited for: $37.72 for the vault against $6.78 for
  the bot at the bot's own setting.

### Flow into the vault

Three kinds of trade pay the fee: arbitrage, people buying and selling
HITZ, and the HITZ Terminal. The Terminal sells XLM market, leverage and
on-chain flow data; its paid plans are priced in dollars and paid in USDC or
XLM, and each payment is one vault swap that buys HITZ and sends it to the
treasury. The vault earns its fee on every subscription.

### The Event Horizon inside the vault

The vault is a registered pool, so the HITZ it holds is Total Mass. A
purchase moves HITZ out of the vault and lowers **S** a little; a sale moves
it in and raises **S**. The token judges a buyer against the **L** the
purchase leaves behind. A vaulted account can always sell into the vault.

### Why HITZ runs its own exchange

Each pool registration binds the pool's code. On October 2, 2026 Aquarius
upgraded both HITZ pools, the token's integrity guard stopped trusting them,
and trading froze. Rebinding external pools to code nobody reviewed would
hand their price gaps to arbitrageurs and trust code HITZ doesn't control.
The vault is code HITZ controls, under the same 7-day timelock as the token,
and it trades HITZ against every listed asset at once.

---

## IV. The Event Horizon

Define **S** as the **Total Mass**, the sum of HITZ balances held by the
admin-registered pools: today the Sovereign Vault and the treasury. **S** is
an O(1) accumulator updated on every transfer in or out of a pool.

The **Safety Limit** **L**, displayed in the interface as the
**Event Horizon**, is computed as:

```
L = ⌊ √( S × 10^d ) ⌋
```

where **d** = 7 (Stellar's standard decimal precision), so that in whole
HITZ, L = √S. Any account whose balance exceeds **L** is **vaulted**: it can
only send HITZ to a registered pool until its balance is back under **L**,
or until the vault grows enough that **L** rises above it.

> **Square-root rule.** L grows with the square root of S: a 10,000× deeper
> vault allows a 100× larger account. As the vault deepens, the most one
> account can hold shrinks as a share of it.

| Total Mass (S) | Event Horizon (L) | L as a share of S |
| --- | --- | --- |
| 100 HITZ | 10 HITZ | 10% |
| 10,000 HITZ | 100 HITZ | 1% |
| 1,000,000 HITZ | 1,000 HITZ | 0.1% |
| 100,000,000 HITZ | 10,000 HITZ | 0.01% |

Today S is about 98.4 million HITZ and L about 9,900 HITZ.

### What the limit does not do

- **It limits accounts, not people.** Stellar has no identity layer, so one
  owner can hold HITZ in many accounts, each under L. The rule guarantees
  something narrower: no single account can hold more than L and still move
  it freely.
- **It does not cap purchases.** Incoming transfers never fail (Section VI),
  so an account can buy far past L; it can then only sell back into the
  vault.
- **Anyone can push an account over L** by sending it HITZ. The account can
  still sell into the vault, and is released once it is back under L.
- **Registered pools and routers are exempt.** Today: the vault; the
  treasury, which is the admin's account, holds about 9.96 million HITZ and
  is registered as a pool, so its HITZ counts in S; and the email gateway's
  gas sponsor, a router holding about 33,000 HITZ for the legacy
  reparation.

---

## V. Pools and Routers

Not all contract addresses are equal. HITZ distinguishes two classes of
trusted infrastructure, each with its own rules:

**Pools**: `register_pool_address`

- Affect Total Mass S
- Vaulted users can send to them
- A sale into the vault, or a sacrifice, can release a vault
- Never vaulted themselves
- Balance reconciled into S on registration

**Routers**: `register_router_address`

- Never affect Total Mass S
- Pass-through only (today the email gateway's gas sponsor)
- Vaulted users CANNOT send to them
- Never vaulted themselves
- No mass reconciliation needed

Both tiers are registered by the admin on a per-address basis, and each
registration binds the address's current Wasm hash. Earlier versions of HITZ
used Wasm hash detection, automatically treating any contract whose bytecode
matched an approved hash as a pool. This was abandoned because DEX factories
allow anyone to deploy a contract with any Wasm hash, enabling laundering via
fake pools. **Pool status is granted per address, never by bytecode.**

---

## VI. Transfer Rules

### Incoming transfers always succeed

Incoming transfers *never* revert due to vault logic. If a recipient's new
balance exceeds **L**, the recipient is vaulted, but the transfer succeeds
and returns a clean SEP-41 void. This is what lets an exchange pay out a
swap's output without ever failing on the buyer's balance.

### The sender gate (lazy-synced)

Before the sender gate fires, the sender's stored vault flag is re-synced
against the current **L**. If the vault grew past the sender's balance
since they were last vaulted, the flag clears inline and the transfer
proceeds. No wall around an account whose balance is already safe. After the
live re-sync, a still-vaulted sender is blocked unless all four conditions
hold:

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

### Correction on receive

After every balance-changing call (transfer, transfer_from, mint, burn) the
recipient's vault flag is re-evaluated against their new balance and the
current **L**, after **S** has been updated. A previously vaulted holder
whose balance now sits below **L** (because the vault grew) is released in
the same transaction. Stored flags are never stale for longer than one
state-changing call.

### Vault release

An account is released when its balance ≤ **L**. Thanks to lazy evaluation,
release happens automatically on the user's next touch:

1. Sell HITZ into the Sovereign Vault. The vault is a registered pool, so the
   sale is always allowed; the seller is paid in XLM or USDC, and the HITZ
   that enters the vault raises **S** and **L**.
2. Sacrifice: transfer HITZ to a registered pool as a gift. Same effect on
   **S**, nothing back.
3. The vault grows: **S** increases, **L** rises past the account's balance,
   and the next action auto-releases.

The smallest release is the least `x` with `balance − x ≤ √((S + x) × 10^7)`.
For UIs that want to reflect the rule without triggering a state change,
`is_actually_vaulted(address)` evaluates the current **L** live, ignoring the
stored flag.

---

## VII. Supply

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

The supply is fully minted. Where it is on November 13, 2026:

| Holder | HITZ | Share |
| --- | --- | --- |
| Sovereign Vault (its pools) | 88,420,475 | 88.4% |
| Treasury (the admin's account, a registered pool) | 9,963,901 | 10.0% |
| Gas sponsor of the email gateway (a registered router) | 32,966 | 0.03% |
| Every other account | 1,582,658 | 1.6% |

---

## VIII. Admin, Timelocks and Decentralization

HITZ Protocol is decentralized by design: prices need no oracle, the
liquidity needs no outside LPs, and anyone can trade, deposit or arbitrage.
The exception is the admin role. Today one account (`GCAETBNB…OKGU`) is the
admin of both contracts and is the treasury.

| Power | Contract | Takes effect |
| --- | --- | --- |
| Upgrade the code | token, vault | after a public 7-day notice |
| List a new trusted asset | vault | after a public 7-day notice |
| Seed a newly listed asset's pool, once | vault | immediately |
| Register or remove pools and routers | token | immediately |
| Hand the admin role to another account (both sign) | token | immediately |
| Mint, up to the cap | token | immediately (fully minted, so only after burns) |

Registry changes are the strongest immediate power: registering an address
exempts it from the Event Horizon, and removing the vault from the registry
would cut **S** to the treasury's balance, lower **L** to about 3,160 HITZ
and stop the vault from paying out HITZ. The vault's
admin can't be rotated, so the account's own signers are what protect it
(AUDIT.md, findings T-3 and V-3).

Each contract has a one-way exit:

- `renounce_upgrades` freezes the vault's code for good and keeps the
  timelocked listing; `renounce` ends every vault power.
- `renounce_admin` ends minting, upgrades and registry changes on the token
  for good. It refuses while any registered address is a classic account or
  runs code other than its approved hash, so the registry must be final
  first. Today the treasury and the gas sponsor are classic accounts in it.

---

## IX. On-Chain Implementation

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

## X. State Archival (TTL)

Soroban persistent storage has a ~30-day TTL. An entry left untouched past
that window is archived to cold storage until it is restored. A holder
dormant for months will find their balance and vault state archived. Since
Stellar Protocol 23 a transaction restores the archived entries it touches by
itself, and simulation accounts for them; HITZ's frontend keeps the explicit
restore path below for any RPC that still answers with a restore preamble.

### The lazy-restore pattern

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

## XI. Security Properties

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
  its approved Wasm hash. If its code changes, the next state-changing call
  emits an `integrity_drift_event` and the address can no longer spend
  allowances; the admin reviews the new code and re-registers or removes it.
- **No Burn Escape.** Vaulted accounts cannot burn their tokens. Burn is
  treated as an exit route and blocked.
- **No Router Escape.** Vaulted accounts cannot route tokens through a
  router. Only a transfer to an approved pool, such as a sale into the vault,
  releases the vault.
- **No Silent Expiry.** Vault flags and balance keys share TTL extension
  calls. An expired vault key would silently free a vaulted account; we
  prevent this by always extending both together.
- **No Mass Underflow.** TotalMass is guarded against underflow. Pool removal
  subtracts the current balance; `adjust_total_mass` panics before going
  negative.
- **Timelocked Code.** Neither the token nor the vault can change code, and
  the vault can't list an asset, without a public 7-day notice.
- **No Vault Drain.** The vault has no withdrawals and no LP shares; its
  reserves leave only as swap outputs, and its fee keeps k from ever falling.

Both contracts have been reviewed internally ([AUDIT.md](./AUDIT.md)), with
the findings and their status published; neither has had an independent
audit yet.

---

## XII. Known Limits

- **Per account, not per person.** The Event Horizon can be spread across
  many accounts (Section IV).
- **Prices lag the market.** Without an oracle, the vault's price follows
  the market only as fast as arbitrage moves it: 2.1% off on average in the
  bot replay, more in fast moves. If no one arbitrages, its price goes stale.
- **L is small today.** At November 2026 prices L is worth about $0.32, so
  almost any purchase vaults the buyer: that HITZ can then only be sold back
  into the vault, until the vault grows enough to raise L. The swap screen
  says so before you sign.
- **Purchases pay the fee too.** Every hop pays at least 1%, and a purchase
  through one pool dislocates it against the others. At the vault's depth of
  November 2026, $5 of XLM buys HITZ at about 2.2% all in, and $20 or more
  at 11% or more, with the fee at its 10% cap. The swap screen shows the fee
  before you sign; buying in smaller steps hours apart pays less.
- **Thin liquidity.** About $5,800 in all: large trades move the price far.
- **Listed assets carry their issuers' risk.** Circle can freeze the vault's
  USDC, which would stop the USDC pool; any listed asset's issuer has the
  same power over its own pool.
- **Admin powers remain** until renounced (Section VIII).

---

## XIII. Deployed Contracts

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

HITZ Protocol · 2026 · [Legal](./LEGAL.md) · [Open the app](https://skyhitz.io/)
