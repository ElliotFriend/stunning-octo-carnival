# Solana → Stellar CCTP burn path — design

**Date:** 2026-07-10
**Status:** approved, pre-implementation

## Goal

Add the Solana → Stellar direction to the CCTP demo: burn USDC on Solana devnet
and mint native USDC on Stellar testnet, driven from a minimal harness on the
existing `/solana-spike` route. This is the first real transfer path for Solana
(the balance spike proved the wallet + RPC + ATA stack; see
`2026-07-10-solana-balance-spike-design.md`).

Scope is **Solana ↔ Stellar only** — this spec covers the Solana → Stellar
(burn-on-Solana) half. The reverse (Stellar → Solana) is a later spec.

## Context

The repo already bridges Stellar ↔ EVM. The map that informs this design:

- **Mint side is already built.** Completing a burn on Stellar is
  `mintAndForward({ caller, message, attestation })` in `stellar/cctp.ts` — a
  permissionless call to the `CctpForwarder` contract. The recipient is carried
  in the burn's `hookData`, not as a call argument. No new Stellar code.
- **Attestation is already built.** `pollAttestation(sourceDomain, txHash, opts)`
  and `fetchAttestation` in `circle/iris.ts` key a burn by **source domain +
  transaction hash** (not nonce). For Solana, `sourceDomain = SOLANA.domain = 5`
  and `txHash = ` the burn signature.
- **Orchestration is reusable.** `stores/transfer.svelte.ts` exposes
  `performStep`/`Step`/`Phase` machinery that is direction-agnostic.
  `runEvmToStellar` (burn → attest → mint) is the template to mirror.
- **Recipient encoding is solved for EVM** and portable — see below.

Solana → Stellar is _simpler_ than EVM → Stellar: Solana `deposit_for_burn`
burns directly under the owner's signature via CPI, so there is **no approve
step** — a single burn transaction (plus one ephemeral co-signer).

The hard part is the one thing not yet built: constructing and signing the
Solana `deposit_for_burn_with_hook` instruction (~15 accounts, several PDAs,
Anchor discriminator, borsh args).

## Decision: Codama-generated Kit client

Build the instruction from a **Codama-generated `@solana/kit` client**, produced
from Circle's TokenMessengerMinterV2 Anchor IDL. This is the Solana analog of
`stellar contract bindings typescript`: an interface description (IDL) generates
a typed client, so we call `getDepositForBurnWithHookInstruction({...})` instead
of hand-encoding a discriminator + borsh + a long account list.

Rejected alternatives:

- **Hand-roll with Kit** — minimal deps, but most error-prone on the ~15-account
  list; the generated client removes that risk.
- **Anchor + @solana/web3.js v1** — Circle's documented path, but drags a second
  Solana SDK into the Kit foundation just built. The consistency wart deliberately
  avoided when Wallet Standard was chosen over the legacy provider.

**IDL provenance:** the IDL is Anchor 0.31.0 (new 0.30+ format, Codama-compatible)
and is published on-chain. Fetch with
`anchor idl fetch CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` (same program id and
IDL on devnet and mainnet). The 0.30+ IDL carries PDA seed definitions, so the
generated builder auto-resolves most PDAs (token_messenger, token_minter,
local_token, sender_authority, denylist); we supply the leaf accounts (owner,
burn ATA, mint, ephemeral event-data) and args.

## Module layout

