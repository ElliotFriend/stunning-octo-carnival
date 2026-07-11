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
main-page UI/state plumbing** plus a small store change: making the EVM-side
inputs (`evmWallet`, `evmChainId`) genuinely optional so a Solana transfer
carries no phantom EVM chain (today `evmChainId` is required and the spike passed
a `DEFAULT_EVM_CHAIN` dummy + `evmWallet: undefined as never`). See "Store change".

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
  `inboundFlow`, `sendCallsCap` (EVM-only). Holds `bind:this` handles to the
  active child (`EvmPanel` / `SolanaPanel`) and exposes `refresh()` that delegates
  to whichever is mounted (guard the unmounted one). On an EVM chip click, calls
  the EvmPanel ref's `setChain(id)` (review B1).
- Badge/label styling: add a `.badge.solana` rule + "Solana" label.

### `EvmPanel.svelte` (controlled)

- Remove the internal chip selector markup. Receive `chainId` as a controlled prop.
- Keep: badge, EIP-6963 connect, `ensureChain` on connect, USDC balance,
  `refresh()`, `inboundFlow` / `sendCallsCap` outputs.
- **Critical (review B1):** `pickChain`/`switchChain` today do more than set the
  id — on a chip change they (a) `ensureChain(wallet, chainId)` to switch the
  wallet's network (`EvmPanel.svelte:127`), (b) refresh balance + `sendCallsCap`
  for the new chain (`:128-129`), and (c) drop `inboundFlow` from `'wrapper'` when
  the target chain has no `bridgeWrapper` (`:140-142`; e.g. Ethereum). Switching
  the id via a controlled prop does NOT remount EvmPanel and `$effect` is
  forbidden, so these side effects would be lost. **EvmPanel must expose an
  imperative `export async function setChain(id: EvmChainId)`** that performs all
  of (a)–(c) (plus the no-wallet balance/cap reset at `:143-149`). `DestinationPanel`
  calls `evmPanelRef.setChain(id)` from its chip handler when an EVM chip is picked.

### `SolanaPanel.svelte` (stripped)

- Revert to connect + balance only: `bind:wallet`, `disabled?`, `export function
refresh()`. Remove the throwaway `amount` / `recipient` / `onBurn` / `steps`
  props and the burn form/step list.

### Burn previews (review B2 — two directions burn on DIFFERENT chains)

The existing previews always show the **source-side** burn: `StellarBurnPreview`
for `stellar-to-evm` (`+page.svelte:174`), `EvmBurnPreview` for `evm-to-stellar`
(`+page.svelte:162`). The two Solana directions burn on different chains, so one
"SolanaBurnPreview keyed on any-Solana-direction" is wrong. Split by burning chain:

- **`stellar-to-solana` (burn on Stellar):** the burn is a Soroban
  `deposit_for_burn` (`depositForBurnToSolana`) with `destinationDomain = 5`,
  `mintRecipient = solanaAtaToBytes32(solanaWallet.address)` (the recipient's
  Solana USDC ATA), `destinationCaller = 0`. This is a **Stellar-side** burn →
  extend/parameterize **`StellarBurnPreview`** to accept a Solana destination
  (show the ATA as mintRecipient + domain 5), rather than a "Solana" preview.
- **`solana-to-stellar` (burn on Solana):** the burn is a Solana
  `depositForBurnWithHook` with `destinationDomain = 27`, `mintRecipient =
destinationCaller = the Stellar forwarder`, `hookData = the G-address`. This is
  the genuine **`SolanaBurnPreview.svelte` (new)** — show amount, forwarder
  recipient, domain 27, and the G-address hook.

Each preview renders for its own direction, keyed on `direction` exactly as the
EVM/Stellar previews are (not on "a Solana direction is active"). Getting the
mintRecipient right per direction is fund-safety-critical (`recipient.ts:29-30`).

### `DirectionSwitcher.svelte` (generalized)

- **Interface change (review M5):** today it takes `bind:direction: Direction`
  and `flip()` hardcodes `stellar-to-evm ↔ evm-to-stellar` (`DirectionSwitcher.svelte:14-15`)
  — incompatible with a Solana right side (it would flip a Solana direction to an
  EVM one). Change it to orientation-based: `bind:stellarIsSource: boolean` +
  `otherLabel: string`. It shows `Stellar ⇄ <otherLabel>` and flip only toggles
  `stellarIsSource`. The **page** owns the `(rightChain, stellarIsSource) →
Direction` derivation (mapping in "Types"; complete and unambiguous across all
  four states, orientation preserved across an EVM↔Solana chip switch).
- **Page `evmLabel` guard (review M5):** `+page.svelte:65`
  `evmLabel = $derived(EVM_CHAINS[evmChainId].label)` throws once the id can be
  `'solana'`. Replace with a `rightLabel = $derived(rightChain === 'solana' ?
'Solana' : EVM_CHAINS[rightChain].label)`, feeding both `DirectionSwitcher` and
  `TransferForm`.

### `TransferForm.svelte` (direction-aware — review M4)

Currently unhandled for Solana: `buttonLabel` (`TransferForm.svelte:30-36`) only
special-cases `stellar-to-evm`, so `stellar-to-solana` falls through to a
backwards "Send {evmShort} → Stellar"; and `stellarSource = direction ===
'stellar-to-evm'` (`:40`) leaves the **Fast** speed chip enabled (`:81-94`) for
both Solana directions, contradicting "Fast out of scope" — the page's
`effectiveSpeed` coercion only fixes the submitted value, not the UI. Fix:

