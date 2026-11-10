# HITZ Gravity Token

A Soroban SEP-41 token implementing the **Invariant Gravity Model**: a
decentralization primitive that bounds individual concentration as a
square-root function of pooled liquidity. HITZ trades on its own exchange,
the **Sovereign Vault**. Powers the Skyhitz music platform.

- **Whitepaper:** [`WHITEPAPER.md`](./WHITEPAPER.md) · live at
  [skyhitz.io/whitepaper](https://skyhitz.io/whitepaper)
- **Legal:** [`LEGAL.md`](./LEGAL.md)
- **App:** [skyhitz.io](https://skyhitz.io)
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

## Mainnet

| HITZ token | |
|---|---|
| **Contract ID** | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| **WASM Hash** | `af53185dfc0e73a4502425d30cea74487ee4bf4d23fcabd32c5f1013626c5d2d` |
| **Validated Source** | [`v2.0.0`](https://github.com/skyhitz/hitz-gravity/releases), installed Nov 4, 2026. Stellar Expert verifies the on-chain bytecode matches commit `2807ed1`. |
| **Max Supply** | 100,000,000 HITZ (compile-time constant, 7 decimals) |
| **SEP-1 Metadata** | [`frontend/public/.well-known/stellar.toml`](./frontend/public/.well-known/stellar.toml) |

| Sovereign Vault | |
|---|---|
| **Contract ID** | `CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU` |
| **WASM Hash** | `7dea47b29b9ab94c1ea78fa647afc7b7aa065d952cbbf38e3f326dec29547763` |
| **Validated Source** | [`sovereign-vault-v1.0.0`](https://github.com/skyhitz/hitz-gravity/releases), verified against commit `2807ed1` |
| **Assets** | XLM, USDC (more through a 7-day listing timelock) |
| **Registered as** | a HITZ pool, so the HITZ it holds is Total Mass |

The migration from the Aquarius pools (Nov 3-4, 2026) is recorded in
[`MIGRATION.md`](./contracts/sovereign-vault/MIGRATION.md).

For testnet history, see [`TESTNET.md`](./TESTNET.md).

## What's in the repo

```
contracts/gravity-token/      Soroban SEP-41 contract (Rust, soroban-sdk 25)
contracts/sovereign-vault/    HITZ's own exchange: a pool per trusted asset (XLM, USDC, more later), dislocation fee
research/vault-backtest/      The vault fee replayed on the real arbitrage history
frontend/                     Next.js app (vault swap, Monitor) + Cloudflare Worker: gateway, public API, MCP server, data cron
docs/                         docs.skyhitz.io: a Docusaurus site built from this repo's markdown
.github/workflows/contracts.yml  Tests, Wasm build + size check, mainnet migration rehearsal, swap budget
.github/workflows/release.yml Reproducible token build → GitHub Release → Stellar Expert validation
.github/workflows/release-sovereign-vault.yml  The same for the vault
deploy.sh                     Initial mainnet deploy script (kept for history)
AUDIT.md                      Security review of the vault and token v2, production checklist
WHITEPAPER.md                 Canonical text of the Gravity model whitepaper
LEGAL.md                      Protocol legal disclosure
TESTNET.md                    V5 testnet deployment record
```

Two crates, `gravity-token` and `sovereign-vault`, each producing one Wasm.
The frontend is deployed as one Cloudflare Worker that serves the static
Next.js export, the `/api/*` gateway and the data cron.

## The model in one paragraph

Each registered pool's HITZ balance contributes to **Total Mass S**: today
the Sovereign Vault and the treasury account. The **Event Horizon
L = ⌊√(S × 10⁷)⌋** is the maximum a single account may hold and still
transact. Any account whose balance exceeds **L** is **vaulted**: it can
only send HITZ to a registered pool until it is back under L (selling
into the vault does it) or the ecosystem grows enough that L overtakes
the balance. Concentration can never keep pace with liquidity: a 10,000×
growth in pool reserves yields only a 100× growth in individual holding
limits.

Vault state is evaluated lazily: every balance-changing call re-syncs the
flag against current L for both sides, so trapped users are released the
moment liquidity catches up, with no extra transaction.

The Sovereign Vault keeps one constant-product pool per trusted asset
against HITZ. Its fee is 1% when calm and rises as 1% × e^(100·D), capped
at 10%, while a trade leaves one asset dislocated against another. No LP
shares, no withdrawals; upgrades and listings wait out a public 7-day
timelock. See [`WHITEPAPER.md`](./WHITEPAPER.md) for the full derivation.

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

## Frontend

The Skyhitz UI and email-based gas-sponsoring gateway live in
[`frontend/`](./frontend/): the vault swap (quoted with an exact port of the
vault's fee math, checked by `scripts/check-vault-math.mjs`), the sell-to-
release card for vaulted accounts, and the Monitor fed by the Worker's data
cron. See [`frontend/README.md`](./frontend/README.md) for local dev,
deployment, and the legacy reparation campaign script.

## License

See [`LEGAL.md`](./LEGAL.md) for protocol disclosures and acknowledged
behaviors. The Gravity model (vaulting, ghost-vaulting, sacrifice,
event-horizon physics) and the vault's rising fee are intentional, not
bugs.
