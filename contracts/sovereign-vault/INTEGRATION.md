# Integrating with the HITZ Sovereign Vault

For arbitrage bots, wallets and apps that trade XLM, USDC or HITZ through the
vault. The contract-caller pattern, the event layout and the anchor formula
below are exercised by [`tests/integration_guide.rs`](tests/integration_guide.rs)
against the real vault and HITZ token.

## In one paragraph

The vault is HITZ's own exchange: two constant-product pools, HITZ/XLM and
HITZ/USDC, that share HITZ. Together they are an **XLM/USDC market**: an
XLM↔USDC swap goes through HITZ inside the vault and never moves HITZ. When
XLM moves on other venues, the vault's XLM price falls behind; closing that
gap is the trade. The fee is 1% when the vault is calm and rises
exponentially while its XLM price is moving, then decays back. There is no
router, no LP token and no oracle: you call one contract.

## Addresses (mainnet)

| | Contract |
|---|---|
| Sovereign Vault | published at deployment |
| HITZ | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| XLM (native asset contract) | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| USDC (Circle, asset contract) | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |

`tokens()` on the vault returns `(hitz, xlm, usdc)`, so you can verify them.
All amounts are in 7-decimal units (1 XLM = 10,000,000). Prices and fees are
in 9-decimal fixed point (1.0 = 1,000,000,000; 1% = 10,000,000).

## Calls

```rust
swap(from: Address, to: Address, token_in: Address, token_out: Address,
     amount_in: i128, min_out: i128) -> i128     // exact input, returns amount out
quote(token_in: Address, token_out: Address, amount_in: i128) -> i128
market() -> Market        // reserves, xlm_price, anchor_price, fee (all at this ledger)
reserves() -> Reserves    // hitz_xlm, xlm, hitz_usdc, usdc
tokens() -> (Address, Address, Address)
pending_upgrade() -> Option<PendingUpgrade>      // wasm_hash, eta
admin() -> Option<Address>                       // None once renounced
```

- **Pairs.** HITZ↔XLM and HITZ↔USDC are one hop. XLM↔USDC is two hops
  (XLM pool, then USDC pool, or the reverse) and pays two fees.
- **`swap`** pulls `amount_in` from `from` (who must sign), pays at least
  `min_out` to `to`, or fails. There is no deadline argument: give the
  transaction short time bounds.
- **`quote`** is exactly what `swap` pays in the same ledger. Simulate it, or
  compute it yourself (see "Computing the fee off-chain").
- **`market().fee`** is the fee an infinitesimal trade would pay right now.

### Errors

| Code | Name | When |
|---|---|---|
| 1 | `InvalidAmount` | `amount_in ≤ 0` or `min_out < 0` |
| 2 | `UnsupportedPair` | a token that isn't HITZ, XLM or USDC, or `token_in == token_out` |
| 3 | `Slippage` | the output would be below `min_out` |
| 4 | `NotSeeded` | before the vault has liquidity |
| 7 | `InvalidAddress` | `from` or `to` is the vault itself |
| 10 | `TradeTooSmall` | the output rounds to zero after the fee |
| 11 | `Overflow` | amounts far beyond any real supply |

Codes 5, 6, 8, 9 and 12-15 belong to deployment, seeding, deposits and upgrades.

## The fee

```text
xlm_price = (usdc / hitz_usdc) / (xlm / hitz_xlm)          USDC per XLM, from the reserves
fee       = 1% × (price after the hop ÷ anchor)^100        ratio taken ≥ 1, capped at 10%
```

| Price after the hop vs anchor | Fee |
|---|---|
| at the anchor | 1.00% |
| ±0.5% | 1.64% |
| ±1% | 2.70% |
| ±2% | 7.24% |
| ±2.4% or more | 10.00% |

- **Priced at the end.** Each hop pays the fee for the XLM price it leaves
  behind (computed without the fee), and the fee is withheld from that hop's
  output. A trade that moves the price far pays the fee for its whole size.
- **Two hops, two fees.** In an XLM→USDC swap the first hop moves the price
  part of the way and the second hop the rest, so the second fee is higher.