| File                           | Responsibility                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/solana/generated/`    | Codama-generated Kit client (typed instruction builder + PDA finders + program address). Committed. Regenerated via a documented script, not edited by hand.               |
| `src/lib/stellar/recipient.ts` | **Extracted** `strkeyToBytes32` and `encodeStellarForwarderHookData` from `evm/cctp.ts` (pure `@stellar/stellar-sdk`, no viem). Imported by both `evm/cctp.ts` and Solana. |
| `src/lib/solana/cctp.ts`       | `burnUsdcToStellar(args)` — derive ATA + PDAs, encode mintRecipient/destinationCaller/hookData, build → sign → submit, return `{ signature }`.                             |
| `src/lib/solana/signer.ts`     | Bridge Wallet Standard `solana:signTransaction` for use with Kit, plus the ephemeral `message_sent_event_data` keypair co-signer.                                          |

Modified:

- `src/lib/solana/wallet.ts` — retain the Wallet Standard account on the connected
  wallet so it can sign (today `SolanaWallet` holds only name/icon/address).
- `src/lib/evm/cctp.ts` — swap the two moved helpers to imports from
  `stellar/recipient.ts` (no behavior change).
- `src/lib/config.ts` — add `Direction` member `'solana-to-stellar'`; add
  `SOLANA_MAX_FEE = 500n` (6-dp, mirroring `EVM_MAX_FEE`).
- `src/lib/stores/transfer.svelte.ts` — add `runSolanaToStellar`; thread a
  `SolanaWallet` through `start`.
- `src/routes/solana-spike/+page.svelte` + `SolanaPanel.svelte` — minimal burn
  harness.

## Codegen

`anchor idl fetch` → `idl/token_messenger_minter_v2.json`, then Codama
(`@codama/nodes-from-anchor` + `@codama/renderers-js`) renders the Kit client
into `src/lib/solana/generated/`. Documented as a `pnpm gen:solana-cctp` script.
`@codama/*` and the Anchor CLI (for the fetch) are dev-only; the generated output
has no runtime dep beyond `@solana/kit`, which is already present.

## Burn arguments

Replicating the EVM burn invariant exactly (`evm/cctp.ts`):

- `amount` — 6-dp USDC subunits.
- `destinationDomain` — `STELLAR.domain` = 27.
- `burnToken` — `SOLANA.usdc.mint`.
- `mintRecipient` = `destinationCaller` = `strkeyToBytes32(STELLAR.contracts.cctpForwarder)`
  — the forwarder contract's raw 32 bytes. **These MUST be equal and MUST be the
  forwarder**; any other value permanently bricks the funds. Implementation asserts
  a valid contract decode.
- `maxFee` = `SOLANA_MAX_FEE` (500n, 6-dp).
- `minFinalityThreshold` = `STANDARD_THRESHOLD` (2000).
- `hookData` = `encodeStellarForwarderHookData(gAddress)` — carries the real
  G-address recipient (24 magic zero bytes + version u32 + len u32 + ASCII strkey).

Standard speed only for this spec; fast (threshold 1000 + fast fee) is deferred.

## Signing

1. Build the transaction message with Kit: fee payer = owner, recent blockhash
   from the pinned devnet `solanaRpc`, the burn instruction appended.
2. `message_sent_event_data` is a fresh `generateKeyPairSigner()` that
   partial-signs (writable signer).
3. Phantom signs via the Wallet Standard `solana:signTransaction` feature with
   chain `solana:devnet`.
4. Submit through **our** `solanaRpc.sendTransaction` (not the wallet's
   connection, so the network stays pinned to devnet) and confirm.

## Orchestration

- `Direction` gains `'solana-to-stellar'`.
- `runSolanaToStellar(args)` mirrors `runEvmToStellar` without the approve step:
    1. **burn** — `performStep('burning','burn', … burnUsdcToStellar(...))` → signature.
    2. **attest** — `performStep('attesting','attest', … pollAttestation(SOLANA.domain, signature, { onProgress }))`.
    3. **mint** — `performStep('minting','mint', … mintAndForward({ caller: stellarAddress, message: hexToBytes(attest.message), attestation: hexToBytes(attest.attestation) }))`, then phase `'done'`.
- `start` accepts a `SolanaWallet` and the destination G-address; dispatches to
  `runSolanaToStellar` when `direction === 'solana-to-stellar'`.
- Fee route: `fetchBurnFee(SOLANA.domain, STELLAR.domain)`; `maxFee` via
  `computeMaxFee(amount, feeBpsFor(rows, 'standard'), SOLANA_MAX_FEE)`.

## Minimal harness

On `/solana-spike` (throwaway, matching the balance spike): connected Phantom +
balance (already there), plus an amount input, a Stellar G-address recipient
input, a "Burn → Stellar" button, and the burn/attest/mint step readout driven
by the transfer store. No main-page integration in this spec.

## Error handling and open risks

- **Iris signature encoding (open risk, verify at runtime).** Iris keys on source
  domain + tx hash and the current code only exercises hex (EVM/Stellar) hashes.
  Solana signatures are base58. It is unverified whether Iris expects base58 or a
  hex-encoded signature for domain 5. If the first real run's attestation poll
  404s, the fix is to hex-encode the signature bytes before the Iris lookup. Do
  not pre-solve; confirm against the live sandbox during verification.
- Burn tx failure, user rejection of the Phantom prompt, and attestation timeout
  all surface through the existing `fail()` / `performStep` error funnel.
- `mintRecipient`/`destinationCaller` decode is asserted before building the tx.

## Verification

Real devnet → testnet transfer, run manually (the "must actually run it" gate
that caught the Kit version break in the balance spike):

1. `pnpm dev`, open `/solana-spike`, connect Phantom (devnet), confirm USDC balance.
2. Enter an amount (e.g. 5) and a Stellar testnet G-address.
3. Click **Burn → Stellar**; approve in Phantom.
4. Watch burn → attest → mint steps complete.
5. Confirm the USDC arrived at the G-address on Stellar testnet
   (stellar.expert/explorer/testnet).

Green means the full Solana → Stellar path works end-to-end.

## Out of scope

- Stellar → Solana (reverse direction) — later spec.
- Fast-transfer speed on Solana.
- Main-page UI integration / `Direction` selector in the real panels.
- Any EVM ↔ Solana pairing (scope is Solana ↔ Stellar).
- Multi-wallet beyond Phantom.
