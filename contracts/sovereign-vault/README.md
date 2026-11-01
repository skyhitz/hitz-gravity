# Sovereign Vault

HITZ's own exchange. Two constant-product pools share HITZ:

| Pool | Id | Reserves |
|---|---|---|
| XLM pool | `0` | HITZ / XLM |
| USDC pool | `1` | HITZ / USDC |

Together they make the vault an XLM/USDC market with HITZ as the bridge. Every
XLM move opens a gap between the two pools, arbitrage closes it through the
vault, and the fee keeps that value in the reserves. HITZ is backed by XLM and
USDC and compounds with volatility.

No other contract can halt it: the vault calls nothing but the three token
contracts, and the HITZ token treats a changed third-party contract as an alert,
never a stop.

## Fee

The vault's **XLM price** is the USDC per XLM implied by its pools:
`(usdc / hitz_usdc) / (xlm / hitz_xlm)`. The **anchor** is that price averaged
over time (exponential average, 2-hour time constant). A trade pays

```text
fee = 1% × (XLM price after the trade ÷ anchor)^100     ratio taken ≥ 1, capped at 10%
```

| Price vs anchor | Fee |
|---|---|
| at the anchor | 1.00% |
| ±0.5% | 1.64% |
| ±1% | 2.70% |
| ±2% | 7.24% |
| ±2.4% or more | 10.00% (cap) |

- **Calm market:** the fee sits at 1%.
- **Volatile market:** it climbs exponentially while the price moves away from the anchor.
- **Decay:** it falls back to 1% as the anchor catches up (≈63% of the gap per 2 hours).
- **No oracle:** volatility is read from the vault's own two pools.
- **Priced at the end state:** the fee is set by the price the trade leaves
  behind. Splitting a trade never gets below the fee schedule along the price
  path, so there is no size threshold to slip under.
- **Fee to the depleted side:** the fee is withheld from the output, so it stays
  in the reserve being drained (in a crash, the USDC pool keeps its USDC).
- k never decreases in either pool. Rounding always favours the vault,
  including the fee rate (the price ratio rounds up).

All parameters are constants in `src/lib.rs` (`FEE_FLOOR`, `FEE_CAP`,
`STEEPNESS`, `ANCHOR_TAU_SECS`, `ANCHOR_DECAY_PER_SEC`). Changing one takes a
timelocked upgrade.

### Why these numbers

Backtested on the real thing: the arbitrage that ran on HITZ's two Aquarius
pools calibrates a rational arbitrageur, which then trades each fee design on
the real minute-by-minute XLM price from May 22 to Oct 31, 2026, starting
from the pools' real reserves ([`research/vault-backtest`](../../research/vault-backtest)).

| May 22 to Oct 31 | Backing gained over holding | Taken by arbs | Avg price lag |
|---|---|---|---|
| Aquarius as it was (0.1%, pool kept half) | +$8.02 | $62.44 | 0.39% |
| Flat 1% | +$44.79 | $19.44 | 1.21% |
| **This curve** | **+$54.10** | **$13.37** | 2.37% |
| This curve, 6 h memory | +$65.19 | $11.00 | 3.17% |

Starting backing: $2,787.

- About 6.7× what the Aquarius pools kept, with 79% less taken by arbitrage.
- A 0.5% floor earns 19% less: arbitrage trades on calm days too and pays
  the same fee a swapper pays at that moment.
- Against flat 1%, the curve won $14 in the fast late-May pump and was within
  ±$2.3 in every other month, slightly behind in both crash months.
- A 3 h memory adds ~10% and 6 h ~20% to the gain, with the vault's price
  further off the market.
- At launch depth the curve also taxes ordinary purchases: a $20 HITZ buy
  pays a ~9% fee with ~$2,800 of backing (AUDIT.md, V-1).

Taking the fee on the output rather than the input changes the backing by
less than 0.1%.

## Liquidity

- `seed(hitz_xlm, xlm, hitz_usdc, usdc)`: admin, once. Sets the starting prices and the anchor.
- `deposit(from, pool, hitz, min_quote, max_quote)`: anyone, at the pool's current ratio.
  `hitz` is exact; the matching XLM/USDC (rounded up) must fall in
  `[min_quote, max_quote]`, so a deposit can't be sandwiched at a moved price.
- No LP shares and no withdrawals. Nothing leaves the vault except swap outputs.

## Trading

- `swap(from, to, token_in, token_out, amount_in, min_out) -> amount_out`: exact input.
  Pairs: HITZ↔XLM, HITZ↔USDC, and XLM↔USDC through HITZ (two hops, two fees;
  the HITZ never leaves the vault). Expiry comes from the transaction's time bounds.
- `quote(token_in, token_out, amount_in) -> amount_out`: what `swap` would pay now.
- `market() -> Market`: reserves, XLM price, anchor (at the current time), and the fee a small trade pays now.
- `reserves()`, `tokens()`.

Events: `swap` (one per swap), `hop` (one per pool passed, with fee rate, fee
amount and reserves after), `deposit`, `seeded`.

## Admin

The admin is a Stellar multisig account with exactly one power: upgrading the code.

- `propose_upgrade(wasm_hash)` → wait 7 days → `upgrade(wasm_hash)`. `cancel_upgrade()` withdraws it.
- `renounce()` ends the admin role for good. The vault becomes immutable.

A fee change or any way to move reserves can only arrive as new code, through
the same 7-day public window. Events: `upgrade_proposed`, `upgrade_cancelled`,
`upgraded`, `renounced`.

## HITZ token integration

Register the vault with `register_pool_address` **before** seeding. Then:

- the vault's HITZ is the token's Total Mass (S), so L = √S tracks the vault;
- vaulted holders (balance > L) can always sell into the vault;
- the vault can always pay HITZ out (pools are exempt from vaulting).

When the vault is upgraded, the token emits `integrity_drift_event` once and
keeps working; the token admin re-binds with `register_pool_address`.

## Invariants (tested)

- k never decreases in either pool, under random multi-pair trading.
- Reserves equal the vault's token balances; Total Mass equals the vault's HITZ.
- The fee is always within [1%, 10%] and is the floor at the anchor.
- The fee withheld stays in the output reserve.
- Round trips lose money. XLM↔USDC swaps don't move HITZ out of the vault.
- `quote` equals `swap` in the same ledger.
- The anchor is a true exponential average: updating more often doesn't move it faster.
- Upgrades wait 7 days and must match the proposal; renounce ends them; trading carries on.
- Swaps need exactly the trader's signature; deposits the depositor's; seeding,
  upgrades and renounce the admin's.
- The fee math reproduces fixed golden vectors, shared with the backtest's port.

`cargo test -p sovereign-vault`

The migration from the live mainnet token is rehearsed by
`tests/mainnet_migration.rs` (needs the token's release Wasm; see
[`MIGRATION.md`](MIGRATION.md)):

```bash
cargo build --target wasm32v1-none --release -p gravity-token
cargo test -p sovereign-vault --features migration-rehearsal --test mainnet_migration
```

Integrating a bot, wallet or app: [`INTEGRATION.md`](INTEGRATION.md).
Security review and production checklist: [`AUDIT.md`](../../AUDIT.md).