- **Splitting.** Several `swap` calls in one transaction each pay the fee for
  the price they leave behind, so the earlier ones pay less. The vault allows
  this; it can't get you below the curve along the path.
- **The anchor** is an exponential average of the vault's own XLM price with a
  2-hour time constant (half-life about 83 minutes). Each swap stores it, and
  only trades move the price (deposits keep it). From one `market()` reading
  at time `t`, with no trades since:

  ```text
  anchor(t + dt) = price + (anchor(t) − price) × e^(−dt / 7200)
  ```

  So after a move the fee falls back toward 1% on its own, and waiting is
  part of the strategy.

### Computing the fee off-chain

[`research/vault-backtest/vaultmath.py`](../../research/vault-backtest/vaultmath.py)
is an integer-exact reference implementation (`hop`, `run_route`,
`anchor_now`, `fee_for_price`). `python3 vaultmath.py --check` replays golden
vectors that the contract's own test asserts, so it can't silently drift. In
Rust, `fee_for_price` and `pow_sat` are public in the `sovereign-vault`
crate.

Rounding, for exact reproduction: the constant-product output and the price
round down, the fee amount and the price ratio round up, and the anchor uses
Rust's truncating division.

## Arbitrage

With market price `M` (USDC per XLM) and the vault's `xlm_price` `P`:

- `P > M`: XLM is dear in the vault. Swap XLM→USDC in the vault, buy XLM back
  elsewhere.
- `P < M`: swap USDC→XLM in the vault, sell the XLM elsewhere.

There is no fixed threshold: the first unit pays `market().fee` on each of
the two hops (so at least ~2%), and every further unit pays more. Size the
trade by maximizing

```text
profit(a) = quote(XLM→USDC, a) − a × M × (1 + your external cost) − gas
```

over `a` (or the mirror image for USDC→XLM). The curve can have two peaks:
a small trade under the steep part of the fee, and, after a big move, a
large one once the fee is capped at 10%. Scan a coarse log grid first, then
refine around the best point with a golden-section search: about a hundred
quote evaluations. Splitting into several calls in one transaction lifts
the peak somewhat.

Set `min_out` a little under your computed output: between simulation and
inclusion the anchor keeps moving and other trades may land first.

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
stellar contract invoke --id $VAULT --source bot --network mainnet -- market
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
| `hop` | `"hop"`, pool (`u32`: 0 = XLM pool, 1 = USDC pool) | `amount_in`, `amount_out`, `fee_amount` (in the hop's output token), `fee_rate`, `hitz_in` (bool), `reserve_hitz`, `reserve_quote` (that pool after the hop) |
| `swap` | `"swap"`, from, to | `amount_in`, `amount_out`, `token_in`, `token_out` |
| `deposit` | `"deposit"`, from, pool | `hitz`, `quote` (added to that pool) |
| `seeded` | `"seeded"` | `hitz_xlm`, `xlm`, `hitz_usdc`, `usdc` |
| `upgrade_proposed` | `"upgrade_proposed"` | `wasm_hash`, `eta` (ledger time it can run) |
| `upgrade_cancelled`, `upgraded` | the name | `wasm_hash` |
| `renounced` | `"renounced"`, previous admin | |

You can follow the reserves from events alone: `seeded` sets them, each
`hop` carries its pool's reserves after the trade, and a `deposit` adds its
amounts to its pool.

## HITZ and the Gravity model

- **XLM↔USDC swaps never move HITZ**, so none of this touches them.
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

- The vault's code changes only through `propose_upgrade`, then a 7-day wait,
  then `upgrade`. Watch for `upgrade_proposed` (or poll `pending_upgrade()`)
  and re-check the Wasm hash after an `upgraded`. Once `admin()` returns
  `None` the vault can never change.
- The fee parameters are constants in the code, so they change only through
  that same upgrade path.
- The vault calls nothing but the three token contracts. Simulation restores
  any archived ledger entry automatically, and every swap keeps the vault's
  own state alive.
