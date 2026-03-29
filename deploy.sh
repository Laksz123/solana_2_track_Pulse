#!/bin/bash
# Deploy AI Asset Manager to Solana Devnet
# Run: bash deploy.sh

set -e

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:$PATH"

echo "=== AI Asset Manager Deployment ==="
echo ""

# Check balance
BAL=$(solana balance --url devnet 2>&1)
echo "Current balance: $BAL"

if [[ "$BAL" == "0 SOL" ]]; then
  echo ""
  echo "ERROR: You need SOL to deploy!"
  echo "1. Go to https://faucet.solana.com"
  echo "2. Select Devnet"
  echo "3. Paste address: $(solana address)"
  echo "4. Request airdrop"
  echo ""
  echo "Then run this script again."
  exit 1
fi

echo ""
echo "Building contract..."
cargo build-sbf --manifest-path programs/ai_asset_manager/Cargo.toml 2>&1 | tail -3

echo ""
echo "Deploying to devnet..."
solana program deploy target/deploy/ai_asset_manager.so \
  --url devnet \
  --keypair ~/.config/solana/id.json \
  --program-id target/deploy/ai_asset_manager-keypair.json

echo ""
echo "=== DEPLOYMENT COMPLETE ==="
echo "Program ID: DuRZJW1RmWrhZg41opM5kV3vnUzjCREgq1ySsTTAWWp3"
echo "Explorer: https://explorer.solana.com/address/DuRZJW1RmWrhZg41opM5kV3vnUzjCREgq1ySsTTAWWp3?cluster=devnet"
