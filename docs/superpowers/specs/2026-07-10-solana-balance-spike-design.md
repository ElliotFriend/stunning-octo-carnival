# Solana balance spike — design

**Date:** 2026-07-10
**Status:** approved, pre-implementation

## Goal

De-risk the Solana client stack before writing any CCTP code. Prove that
`@solana/kit` + Wallet Standard (Phantom) + Associated Token Account (ATA)
resolution all work together in this SvelteKit app by connecting a wallet and
reading a devnet USDC balance.

This is the first step toward turning on Solana as a CCTP chain. Scope of the
larger effort is **Solana ↔ Stellar only** — Solana never pairs with the EVM
chains. This spike is throwaway; the real `SolanaPanel` and CCTP burn/mint
paths come later.

## Context

The demo is testnet-only across the board (`Networks.TESTNET`, sepolia chains,
`iris-api-sandbox`). Solana is added as one more testnet chain on devnet; no
network toggle is built (out of scope, YAGNI). The `SOLANA` config block is
already in `src/lib/config.ts` (domain 5, CCTP V2 program IDs, devnet USDC mint
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals).

Existing wallet integrations set the pattern the spike mirrors:

- Wallet modules export plain functions + a state type. No stores, no `$effect`
  (repo convention: explicit dataflow).
- Wallet state is component-local `$state` passed into panels via `$bindable`.
- EVM uses EIP-6963 discovery (`evm/wallet.ts`); Wallet Standard is the Solana
  analog, keeping the two consistent.

## Decision: Wallet Standard over legacy provider

Connect via `@wallet-standard/app` (`getWallets()`), not `window.phantom.solana`.
Wallet Standard is the current ecosystem default (Anza/Phantom/Solflare/Backpack),
is the direct analog of the EIP-6963 discovery already used for EVM, and adds
only a tiny registry package — not the heavy `@solana/wallet-adapter-react` UI
stack, which is not used.

## Dependencies

- `@solana/kit` — RPC client + address types
- `@solana-program/token` — ATA derivation (`findAssociatedTokenPda`)
- `@wallet-standard/app`, `@wallet-standard/base` — wallet discovery/connect

## Modules

Isolated under a throwaway route `src/routes/solana-spike/+page.svelte`
(mirrors the existing experimental `forward-test` route). Nothing in the main
page changes.

| File | Parallels | Responsibility |
|------|-----------|----------------|
| `src/lib/solana/client.ts` | `stellar/client.ts` | `export const solanaRpc = createSolanaRpc(SOLANA.rpcUrl)` |
| `src/lib/solana/wallet.ts` | `evm/wallet.ts` | `SolanaWallet` type; `discoverSolanaWallets()` (filter to `solana:`-capable wallets); `connectSolana(info)` (invoke `standard:connect`, take `accounts[0]`); `detectExistingSolana()` (silent reconnect keyed on a stored wallet name, like EVM's stored-rdns) |
| `src/lib/solana/usdc.ts` | `stellar/usdc.ts` | `getUsdcBalance(owner)` — derive ATA from (owner, mint), call `solanaRpc.getTokenAccountBalance`; format helpers |
| `src/lib/components/SolanaPanel.svelte` | `StellarPanel.svelte` | Connect button → show address + USDC balance. Throwaway. |

## Data flow

Explicit, no `$effect`:

1. `onMount` (guarded by `browser` from `$app/environment`) → `detectExistingSolana()`
   for silent reconnect.
2. Connect click → `discoverSolanaWallets()` → connect Phantom → address into
   component `$state`.
3. On address set → `getUsdcBalance(address)` via our devnet Kit RPC → display.

## Error handling

- No Solana wallet discovered → "Install Phantom from phantom.app".
- User rejects the connect request → surface the message.
- **ATA does not exist → balance `0`**, not an error. The ATA isn't created
  until the owner first receives USDC.
- RPC failure → surface the message.

Balance reads use the app's own devnet RPC, so Phantom's cluster setting cannot
cause a silent wrong-network read.

## Verification

Manual, and it is the entire point of the spike:

1. `pnpm dev`
2. Open `/solana-spike`
3. Connect Phantom (set to Devnet)
4. Displayed USDC balance matches what the Circle faucet
   (https://faucet.circle.com, Solana Devnet) sent to that address.

Green means RPC + Wallet Standard + ATA resolution all work end-to-end, and the
CCTP burn/mint work can build on a known-good foundation.

## Out of scope

- CCTP burn/mint instructions (later steps).
- Transaction signing (spike is read-only).
- Multi-wallet UI beyond picking Phantom.
- Network (testnet/mainnet) toggle.
- Real `SolanaPanel` wired into the main page.
