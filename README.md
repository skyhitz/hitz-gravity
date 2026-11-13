# HITZ Protocol

**Oracle-free, protocol-owned liquidity on Stellar.**

HITZ Protocol is an oracle-free financial primitive on Stellar (Soroban). Its
goal is to solve liquidity provisioning without depending on outside capital
(mercenary LPs) or outside price feeds (oracles). Two contracts form a closed
loop:

- **The Sovereign Vault**, HITZ's own exchange, owns its liquidity: no LP
  shares, no withdrawals. Its prices follow the market through arbitrage
  instead of an oracle, and its fee keeps part of every arbitrage profit in
  its pools, so the liquidity compounds.
- **The HITZ token** bounds concentration per account. An account holding
  more than the Event Horizon L = √S, where S is the HITZ in the protocol's
  pools, can send HITZ only back into a pool. L grows as the vault deepens.

Built by Skyhitz.

- **Whitepaper:** [`WHITEPAPER.md`](./WHITEPAPER.md) · live at
  [skyhitz.io/whitepaper](https://skyhitz.io/whitepaper)
- **Legal:** [`LEGAL.md`](./LEGAL.md)
- **App:** [skyhitz.io](https://skyhitz.io): swap in the vault with a Stellar
  wallet or an email account
- **Terminal:** [skyhitz.io/terminal](https://skyhitz.io/terminal/): XLM
  market, leverage and on-chain flow data; paid plans settle in HITZ through
  the vault
- **Docs:** [docs.skyhitz.io](https://docs.skyhitz.io), built from this
  repo's markdown by [`docs/`](./docs/)
- **Integrate:** [skyhitz.io/integrate](https://skyhitz.io/integrate/): a
  keyless HTTP API (`https://skyhitz.io/api/v1`) and an MCP server for AI
  agents (`https://skyhitz.io/mcp`) that build swaps ready to sign
- **Token on Stellar Expert:**
  [CBAPZAZN…OY4EU](https://stellar.expert/explorer/public/contract/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU)
- **Sovereign Vault on Stellar Expert:**
  [CDEISYZM…NNBWU](https://stellar.expert/explorer/public/contract/CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU)
  · integrating: [`INTEGRATION.md`](./contracts/sovereign-vault/INTEGRATION.md)

## How the loop works

1. **The protocol owns the liquidity.** The vault keeps one constant-product
   pool per trusted asset (XLM and USDC today) against HITZ. The protocol
   seeded them; anyone can add to them at the pool's ratio, and nothing
   leaves them except swap outputs. There are no LP shares to redeem.
2. **Arbitrage replaces the oracle.** When XLM moves against USDC elsewhere,
   the vault's rate between them falls behind until someone trades it back.
   Anyone can; Skyhitz runs an [open-source bot](./frontend/ARB_BOT.md) that
   does it every five minutes from a public account.
3. **The fee keeps the arbitrage profit.** Every hop pays 1%, rising
   exponentially to 10% while a trade leaves one asset dislocated against
   another, and the fee stays in the pool it was taken from. Closing a gap
   therefore pays the vault for most of what the gap was worth: in a
   [replay on five months of real Stellar DEX prices](./research/arb-bot-replay/README.md),
   the vault's fees were 67% to 89% of what the arbitrage made, depending on
   how large a profit the arbitrageur waited for.
4. **Large balances flow back to the vault.** The HITZ in the protocol's
   pools is Total Mass S, and L = ⌊√(S × 10⁷)⌋ is the most HITZ one account
   can hold and still send anywhere. Above L an account is *vaulted*: it can
   send HITZ only to a registered pool, such as by selling it into the vault,
   which adds to S. Vault state is evaluated lazily, so an account is
   released the moment its balance is back under L.

The [whitepaper](./WHITEPAPER.md) has the derivation, the fee math and the
evidence.

## Status

As of Nov 13, 2026:

- Token v2.0.0 and Sovereign Vault v1.0.0 on mainnet, both verified on
  Stellar Expert against their source.
- About $5,800 of protocol-owned liquidity in the vault (live:
  [`/api/v1/vault`](https://skyhitz.io/api/v1/vault)). The vault and the
  treasury hold 98.4% of the supply.
- The arbitrage bot trades live from a public account
  ([`/api/v1/bot`](https://skyhitz.io/api/v1/bot)).
- HITZ Terminal subscriptions are paid in USDC or XLM and settle in HITZ:
  each payment is one vault swap that buys HITZ for the treasury, so the
  vault earns its fee on it.
- Reviewed internally ([`AUDIT.md`](./AUDIT.md)); no independent audit yet.

### Decentralization

Decentralized by design, not yet in full. Prices need no oracle, the
liquidity needs no outside LPs, and anyone can trade, deposit or arbitrage.
The exception is the admin role: one account (`GCAETBNB…OKGU`) is the admin
of both contracts and is the treasury.

| Admin power | Takes effect |
|---|---|
| Upgrade the token's or the vault's code | after a public 7-day notice |
| List a new asset in the vault | after a public 7-day notice |
| Seed a newly listed asset's pool | immediately |
| Register or remove the token's pools and routers | immediately |
| Hand the token's admin role to another account (both sign) | immediately |
| Mint, up to the 100,000,000 cap (fully minted, so only after burns) | immediately |

The vault's admin can give up upgrades (`renounce_upgrades`) or every power
(`renounce`) for good. The token's `renounce_admin` ends minting, upgrades
and registry changes for good, and refuses while a classic account is
registered, as the treasury and the email gateway's gas sponsor are today.

### What the Event Horizon does not do

It limits accounts, not people. Stellar has no identity layer, so one owner
can hold HITZ in many accounts, each under L. Registered pools and routers
are never vaulted: today the vault, the treasury (about 9.96M HITZ, 10% of
supply) and the gas sponsor (about 33,000 HITZ, for the legacy reparation).

L is also small today: about 9,900 HITZ, worth about $0.32, so almost any
purchase vaults the buyer, whose HITZ can then only be sold back into the
vault until L grows past it. The swap screen says so before you sign. The
whitepaper's [Known Limits](./WHITEPAPER.md#xii-known-limits) has the rest.

## Mainnet

| HITZ token | |
|---|---|
| **Contract ID** | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| **Name / symbol** | `Gravity HITZ` / `HITZ` (on-chain metadata, fixed at deployment) |
| **WASM Hash** | `af53185dfc0e73a4502425d30cea74487ee4bf4d23fcabd32c5f1013626c5d2d` |
| **Validated Source** | [`v2.0.0`](https://github.com/skyhitz/hitz-gravity/releases), installed Nov 4, 2026. Stellar Expert verifies the on-chain bytecode matches commit `2807ed1`. |
| **Max Supply** | 100,000,000 HITZ (compile-time constant, 7 decimals), fully minted |
| **SEP-1 Metadata** | [`frontend/public/.well-known/stellar.toml`](./frontend/public/.well-known/stellar.toml) |

| Sovereign Vault | |
|---|---|
| **Contract ID** | `CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU` |
| **WASM Hash** | `7dea47b29b9ab94c1ea78fa647afc7b7aa065d952cbbf38e3f326dec29547763` |
| **Validated Source** | [`sovereign-vault-v1.0.0`](https://github.com/skyhitz/hitz-gravity/releases), verified against commit `2807ed1` |
| **Assets** | XLM, USDC (more through a 7-day listing timelock) |
| **Registered as** | a HITZ pool, so the HITZ it holds is Total Mass |

The move from the Aquarius pools (Nov 3 to 9, 2026) is recorded in
[`MIGRATION.md`](./contracts/sovereign-vault/MIGRATION.md).

For testnet history, see [`TESTNET.md`](./TESTNET.md).

## What's in the repo

```
contracts/gravity-token/      The HITZ token: Soroban SEP-41 contract with the Event Horizon (Rust, soroban-sdk 25)
contracts/sovereign-vault/    The Sovereign Vault: a pool per trusted asset (XLM, USDC, more later), dislocation fee
research/vault-backtest/      The vault fee replayed on the real arbitrage history
research/arb-bot-replay/      The arbitrage bot replayed on five months of Stellar DEX prices
frontend/                     skyhitz.io: Next.js app (vault swap, Monitor, Terminal) + Cloudflare Worker: email gateway, public API, MCP server, Terminal API, arbitrage bot, data cron
docs/                         docs.skyhitz.io: a Docusaurus site built from this repo's markdown
reports/                      Monthly on-chain activity reports
.github/workflows/contracts.yml  Tests, Wasm build + size check, mainnet migration rehearsal, swap budget
.github/workflows/release.yml Reproducible token build → GitHub Release → Stellar Expert validation
.github/workflows/release-sovereign-vault.yml  The same for the vault
.github/workflows/deploy-frontend.yml  Deploys skyhitz.io on every push to main that touches frontend/
.github/workflows/deploy-docs.yml  Deploys docs.skyhitz.io on every push to main that changes what it's built from
.github/workflows/data-health.yml  Daily check that ingestion, prices and the bot are running
deploy.sh                     Initial mainnet deploy script (kept for history)
AUDIT.md                      Security review of the vault and token v2, production checklist
WHITEPAPER.md                 Canonical text of the whitepaper
LEGAL.md                      Protocol legal disclosure
TESTNET.md                    V5 testnet deployment record
```

Two crates, `gravity-token` and `sovereign-vault`, each producing one Wasm.
The frontend is deployed as one Cloudflare Worker that serves the static
Next.js export, the `/api/*` gateway, the crons (data and arbitrage bot) and
the Terminal's API.

## Build and test

```bash
# Build optimized WASM (output: target/wasm32v1-none/release/gravity_token.wasm)
cd contracts/gravity-token
make build

# Run the test suite (≈100 snapshot tests covering vaulting, pools, routers,
# mint cap, lazy evaluation, upgrade path, edge cases)
make test

# Everything, vault included (from the repo root)
cargo test --workspace

# The Worker's logic: gateway, bot, Terminal (Node 22.6+)
cd frontend && pnpm install && pnpm test
```

Requires Rust 1.91+ with the `wasm32v1-none` target (`rustup target add
wasm32v1-none`) and `stellar-cli` 25.1.0+.

## Deploy

For new contracts, see [`deploy.sh`](./deploy.sh). For upgrading an
already-deployed contract, **always pull the WASM from a tagged GitHub
Release** so the on-chain bytecode is reproducible from public source:

```bash
# 1. Cut a release: the GitHub Action builds the WASM, hashes it,
#    signs a Sigstore attestation, and notifies Stellar Expert.
git tag v2.x.y
git push origin v2.x.y

# 2. Download the released WASM
gh release download v2.x.y_contracts_gravity_token_gravity-token_pkg0.0.0_cli25.1.0 \
  --pattern '*.wasm' --dir build/

# 3. Upload, propose, wait 7 days, upgrade (admin-gated)
stellar contract upload --wasm build/gravity-token_v0.0.0.wasm \
  --source <admin> --network mainnet
# → returns NEW_HASH

stellar contract invoke --id <CONTRACT_ID> --source <admin> --network mainnet \
  -- propose_upgrade --new_wasm_hash <NEW_HASH>
# Public for 7 days (`pending_upgrade` shows it). Then:
stellar contract invoke --id <CONTRACT_ID> --source <admin> --network mainnet \
  -- upgrade --new_wasm_hash <NEW_HASH>
```

Every upgrade since v2.0.0 is timelocked; installing v2.0.0 itself (Nov 4,
2026) was the last one-step `upgrade`. The vault works the same way, and
also timelocks listing a new asset.
`renounce_admin` ends minting, upgrades and registry changes for good. It
refuses until the registry is final: no classic accounts registered as pools
or routers, and every registered contract on its approved bytecode.

After upgrade, Stellar Expert's `Source code` field on the contract
page automatically links back to the validated commit. See the
[stellar-expert/soroban-build-workflow docs][validation-docs] for how
the validation handshake works.

[validation-docs]: https://github.com/stellar-expert/soroban-build-workflow

The site deploys itself: every push to `main` that touches `frontend/` runs
[`deploy-frontend.yml`](./.github/workflows/deploy-frontend.yml), which tests,
builds, applies pending D1 migrations and deploys the Worker. The docs do too:
every push to `main` that changes `docs/` or a markdown file docs.skyhitz.io
publishes runs [`deploy-docs.yml`](./.github/workflows/deploy-docs.yml).

## Frontend

The skyhitz.io app, the Worker behind it and the email-based gas-sponsoring
gateway live in [`frontend/`](./frontend/): the vault swap (quoted with an
exact port of the vault's fee math, checked by `scripts/check-vault-math.mjs`),
the sell-to-release card for vaulted accounts, the Monitor fed by the Worker's
data cron, the HITZ Terminal, the public API and MCP server, and the
[arbitrage bot](./frontend/ARB_BOT.md). See
[`frontend/README.md`](./frontend/README.md) for local dev, deployment, and
the legacy reparation campaign script.

## License

See [`LEGAL.md`](./LEGAL.md) for protocol disclosures and acknowledged
behaviors. Vaulting, ghost-vaulting, sacrifice and the vault's rising fee are
intentional, not bugs.