- Take `otherLabel` (from the page's `rightLabel`) instead of `evmLabel`; build
  source-aware button copy that reads correctly for all four directions.
- Treat both Solana directions as Fast-disabled (like the Stellar-source case):
  the Fast chip is hidden/disabled and only `standard` is offered.

## `+page.svelte` changes

- State: replace bare `evm` / `evmChainId` with `rightChain: RightChain`,
  `evm: EvmWallet | null`, `solana: SolanaWallet | null`, and `stellarIsSource:
boolean` (the orientation). Derive `direction` and `rightLabel` from
  `(rightChain, stellarIsSource)`.
- Render `<DestinationPanel>` in the top-right instead of `<EvmPanel>`.
- `send()` branches on `rightChain`:
    - Solana: require `solana`; call `start({ direction, stellarAddress,
solanaWallet: solana, amount, speed: 'standard' })` — no `evmWallet`, no
      `evmChainId`.
    - EVM: unchanged.
- **Resume (review B3):** hide `<ResumeForm>` when `rightChain === 'solana'`, and
  `resume()` returns early for Solana. Resume stays EVM/Stellar-only this pass.
- `bothConnected` and other gates branch on `rightChain` (Stellar + the active
  right wallet).
- After `done`, refresh Stellar + the active **right** body (Solana panel or EVM
  panel — Solana may be source or destination, so "right body," not "destination").
- `effectiveSpeed` coerces Solana directions to `standard` (mirrors the existing
  `stellar-to-evm` coercion) — belt-and-suspenders alongside TransferForm hiding
  the Fast chip.

## Store change (proper: no EVM placeholder for Solana)

Solana transfers no longer carry a dummy `evmChainId`. Both `evmWallet` and
`evmChainId` become genuinely optional, and every read is guarded so a Solana
transfer holds no phantom EVM chain.

- `start()` args: `evmWallet?: EvmWallet` and `evmChainId?: EvmChainId`. EVM
  dispatch throws a clear error if either is missing; Solana dispatch ignores
  them.
- `TransferState.evmChainId?: EvmChainId` (optional). `start()` sets it from the
  arg — `undefined` for Solana. The page passes `evmChainId: rightChain ===
'solana' ? undefined : rightChain`.
- `createTransferStore(initialDirection, initialEvmChain?, ...)`: the initial EVM
  chain stays `DEFAULT_EVM_CHAIN` as the _default when EVM is selected_ — that is
  not a Solana placeholder, and it's overwritten per-transfer by `start()`.
- `stepsFor(direction, evmChainId?, ...)`: `evmChainId` optional. `evmLabel` is
  computed eagerly at `transfer.svelte.ts:108` before the Solana branches return
  (`:132-148`), so it would index `EVM_CHAINS[undefined]`. **Move the `evmLabel`
  computation INSIDE the EVM branches** (not merely guard it) — review M7.
- `TransferProgress`: guard `longWaitChainLabel` — `transfer.evmChainId ?
EVM_CHAINS[transfer.evmChainId].label : ''` (already only meaningful for
  `evm-to-stellar`). `evmTxUrl(...)` is only called on EVM paths; confirm no
  unguarded `EVM_CHAINS[transfer.evmChainId]` read remains.
- `resume()`: same optionality — its EVM-only path keeps requiring
  `evmWallet`/`evmChainId`. A Solana resume path is out of scope; but resume must
  not be reachable for Solana (review B3): `resume()` at `transfer.svelte.ts:872`
  assumes `stellarSource = direction === 'stellar-to-evm'` and reads
  `EVM_CHAINS[args.evmChainId].domain` (`:895`), both wrong for Solana, and
  `ResumeForm` validates a `0x` hex hash (`ResumeForm.svelte:34-36`) that Solana
  base58 signatures fail. **The page must hide `<ResumeForm>` and short-circuit
  `resume()` when `rightChain === 'solana'`** (see `+page.svelte` changes).

## Flow toggles / speed

Unchanged gating carries over: StellarPanel's `outboundFlow` / `forwarding`
toggles already render only for `stellar-to-evm`, so they hide for
`stellar-to-solana`; EVM `inboundFlow` is EVM-only. Solana directions use plain
two-tx with `standard` finality — no new toggles. Fast transfer on Solana stays
out of scope.

## Cleanup

Delete `src/routes/solana-spike/` (route + harness). **Sequencing (review M6):**
delete the spike route BEFORE (or in the same step as) stripping `SolanaPanel`'s
props — `solana-spike/+page.svelte:75` passes `bind:amount`/`bind:recipient`/
`steps`/`onBurn` to `SolanaPanel`, so removing those props first breaks
`svelte-check` on the spike. Nothing else imports the spike or the old
SolanaPanel prop shape.

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
5. Burn previews per direction: `stellar-to-solana` shows the Stellar burn to the
   Solana ATA (domain 5); `solana-to-stellar` shows the Solana burn to the
   forwarder (domain 27) with the G-address hook.
6. Switching EVM chip arc→base with an EVM wallet connected actually switches the
   wallet's network and refreshes balance/cap (setChain works); picking a
   wrapperless chain (Ethereum) drops a `wrapper` inbound flow.
7. With Solana selected: the Resume form is hidden, the Fast speed chip is
   absent, and the send button label reads correctly for both directions.
8. An existing EVM ↔ Stellar transfer (e.g. Base) still works unchanged.
9. `/solana-spike` returns 404 (route deleted).

## Out of scope

- Wrapper contract with Solana (later goal).
- Fast transfer on Solana directions.
- EVM ↔ Solana pairing (scope stays Solana ↔ Stellar).
