# Integrating with the HITZ Sovereign Vault

For arbitrage bots, wallets and apps that trade HITZ or the vault's trusted
assets (XLM and USDC at launch, more later) through the vault. The
contract-caller pattern, the event layouts and the decay formula below are
exercised by [`tests/integration_guide.rs`](tests/integration_guide.rs)
against the real vault and HITZ token.

## In one paragraph

The vault is HITZ's own exchange: one constant-product pool per trusted
asset, each against HITZ, all sharing HITZ. Any two listed assets trade
through HITZ inside the vault, and such a swap never moves HITZ out. When one
asset moves against another on other venues, the vault's exchange rate
between them falls behind; closing that gap is the trade. The fee is 1% when
the vault is calm and rises exponentially while a pair is dislocated, then
decays back. New trusted assets are listed later without new code, each
announced 7 days ahead. There is no router, no LP token and no oracle: you
call one contract.

## Addresses (mainnet)

| | Contract |
|---|---|
| Sovereign Vault | published at deployment |
| HITZ | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| XLM (native asset contract) | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| USDC (Circle, asset contract) | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |

`hitz()` returns the HITZ contract and `assets()` the listed assets in
listing order, so you can verify them and pick up new listings.

Units: amounts are in each token's own units (7 decimals for HITZ, XLM and
USDC). Exchange rates and fees are 9-decimal fixed point (1.0 =
1,000,000,000; 1% = 10,000,000). Deviations and dislocations are natural
logs in 18 decimals (0.01 = 10,000,000,000,000,000). `rate` compares raw
units, so for two assets with different decimals scale it by 10^(decimals of
quote − decimals of base).

## Calls

```rust
swap(from: Address, to: Address, token_in: Address, token_out: Address,
     amount_in: i128, min_out: i128) -> i128     // exact input, returns amount out
quote(token_in: Address, token_out: Address, amount_in: i128) -> i128
pool(asset: Address) -> PoolState     // asset, hitz, reserve, deviation, dislocation, fee (now)
pools() -> Vec<PoolState>             // every pool, in listing order
rate(base: Address, quote: Address) -> i128          // quote per base, 9 decimals
dislocation(base: Address, quote: Address) -> i128   // ln(rate ÷ its average), 18 decimals
assets() -> Vec<Address>
hitz() -> Address
pending_upgrade() -> Option<PendingUpgrade>   // wasm_hash, eta
pending_listing() -> Option<PendingListing>   // asset, eta
upgradable() -> bool                          // false once the code is frozen
admin() -> Option<Address>                    // None once renounced
```

- **Pairs.** HITZ ↔ any listed asset is one hop. Any two listed assets are
  two hops (the input asset's pool, then the output asset's pool) and pay two
  fees.
- **`swap`** pulls `amount_in` from `from` (who must sign), pays at least
  `min_out` to `to`, or fails. There is no deadline argument: give the
  transaction short time bounds.
- **`quote`** is exactly what `swap` pays in the same ledger. Simulate it, or
  compute it yourself (see "Computing the fee off-chain").
- **`pool(A).fee`** is the fee an infinitesimal hop through A's pool pays
  right now, and `pool(A).dislocation` the D it is priced at. An
  infinitesimal A→B swap pays `pool(A).fee`, then `pool(B).fee`.

### Errors

| Code | Name | When |
|---|---|---|
| 1 | `InvalidAmount` | `amount_in ≤ 0` or `min_out < 0` |
| 2 | `UnsupportedPair` | a token that isn't HITZ or a listed asset, or `token_in == token_out` |
| 3 | `Slippage` | the output would be below `min_out` |
| 4 | `NotSeeded` | an asset that is listed but not yet seeded |
| 7 | `InvalidAddress` | `from` or `to` is the vault itself |
| 9 | `InvalidPool` | `pool`, `rate` or `dislocation` for an asset that isn't listed |
| 10 | `TradeTooSmall` | the output rounds to zero after the fee |
| 11 | `Overflow` | amounts far beyond any real supply |

Codes 5, 6, 8 and 12-18 belong to deployment, seeding, deposits, listing and
upgrades.

## The fee

### Deviations and dislocations

```text
price(A)          = reserve_A / hitz_A                     A per HITZ, from A's pool
deviation(A)      = ln price(A) − its exponential average  (2-hour time constant)
rate(A, B)        = price(B) / price(A)                    B per A
dislocation(A, B) = deviation(B) − deviation(A)            = ln(rate(A, B) ÷ its average)
```

The averages are taken in log space, so they agree across pairs:
dislocation(A, C) = dislocation(A, B) + dislocation(B, C). A move in HITZ
itself shifts every pool's price alike and cancels out: it dislocates
nothing.

### What a hop pays

```text
fee = 1% × e^(100 × D)     capped at 10%
D   = max |dislocation(A, R)| over A's reference pools R,
      in the state the hop leaves behind (computed without the fee)
```

R is a reference for A if it is another seeded pool holding at least 1/8 of
A's pool's HITZ. With no reference, D is 0.

