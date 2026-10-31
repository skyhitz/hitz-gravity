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
- k never decreases in either pool. Rounding always favours the vault.

All parameters are constants in `src/lib.rs` (`FEE_FLOOR`, `FEE_CAP`,
`STEEPNESS`, `ANCHOR_TAU_SECS`, `ANCHOR_DECAY_PER_SEC`). Changing one takes a
timelocked upgrade.

### Why these numbers

Ledger-level simulation (two pools at the Sep 22, 2026 state, XLM with jumps and
microstructure noise, greedy arbitrage settling XLM at 0.05%). Against a flat 1%
fee, the curve above earns:

| Market | Fees to the vault | Arbs keep |
|---|---|---|
| Crash month (XLM −50% drift) | +27% | −31% |
| Pump month (XLM +60% drift) | +21% | −33% |
| Volatile year (120% vol) | +6% | −44% |
| Normal year (70% vol) | +3% | −30% |
| Calm year (40% vol) | −9% | −20% |

A floor below 1% (0.1-0.3%) lost 15-40% of fees in every market: arbitrage
trades on calm days too, and on-chain it pays the same fee as a swapper at the
same moment. A longer anchor memory (3-6 h) earns another 5-10% but keeps
swappers above 1% more often. Taking the fee on the output rather than the
input changes the backing by less than 0.1%.

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

`cargo test -p sovereign-vault`
