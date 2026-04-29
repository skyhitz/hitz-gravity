#!/bin/bash
# ============================================================
#  HITZ Gravity Token — Stellar/Soroban Deployment Script
# ============================================================
#
# Prerequisites:
#   - stellar CLI installed (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
#   - Rust 1.91+ with the wasm32v1-none target installed
#       (rustup target add wasm32v1-none)
#   - A funded Stellar account (testnet or mainnet)
#
# Usage:
#   NETWORK=testnet ADMIN_SECRET=S... ./deploy.sh
#   NETWORK=mainnet ADMIN_SECRET=S... ./deploy.sh
#
# Environment Variables:
#   NETWORK        — "testnet" or "mainnet" (default: testnet)
#   ADMIN_SECRET   — Stellar secret key for the admin account
#   RPC_URL        — Custom RPC URL (optional, auto-set per network)
#   NETWORK_PASSPHRASE — Custom passphrase (optional)
# ============================================================

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
ADMIN_SECRET="${ADMIN_SECRET:?Error: ADMIN_SECRET environment variable is required}"

# Network configuration
if [ "$NETWORK" = "mainnet" ]; then
  RPC_URL="${RPC_URL:-https://soroban-rpc.mainnet.stellar.gateway.fm}"
  NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
elif [ "$NETWORK" = "testnet" ]; then
  RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
  NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
else
  echo "Error: NETWORK must be 'testnet' or 'mainnet'"
  exit 1
fi

echo "=== HITZ Gravity Token Deployment ==="
echo "Network:    $NETWORK"
echo "RPC:        $RPC_URL"
echo ""

# Step 1: Build the optimized WASM
echo "[1/4] Building contract..."
cargo build --release --target wasm32v1-none
WASM_PATH="target/wasm32v1-none/release/gravity_token.wasm"

if [ ! -f "$WASM_PATH" ]; then
  echo "Error: WASM file not found at $WASM_PATH"
  exit 1
fi

echo "       WASM size: $(wc -c < "$WASM_PATH") bytes"

# Step 2: Deploy the contract
echo "[2/4] Deploying contract to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  2>&1)

echo "       Contract ID: $CONTRACT_ID"

# Step 3: Get admin public key
ADMIN_PUBLIC=$(stellar keys address "$ADMIN_SECRET" 2>/dev/null || echo "")
if [ -z "$ADMIN_PUBLIC" ]; then
  echo "       (Could not derive public key from secret — using source identity for init)"
  ADMIN_PUBLIC="$ADMIN_SECRET"
fi

# Step 4: Initialize the token
echo "[3/4] Initializing Gravity HITZ token..."
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  initialize \
  --admin "$ADMIN_PUBLIC" \
  --name "Gravity HITZ" \
  --symbol "HITZ"

echo "[4/4] Verifying deployment..."
TOKEN_NAME=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  name 2>&1)

TOKEN_SYMBOL=$(stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  -- \
  symbol 2>&1)

echo ""
echo "=== Deployment Complete ==="
echo "Contract ID:  $CONTRACT_ID"
echo "Token Name:   $TOKEN_NAME"
echo "Token Symbol: $TOKEN_SYMBOL"
echo "Network:      $NETWORK"
echo ""
echo "Next steps:"
echo "  1. Bootstrap admin as pool: stellar contract invoke --id $CONTRACT_ID -- register_pool_address --address <ADMIN_ADDRESS>"
echo "  2. Register AMM pools:      stellar contract invoke --id $CONTRACT_ID -- register_pool_address --address <POOL_ADDRESS>"
echo "  3. Register routers:        stellar contract invoke --id $CONTRACT_ID -- register_router_address --address <ROUTER_ADDRESS>"
echo "  4. Mint full supply:        stellar contract invoke --id $CONTRACT_ID -- mint --to <ADDRESS> --amount 1000000000000000  # 100M HITZ"
echo "  5. Check safety limit:      stellar contract invoke --id $CONTRACT_ID -- safety_limit"
echo "  6. List registered:         stellar contract invoke --id $CONTRACT_ID -- list_pools"
echo "  7. Check vault status:      stellar contract invoke --id $CONTRACT_ID -- is_actually_vaulted --id <ADDRESS>"