| D | Fee |
|---|---|
| 0 | 1.00% |
| 0.5% | 1.65% |
| 1% | 2.72% |
| 1.5% | 4.48% |
| 2% | 7.39% |
| 2.30% or more | 10.00% |

- **With XLM and USDC only**, both hops of every swap pay for the XLM/USDC
  dislocation: fee = 1% × (rate ÷ average)^100.
- **The worst pair, whatever you trade.** A hop through A's pool pays for A's
  most dislocated pair, not only the pair in your swap. The fee therefore
  doesn't depend on the route: A→HITZ then HITZ→B pays exactly what A→B pays,
  and A→C→B only adds hops. Detours never pay; don't search for them.
- **Spillover.** While one asset is dislocated, every pool that references it
  charges for it. With XLM moving and EURC listed, a USDC→EURC swap pays
  about what an XLM→USDC swap does.
- **Priced at the end.** Each hop pays the fee for the dislocation it leaves
  behind, and the fee is withheld from that hop's output. A trade that moves
  a pair far pays the fee for its whole size.
- **Two hops, two fees.** In an XLM→USDC swap the first hop moves the XLM
  pool and the second the USDC pool; the second sees the whole move, so its
  fee is higher.
- **Splitting.** Several `swap` calls in one transaction each pay the fee for
  the state they leave behind, so the earlier ones pay less. The vault allows
  this; it can't get you below the curve along the path.
- **Decay.** Deviations decay toward zero with a 2-hour time constant
  (half-life about 83 minutes). Only trades move prices; deposits keep them.
  With no trades in between:

  ```text
  dislocation(t + dt) = dislocation(t) × e^(−dt / 7200)
  ```

  So after a move the fee falls back toward 1% on its own, and waiting is
  part of the strategy.

### Computing the fee off-chain

[`research/vault-backtest/vaultmath.py`](../../research/vault-backtest/vaultmath.py)
is an integer-exact reference implementation (`swap`, `hop`, `pool_state`,
`fee_for_dislocation`, `decayed`, `ln_ratio`). `python3 vaultmath.py --check`
replays golden vectors that the contract's own test asserts across three
assets, so it can't silently drift. In Rust, `fee_for_dislocation`,
`decayed`, `ln_ratio` and `pow_sat` are public in the `sovereign-vault`
crate.

To reproduce a quote exactly, start from `pools()` read in the same ledger:
each pool's reserves and its deviation brought to that ledger's time. Rounding:
the constant-product output rounds down, the fee rate and fee amount round up,
and logs, decay and averages use Rust's truncating division.

## Arbitrage

For two listed assets A and B, with market rate `M` (B per A) and the vault's
`rate(A, B)` `R`:

- `R > M`: A is dear in the vault. Swap A→B in the vault, buy A back
  elsewhere.
- `R < M`: swap B→A in the vault, sell the A elsewhere.

There is no fixed threshold: the first unit pays `pool(A).fee` and
`pool(B).fee` (so at least ~2%), and every further unit pays more. Size the
trade by maximizing

```text
profit(a) = quote(A→B, a) − a × M × (1 + your external cost) − gas
```

over `a` (or the mirror image for B→A). The curve can have two peaks: a small
trade under the steep part of the fee, and, after a big move, a large one
once the fee is capped at 10%. Scan a coarse log grid first, then refine
around the best point with a golden-section search: about a hundred quote
evaluations. Splitting into several calls in one transaction lifts the peak
somewhat.

With more than two assets, watch every pair: the pools are shared, so a trade
in one pair changes the fees of the others. Re-read `pools()` after each
listing.

Set `min_out` a little under your computed output: between simulation and
inclusion the deviations keep decaying and other trades may land first.

## Calling from a contract

If your bot is a contract that trades its own funds (for example inside a
flash loan), it calls `swap` with `from` = itself. The vault then calls
`token_in.transfer(bot, vault, amount_in)`. That transfer is one level below
your call, so your contract must authorize it before calling the vault:

```rust
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    vec, Address, Env, IntoVal, Symbol,
};

/// Authorize the one transfer the vault will make out of this contract.
fn allow_vault_pull(env: &Env, token: &Address, vault: &Address, amount: i128) {
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (env.current_contract_address(), vault.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
}

// In your contract:
let me = env.current_contract_address();
allow_vault_pull(&env, &token_in, &vault, amount_in);
let out = SovereignVaultClient::new(&env, &vault)
    .swap(&me, &me, &token_in, &token_out, &amount_in, &min_out);
```

`SovereignVaultClient` comes from the `sovereign-vault` crate, or from
`soroban_sdk::contractimport!` on the released Wasm. The vault's own
`from.require_auth()` passes automatically because your contract is the
direct caller. Without `allow_vault_pull` the swap fails with
an authorization error. For several swaps in one call, authorize each pull
right before its swap (see `trade_through_hitz` in the test).

## Calling from an account

JavaScript (`@stellar/stellar-sdk` 15):

