# Stellar → Solana CCTP mint path — design

**Date:** 2026-07-10
**Status:** approved, pre-implementation

## Goal

Add the Stellar → Solana direction: burn USDC on Stellar testnet targeting Solana
domain 5, then mint native USDC on Solana devnet via `receiveMessage`. This is the
reverse of the shipped Solana → Stellar path
(`2026-07-10-solana-to-stellar-burn-design.md`) and completes the Solana ↔ Stellar
CCTP domain. Driven from the existing `/solana-spike` harness with a direction toggle.

Scope: Solana ↔ Stellar only. Standard finality only (`minFinalityThreshold =
2000`); fast transfer deferred.

## Context

The map from the codebase:

- **Burn side mostly exists.** `stellar/cctp.ts` `deposit_for_burn` is already
  domain-parameterized (`destinationDomain` is a passed `u32`, not hardcoded). The
  only EVM-specific piece is recipient encoding (`leftPad32FromHex`, right-aligned
  20-byte EVM address). Fee sizing uses the 7-dp `STELLAR_MAX_FEE` floor and
  `fetchBurnFee(STELLAR.domain, destDomain)`. Burn is signed via Freighter through
  `tx.ts` `simulateSignAndSubmit`.
- **Mint side is entirely new.** There is no Solana `receiveMessage` client — only
  the `tokenMessengerMinterV2` program was generated; `messageTransmitterV2` is not.
  The mint is `MessageTransmitterV2.receiveMessage`, which CPIs into
  TokenMessengerMinterV2's `handle_receive_finalized_message` to mint.
- **Orchestration + signing reuse.** `runStellarToEvm` is the structural template
  (approve → burn → attest → mint). `solana/signer.ts` `signAndSendBurnTx` sends a
  Phantom-signed tx through our devnet RPC and is reused for the mint. `circle/iris.ts`
  `pollAttestation` is unchanged; the burn is keyed by the Stellar (hex) tx hash.

### Facts that shape the mint

From Circle's solana-cctp-contracts:

- **The recipient's USDC ATA must already exist.** `receiveMessage` does NOT create
  it. The burn's `mintRecipient` is the recipient's **ATA** (not the wallet); the
  program validates `recipient_token_account == mintRecipient`.
- **`receiveMessage` CPIs via `remaining_accounts`** that the Anchor IDL does not
  encode, so Codama cannot auto-resolve them — they are assembled by hand.
- The mint is **permissionless** (any payer submits); here Phantom pays and receives.

## Decision: Codama + hand-assembled CPI

Generate the MessageTransmitterV2 Kit client (as done for TMM) for `receiveMessage`'s
direct accounts + arg encoding, then hand-assemble the CPI `remaining_accounts` and
their PDAs. Stays Kit-native and consistent with the shipped forward path. The
rejected alternative — Circle's `@coral-xyz/anchor` + `@solana/web3.js` v1 client
isolated to the mint — would lower assembly risk but drags in the second Solana SDK
deliberately avoided, and forces bridging Phantom (Wallet Standard) signing across
SDKs.

This is the highest-risk build in the project: the CPI account list/order and the
message-derived PDA seeds are only truly settled by a live run.

## Codegen reorganization

Reorganize `src/lib/solana/generated/` into per-program subdirs:

- `generated/token-messenger-minter/` — existing TMM client (moved).
- `generated/message-transmitter/` — new MessageTransmitterV2 client.

`scripts/gen-solana-cctp.mjs` fetches both on-chain IDLs
(`anchor idl fetch` for `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` and
`CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`) and renders each into its subdir,
applying the same post-processing already in place (remap `@solana/program-client-core`
→ `@solana/kit/program-client-core`; strip `process.env.NODE_ENV`). `solana/cctp.ts`
updates its import to `./generated/token-messenger-minter`.

## Burn side

- **`stellar/recipient.ts`** — add `solanaAtaToBytes32(ownerAddress: string): Uint8Array`:
  derive the owner's USDC ATA via `findAssociatedTokenPda({ owner, tokenProgram:
