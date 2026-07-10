#!/usr/bin/env bash
# Solana devnet dev environment for the CCTP demo.
# Idempotent-ish: safe to re-run. Comments explain each step vs the Stellar
# equivalent you already know.
set -euo pipefail

# ── 1. Rust ──────────────────────────────────────────────────────────────────
# You already have this from Soroban. Only installs if missing.
command -v rustc >/dev/null 2>&1 || \
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# ── 2. Solana CLI (Anza/Agave — the maintained fork of the old Solana Labs CLI)
# Gives you: solana, solana-keygen, solana-test-validator (local chain).
# Analogous to the `stellar` CLI.
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# The installer prints a PATH line. Add it to your shell rc; for this session:
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version

# ── 3. Point the CLI at devnet (your "Stellar testnet") ──────────────────────
solana config set --url devnet
solana config get

# ── 4. Keypair = CLI identity (pays fees, signs). Separate from Phantom. ─────
# Stellar analog: the secret key stored in your CLI network config.
if [ ! -f "$HOME/.config/solana/id.json" ]; then
  solana-keygen new --no-bip39-passphrase
fi
echo "CLI address: $(solana address)"

# ── 5. Fund with devnet SOL (gas). ~1–2 SOL is plenty. ───────────────────────
# Rate-limited; re-run if it fails, or use https://faucet.solana.com
solana airdrop 2 || true
echo "SOL balance: $(solana balance)"

# ── 6. Devnet USDC ───────────────────────────────────────────────────────────
# No CLI airdrop for USDC. Get it from Circle's faucet (select "Solana Devnet"):
#   https://faucet.circle.com
# Paste your CLI address above, or your Phantom address (set Phantom to Devnet).
# USDC lives in an Associated Token Account (ATA), not on the wallet address
# directly — the faucet/first transfer creates it for you.
echo
echo "Next: grab devnet USDC from https://faucet.circle.com (network: Solana Devnet)"
echo "Then verify token accounts with:  spl-token accounts   (needs: solana-install spl-token, optional)"
