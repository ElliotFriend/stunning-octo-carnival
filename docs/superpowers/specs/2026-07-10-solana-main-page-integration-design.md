# Solana main-page integration — design

**Date:** 2026-07-10
**Status:** approved, pre-implementation

## Goal

Make Solana a first-class chain in the main CCTP demo page, functioning nearly
identically to the existing Stellar ↔ EVM transfers. Solana appears in the
top-right chain selector alongside the EVM chains (Arc · Base · Ethereum ·
**Solana**, in that order). Selecting it swaps the right panel to Phantom
(Wallet Standard) + the already-built `solana-to-stellar` / `stellar-to-solana`
store flows. When complete, the throwaway `/solana-spike` route is deleted.

Punt (later): exercising the Soroban wrapper contract with Solana.

## Context

The transfer store already fully supports Solana: `Direction` includes
`solana-to-stellar` and `stellar-to-solana`, `runSolanaToStellar` /
`runStellarToSolana` are implemented and proven end-to-end, `stepsFor` has both
branches, and fees use `SOLANA_MAX_FEE` / `parseUsdcSolana`. **The entire gap is
main-page UI/state plumbing.** The only store change needed is making
`start()`'s `evmWallet` optional (today it's required; the spike passed
`undefined as never`).

Today the top-right is `EvmPanel`, which **owns** the chain-chip selector and
assumes EVM everywhere (`ensureChain`, `getEvmUsdcBalance`, `EVM_CHAINS[chainId]`,
`sendCallsCap`, per-chain badge CSS). The chip row cannot host a non-EVM chain
without swapping the whole panel body.

## Decision: DestinationPanel wrapper

Introduce `DestinationPanel.svelte` that owns the 4-chip selector and swaps
between an EVM body and a Solana body. `EvmPanel` becomes a controlled child
(receives `chainId`, no internal selector); `SolanaPanel` is stripped back to
connect + balance. Rejected alternatives: lifting the selector inline into
`+page.svelte` (less encapsulated), and adding a Solana chip inside `EvmPanel`
(pollutes it with non-EVM logic — the tension to avoid).

## Types

- New `RightChain = EvmChainId | 'solana'` (in `config.ts`).
- `direction` on the page is derived from `(rightChain, orientation)`:
    - EVM + Stellar-source → `stellar-to-evm`; EVM-source → `evm-to-stellar`.
    - Solana + Stellar-source → `stellar-to-solana`; Solana-source → `solana-to-stellar`.

## Components

### `DestinationPanel.svelte` (new)

- Owns the chip row: `Object.values(EVM_CHAINS)` chips + a trailing `Solana`
  chip. `bind:chain: RightChain`.
- Renders `<EvmPanel chainId={chain} .../>` when `chain !== 'solana'`, else
  `<SolanaPanel .../>`.
- Binds through: `evmWallet`, `solanaWallet` (only the active one connects),
  `inboundFlow`, `sendCallsCap` (EVM-only). Exposes `refresh()` that delegates to
  whichever body is active.
- Badge/label styling: add a `.badge.solana` rule + "Solana" label.

### `EvmPanel.svelte` (controlled)

- Remove the internal chip selector + `pickChain` / `switchChain`. Receive
  `chainId` as a controlled prop.
- Keep: badge, EIP-6963 connect, `ensureChain` on connect, USDC balance,
  `refresh()`, `inboundFlow` / `sendCallsCap` outputs.

### `SolanaPanel.svelte` (stripped)

- Revert to connect + balance only: `bind:wallet`, `disabled?`, `export function
refresh()`. Remove the throwaway `amount` / `recipient` / `onBurn` / `steps`
  props and the burn form/step list.

### `SolanaBurnPreview.svelte` (new)

- Mirror `EvmBurnPreview` for the Solana side: show amount, `mintRecipient` =
  the connected wallet's USDC ATA (via `solanaAtaToBytes32`), `destinationDomain`
  = 5, `destinationCaller` = zero, `maxFee`, and a note that delivery is a
  transfer from Circle's custody account. Shown when a Solana direction is
  active, mirroring where `EvmBurnPreview` / `StellarBurnPreview` render.

### `DirectionSwitcher.svelte` (generalized)

- Show `Stellar ⇄ <rightLabel>` where `rightLabel` is the EVM chain's short label
  or `Solana`. Flip toggles orientation; the page maps `(rightChain, orientation)`
  → `Direction`. No longer hardcodes the EVM pair.

## `+page.svelte` changes

- State: replace bare `evm` / `evmChainId` with `rightChain: RightChain`,
  `evm: EvmWallet | null`, `solana: SolanaWallet | null`, and an orientation
  flag; derive `direction`.
- Render `<DestinationPanel>` in the top-right instead of `<EvmPanel>`.
- `send()` / `resume()` branch on `rightChain`:
    - Solana: require `solana`; call `start({ direction, stellarAddress,
solanaWallet: solana, evmChainId: DEFAULT_EVM_CHAIN, amount, speed: 'standard' })`
      (no `evmWallet`).
    - EVM: unchanged.
- `bothConnected` and other gates branch on `rightChain` (Stellar + the active
  right wallet).
- After `done`, refresh Stellar + the active destination body.
- `effectiveSpeed` coerces Solana directions to `standard` (mirrors the existing
  `stellar-to-evm` coercion).

## Store change

- `createTransferStore().start()`: make `evmWallet?: EvmWallet` optional. The EVM
  dispatch branches already throw a clear error if it's missing; the Solana
  branch ignores it. `TransferState.evmChainId` stays required — Solana transfers
  pass `DEFAULT_EVM_CHAIN` as an inert placeholder (as the spike did), and
  `TransferProgress`'s `EVM_CHAINS[evmChainId]` read stays valid.

## Flow toggles / speed

Unchanged gating carries over: StellarPanel's `outboundFlow` / `forwarding`
toggles already render only for `stellar-to-evm`, so they hide for
`stellar-to-solana`; EVM `inboundFlow` is EVM-only. Solana directions use plain
two-tx with `standard` finality — no new toggles. Fast transfer on Solana stays
out of scope.

## Cleanup

Delete `src/routes/solana-spike/` (route + harness). No other route references it.

## Error handling

- Right wallet not connected for the chosen chain → the existing gate disables
  the send button; `start()`'s guards throw clear messages as a backstop.
- All transfer-time failures continue through the store's `fail()` funnel and
  render in `TransferProgress` (Solana steps already supported).

## Verification

On the main page (`pnpm dev`, `/`):

1. Top-right selector shows Arc · Base · Ethereum · Solana. Selecting Solana
   swaps the body to Phantom connect + USDC balance.
2. Run **Stellar → Solana** to completion (approve → burn → attest → mint);
   confirm Phantom USDC increases.
3. Run **Solana → Stellar** to completion; confirm Stellar USDC increases.
4. Confirm an existing **EVM ↔ Stellar** transfer (e.g. Base) still works
   unchanged.
5. `SolanaBurnPreview` renders correct args for a Solana direction.
6. `/solana-spike` returns 404 (route deleted).

## Out of scope

- Wrapper contract with Solana (later goal).
- Fast transfer on Solana directions.
- EVM ↔ Solana pairing (scope stays Solana ↔ Stellar).