```js
import { Address, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

const server = new rpc.Server(RPC_URL);
const vault = new Contract(VAULT_ID);
const addr = (a) => new Address(a).toScVal();
const i128 = (v) => nativeToScVal(v, { type: "i128" });
// A fresh account per transaction: build() increments its sequence number.
const build = async (op) =>
  new TransactionBuilder(await server.getAccount(keypair.publicKey()), {
    fee: "1000",
    networkPassphrase: Networks.PUBLIC,
  }).addOperation(op).setTimeout(30).build();

// Quote 10 XLM -> USDC by simulation.
const sim = await server.simulateTransaction(await build(vault.call("quote", addr(XLM), addr(USDC), i128(100_000_000n))));
if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(sim.error);
const out = scValToNative(sim.result.retval); // bigint, 7 decimals

// Swap with a small margin under the quote.
const me = addr(keypair.publicKey());
let tx = await build(vault.call("swap", me, me, addr(XLM), addr(USDC), i128(100_000_000n), i128((out * 995n) / 1000n)));
tx = await server.prepareTransaction(tx); // footprint, resource fee, auth
tx.sign(keypair);
await server.sendTransaction(tx);
```

Stellar CLI:

```bash
stellar contract invoke --id $VAULT --source bot --network mainnet -- pools
stellar contract invoke --id $VAULT --source bot --network mainnet -- \
  quote --token_in $XLM --token_out $USDC --amount_in 100000000
stellar contract invoke --id $VAULT --source bot --network mainnet -- \
  swap --from $BOT --to $BOT --token_in $XLM --token_out $USDC \
       --amount_in 100000000 --min_out 17000000
```

## Events

Within one `swap` transaction the order is: the token transfers (input pulled,
output paid), one `hop` per pool, then `swap`. Event data are maps with
sorted keys.

| Event | Topics | Data |
|---|---|---|
| `hop` | `"hop"`, asset (the pool's) | `amount_in`, `amount_out`, `dislocation` (the D the fee was priced at), `fee_amount` (in the hop's output token), `fee_rate`, `hitz_in` (bool), `reserve_asset`, `reserve_hitz` (that pool after the hop) |
| `swap` | `"swap"`, from, to | `amount_in`, `amount_out`, `token_in`, `token_out` |
| `deposit` | `"deposit"`, from, asset | `amount`, `hitz` (added to that pool) |
| `seeded` | `"seeded"`, asset | `amount`, `hitz` (the pool's starting reserves) |
| `listing_proposed` | `"listing_proposed"`, asset | `eta` (ledger time it can be listed) |
| `listing_cancelled`, `listed` | the name, asset | none |
| `upgrade_proposed` | `"upgrade_proposed"` | `wasm_hash`, `eta` |
| `upgrade_cancelled`, `upgraded` | the name | `wasm_hash` |
| `upgrades_renounced` | `"upgrades_renounced"`, admin | none |
| `renounced` | `"renounced"`, previous admin | none |

You can follow the reserves from events alone: `listed` adds an empty pool,
`seeded` sets its reserves, each `hop` carries its pool's reserves after the
trade, and a `deposit` adds its amounts to its pool. Deviations follow from
the reserves and the ledger times, or read them from `pools()`.

## HITZ and the Gravity model

- **Asset-to-asset swaps never move HITZ**, so none of this touches them.
- **Holding HITZ.** An account whose HITZ balance goes above the token's
  limit L (`safety_limit()` on the HITZ contract, about 9,924 HITZ today) is
  "vaulted": it can still receive, and it can always sell into the vault,
  but it can't send HITZ anywhere else. A bot that buys and sells
  HITZ inside one transaction is vaulted for a moment and released when it
  sells; nothing fails.
- **HITZ token events.** The standard ones follow SEP-41: `transfer`
  `[from, to]`, `mint` `[to]` and `burn` `[from]` with the amount as data, and
  `approve` `[from, spender]` with `[amount, expiration_ledger]`. Until this
  upgrade they were named `transfer_event`, `mint_event`, `burn_event` and
  `approve_event`, so older history uses those names. The Gravity events keep
  theirs: `vaulted_event` has the account as topic and the new state as data.

## What can change

- **Code**, only through `propose_upgrade`, then a 7-day wait, then
  `upgrade`. Watch for `upgrade_proposed` (or poll `pending_upgrade()`) and
  re-check the Wasm hash after an `upgraded`. Once `upgradable()` is false
  (`upgrades_renounced` or `renounced`), the code can never change.
- **The listed assets**, only through `propose_listing`, then a 7-day wait,
  then `list_asset` and the admin's `seed`. Watch `listing_proposed` (or poll
  `pending_listing()`), `listed` and `seeded`. From seeding on, the new pool
  trades against every other one and, where it holds at least 1/8 of another
  pool's HITZ, counts in that pool's fee. Assets are never delisted. Once
  `admin()` returns `None`, the asset list is final too.
- The fee parameters are constants in the code, so they change only through
  an upgrade.
- The vault calls nothing but the HITZ contract and the listed assets'
  contracts. An issuer that freezes the vault's balance stops only that
  asset's pool; every other pair keeps trading. Simulation restores any
  archived ledger entry automatically, and every swap keeps the vault's own
  state alive.