TOKEN_PROGRAM_ADDRESS, mint: SOLANA.usdc.mint })`, then `getAddressEncoder().encode(ata)`
  → 32 raw bytes (Solana pubkeys are already full 32-byte, left-aligned; do NOT reuse
  the right-aligned `leftPad32FromHex`).
- **`stellar/cctp.ts`** — add `depositForBurnToSolana(args: { caller: string; amount:
bigint; mintRecipient: Uint8Array; maxFee: bigint; finalityThreshold: number }):
Promise<{ hash: string; sourceDomain: number }>`. Same `deposit_for_burn` ScVal
  shape as `depositForBurnToEvm` with `destinationDomain: SOLANA.domain` (5),
  `mintRecipient` = the passed 32 bytes, `destinationCaller = ZERO_BYTES_32`
  (permissionless), no hook. Requires the existing `approveUsdc` against
  `tokenMessengerMinter` first (two-tx).

## Mint side (new)

New `src/lib/solana/mint.ts`:

`receiveMessageOnSolana(args: { wallet: SolanaWallet; recipientOwner: string; message:
Hex; attestation: Hex }): Promise<{ signature: string }>`.

1. Decode `message`/`attestation` hex → bytes.
2. Derive accounts/PDAs:
    - `used_nonce` — PDA `["used_nonce", <nonce slice of the message bytes>]`. Parse the
      CCTP V2 message at the nonce offset.
    - `message_transmitter` — PDA `["message_transmitter"]` under MessageTransmitterV2.
    - `authority_pda` — `["message_transmitter_authority", tokenMessengerMinterProgram]`.
    - `event_authority` / program accounts as required.
    - CPI (`remaining_accounts`): `token_messenger` `["token_messenger"]`,
      `remote_token_messenger` `["remote_token_messenger","27"]`, `token_minter`
      `["token_minter"]`, `local_token` `["local_token", mint]`, `token_pair`
      `["token_pair","27", <Stellar USDC remote-token bytes32>]`, `custody`
      `["custody", mint]`, `fee_recipient` ATA, `recipient` ATA (= burn `mintRecipient`),
      `token_program`.
3. Build `[createAssociatedTokenAccountIdempotent(recipientOwner, mint),
receiveMessage(...)]` in one transaction so the recipient ATA is guaranteed to
   exist before the mint CPI.
4. Sign with Phantom + submit via the existing `signer.ts` path (generalize
   `signAndSendBurnTx` to accept multiple instructions, or add a sibling that does).

## Orchestration

- `Direction += 'stellar-to-solana'`.
- `runStellarToSolana(args: { stellarAddress: string; solanaWallet: SolanaWallet;
amount: string; speed: TransferSpeed })` mirrors `runStellarToEvm`:
    1. **approve** — `approveUsdc` against `tokenMessengerMinter` (reused).
    2. **burn** — `depositForBurnToSolana({ caller: stellarAddress, amount, mintRecipient:
solanaAtaToBytes32(solanaWallet.address), maxFee, finalityThreshold })`. Fees:
       `fetchBurnFee(STELLAR.domain, SOLANA.domain)`, `computeMaxFee(amount, bps,
STELLAR_MAX_FEE)`, `thresholdFor('standard')`.
    3. **attest** — `pollAttestation(STELLAR.domain, burnHash)`.
    4. **mint** — `receiveMessageOnSolana({ wallet: solanaWallet, recipientOwner:
solanaWallet.address, message, attestation })`.
- `start` branch for `'stellar-to-solana'`; `stepsFor` case (approve → burn → attest
  → mint).

## Harness

Extend `/solana-spike` with a direction toggle (Solana→Stellar / Stellar→Solana),
reusing the already-present Phantom + Freighter connections. Reverse mode: source =
Freighter, destination = Phantom (its USDC ATA); the amount field is reused. Throwaway.

## Error handling

- Burn / approve failure, Freighter rejection, attestation timeout → existing `fail()`
  funnel.
- Recipient ATA absent → handled by the idempotent-create instruction, not an error.
- Mint CPI failure (wrong account/PDA) → surfaced with the Solana error; this is the
  expected iteration point.

## Risks (settled only by a live run)

- **CPI account list/order** — hand-assembled; the primary iteration point.
- **`used_nonce` PDA** — requires parsing the CCTP V2 message for the nonce slice at
  the correct offset.
- **`token_pair` seeds** — `["token_pair", "27", <Stellar USDC remote-token bytes>]`;
  the remote-token bytes must match what the burn recorded.
- **ATA idempotent-create ordering** — must precede `receiveMessage` in the same tx.

## Verification

Real Stellar testnet → Solana devnet transfer from `/solana-spike` (Stellar→Solana
mode):

1. `pnpm dev`, connect Freighter (testnet, funded) + Phantom (devnet, some SOL for the
   mint fee).
2. Amount 5, burn on Freighter (approve + burn prompts).
3. Watch approve → burn → attest → mint.
4. Confirm Phantom's USDC balance increased by ~5 on devnet.

## Out of scope

- Fast transfer on the Stellar→Solana path.
- Main-page UI integration (still the throwaway harness).
- EVM ↔ Solana pairing.
- Reclaiming rent from `used_nonce` / `message_sent_event_data` accounts.
