# HITZ Gravity Token

A Soroban SEP-41 token implementing the **Invariant Gravity Model** — a
decentralization primitive that bounds individual concentration as a
square-root function of pooled liquidity. Powers the Skyhitz music
platform.

- **Whitepaper:** [`WHITEPAPER.md`](./WHITEPAPER.md) · live at
  [skyhitz.io/whitepaper](https://skyhitz.io/whitepaper)
- **Legal:** [`LEGAL.md`](./LEGAL.md)
- **App:** [skyhitz.io](https://skyhitz.io)
- **Contract on Stellar Expert:**
  [CBAPZAZN…OY4EU](https://stellar.expert/explorer/public/contract/CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU)

## Mainnet

| | |
|---|---|
| **Contract ID** | `CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU` |
| **WASM Hash** | `befa64d9d56feba32e18e09f1c364b8a4d863016337bb933ba12cc5c0a8e5b08` |
| **Validated Source** | [`v1.0.0`](https://github.com/skyhitz/hitz-gravity/releases) — Stellar Expert verifies the on-chain bytecode matches this commit. |
| **Max Supply** | 100,000,000 HITZ (compile-time constant, 7 decimals) |
| **SEP-1 Metadata** | [`frontend/public/.well-known/stellar.toml`](./frontend/public/.well-known/stellar.toml) |

For testnet history, see [`TESTNET.md`](./TESTNET.md).

## What's in the repo

```
contracts/gravity-token/      Soroban SEP-41 contract (Rust, soroban-sdk 25)
frontend/                     Next.js app + Cloudflare Worker gateway
.github/workflows/release.yml Reproducible build → GitHub Release → Stellar Expert validation
deploy.sh                     Initial mainnet deploy script (kept for history)
WHITEPAPER.md                 Canonical text of the Gravity model whitepaper
LEGAL.md                      Protocol legal disclosure
TESTNET.md                    V5 testnet deployment record
```

The contract is a single crate (`gravity-token`) producing
`gravity_token.wasm`. The frontend is deployed as one Cloudflare Worker
that serves the static Next.js export and the `/api/*` gateway.

## The model in one paragraph

Each registered liquidity pool's HITZ balance contributes to **Total
Mass S**. The **Event Horizon L = ⌊√(S × 10⁷)⌋** is the maximum a
single account may hold and still transact. Any account whose balance
exceeds **L** is **vaulted** — outbound transfers are blocked until
either the account reduces below L (sacrifice to a pool) or the
ecosystem grows enough that L overtakes the balance. Concentration can
never keep pace with liquidity: a 10,000× growth in pool reserves
yields only a 100× growth in individual holding limits.

Vault state is evaluated lazily — every balance-changing call re-syncs
the flag against current L for both sides, so trapped users are
released the moment liquidity catches up, with no extra transaction.
See [`WHITEPAPER.md`](./WHITEPAPER.md) for the full derivation.

## Build and test

```bash
# Build optimized WASM (output: target/wasm32v1-none/release/gravity_token.wasm)
cd contracts/gravity-token
make build

# Run the test suite (≈100 snapshot tests covering vaulting, pools, routers,
# mint cap, lazy evaluation, upgrade path, edge cases)
make test
```

Requires Rust 1.91+ with the `wasm32v1-none` target (`rustup target add
wasm32v1-none`) and `stellar-cli` 25.1.0+.

## Deploy

For new contracts, see [`deploy.sh`](./deploy.sh). For upgrading an
already-deployed contract, **always pull the WASM from a tagged GitHub
Release** so the on-chain bytecode is reproducible from public source:

```bash
# 1. Cut a release — the GitHub Action builds the WASM, hashes it,
#    signs a Sigstore attestation, and notifies Stellar Expert.
git tag v1.x.y
git push origin v1.x.y

# 2. Download the released WASM
gh release download v1.x.y_contracts_gravity_token_gravity-token_pkg0.0.0_cli25.1.0 \
  --pattern '*.wasm' --dir build/

# 3. Upload + upgrade (admin-gated)
stellar contract upload --wasm build/gravity-token_v0.0.0.wasm \
  --source <admin> --network mainnet
# → returns NEW_HASH

stellar contract invoke --id <CONTRACT_ID> --source <admin> --network mainnet \
  -- upgrade --new_wasm_hash <NEW_HASH>
```

After upgrade, Stellar Expert's `Source code` field on the contract
page automatically links back to the validated commit. See the
[stellar-expert/soroban-build-workflow docs][validation-docs] for how
the validation handshake works.

[validation-docs]: https://github.com/stellar-expert/soroban-build-workflow

## Frontend

The Skyhitz UI and email-based gas-sponsoring gateway live in
[`frontend/`](./frontend/). See [`frontend/README.md`](./frontend/README.md)
for local dev, deployment, and the legacy reparation campaign script.

## License

See [`LEGAL.md`](./LEGAL.md) for protocol disclosures and acknowledged
behaviors. The Gravity model — vaulting, ghost-vaulting, sacrifice,
event-horizon physics — is intentional, not bugs.
