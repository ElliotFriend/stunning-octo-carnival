# Solana → Stellar CCTP Burn Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn USDC on Solana devnet and mint native USDC on Stellar testnet, driven from a minimal harness on `/solana-spike`.

**Architecture:** Build the Solana `deposit_for_burn_with_hook` instruction from a Codama-generated `@solana/kit` client (from Circle's TokenMessengerMinterV2 IDL). Sign with Phantom (Wallet Standard) + an ephemeral event-data keypair, submit via our pinned devnet RPC. Everything downstream — Circle attestation (`pollAttestation`) and the Stellar mint (`mintAndForward`) — is reused unchanged. Orchestration mirrors the existing `runEvmToStellar` minus the approve step.

**Tech Stack:** SvelteKit (Svelte 5 runes), `@solana/kit` (6.x), `@solana-program/token`, `@wallet-standard/app`, Codama (`@codama/nodes-from-anchor`, `@codama/renderers-js`), Anchor CLI (IDL fetch, dev-only), `@stellar/stellar-sdk`, viem.

## Global Constraints

- Svelte 5 runes only. **No `$effect`** — explicit dataflow (`onMount` + handlers).
- Browser code guarded with `browser` from `$app/environment`.
- `@solana/kit` stays pinned to `^6.5.0` (required by `@solana-program/token@0.14.0`; a 7.x bump drops `getMinimumBalanceForRentExemption` and breaks `vite dev`). Generated code must import from `@solana/kit`, not `@solana/web3.js`.
- **Fund-bricking invariant:** the burn's `mintRecipient` and `destinationCaller` MUST both equal `strkeyToBytes32(STELLAR.contracts.cctpForwarder)`. The real recipient goes only in `hookData`. Assert the contract decode before building the tx.
- CCTP addresses (already in `SOLANA` config): domain 5, `tokenMessengerMinterV2 = CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, `messageTransmitterV2 = CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6-dp). Stellar domain 27, `cctpForwarder = CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ`.
- `pnpm check` and `pnpm lint` must pass. Run the Svelte MCP `svelte-autofixer` on every `.svelte` file until clean.

**Testing note:** No test runner in this repo; the spec's verification is a real devnet→testnet transfer. Tasks 1–6 gate on `pnpm check` (+ `pnpm lint` where `.svelte`/formatting changes). Task 7 is the manual end-to-end run. Do not scaffold a test framework. **`pnpm check` passing does NOT prove runtime correctness** — the balance spike shipped green and still broke at `vite dev` on a version mismatch; only Task 7 proves the path.

---

### Task 1: Extract shared Stellar-recipient encoders

Pure refactor, no new deps — de-risks first. Moves two helpers out of `evm/cctp.ts` so Solana can reuse them without importing EVM code.

**Files:**

- Create: `src/lib/stellar/recipient.ts`
- Modify: `src/lib/evm/cctp.ts` (remove the two functions, import them instead)

**Interfaces:**

- Produces: `strkeyToBytes32(strkey: string): Hex` and `encodeStellarForwarderHookData(stellarStrkey: string): Hex` from `$lib/stellar/recipient`.

- [ ] **Step 1: Create the shared module**

Create `src/lib/stellar/recipient.ts` (verbatim move — these are pure `@stellar/stellar-sdk` + viem hex helpers):

```ts
import { concatHex, pad, stringToHex, toHex, type Hex } from 'viem';
import { StrKey } from '@stellar/stellar-sdk';

// Hook data layout for routing CCTP funds to a Stellar G-address via
// CctpForwarder. From Circle's Stellar CCTP docs:
//
//   bytes 0–23   : 24 magic bytes (zeros, Circle-reserved)
//   bytes 24–27  : version (uint32, currently 0)
//   bytes 28–31  : length of forwardRecipient in bytes (uint32)
//   bytes 32+    : forwardRecipient as UTF-8 encoded strkey (the G-address)
//
// Getting any byte of this wrong will permanently lose funds. Validate
// the strkey first.
export function encodeStellarForwarderHookData(stellarStrkey: string): Hex {
    if (!StrKey.isValidEd25519PublicKey(stellarStrkey)) {
        throw new Error(`Invalid Stellar account: ${stellarStrkey}`);
    }
    const magic = pad('0x', { size: 24 });
    const version = pad(toHex(0), { size: 4 });
    const recipientHex = stringToHex(stellarStrkey);
    const recipientLen = (recipientHex.length - 2) / 2;
    const lengthField = pad(toHex(recipientLen), { size: 4 });
    return concatHex([magic, version, lengthField, recipientHex]);
}

// Convert a Stellar strkey contract or account into a 32-byte bytes32 for
// CCTP message fields. Both `mintRecipient` and `destinationCaller` need
// to be the *raw 32-byte Ed25519 pubkey*, NOT the strkey string itself.
export function strkeyToBytes32(strkey: string): Hex {
    const isContract = StrKey.isValidContract(strkey);
    const raw = isContract ? StrKey.decodeContract(strkey) : StrKey.decodeEd25519PublicKey(strkey);
    return toHex(raw);
}
```

- [ ] **Step 2: Update `evm/cctp.ts`**

In `src/lib/evm/cctp.ts`: delete the `encodeStellarForwarderHookData` (lines ~96–116) and `strkeyToBytes32` (lines ~118–125) function definitions and their leading comment block. Remove now-unused imports from the viem import on line 1 (`concatHex`, `pad`, `stringToHex` — keep `encodeFunctionData`, `erc20Abi`, `toHex`, `type Hex` if still used elsewhere in the file; let `pnpm check` flag any unused). Remove the `StrKey` import on line 2. Add:

```ts
import { encodeStellarForwarderHookData, strkeyToBytes32 } from '$lib/stellar/recipient';
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm check && pnpm lint`
Expected: both PASS. If `pnpm check` reports an unused viem import in `evm/cctp.ts`, remove that identifier from the line-1 import and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/lib/stellar/recipient.ts src/lib/evm/cctp.ts
git commit -m "refactor: extract Stellar CCTP recipient encoders to shared module"
```

---

### Task 2: Codama-generate the TokenMessengerMinterV2 Kit client

**Files:**

- Create: `idl/token_messenger_minter_v2.json` (fetched)
- Create: `scripts/gen-solana-cctp.mjs` (codegen script)
- Create: `src/lib/solana/generated/**` (generated output)
- Modify: `package.json` (dev deps + `gen:solana-cctp` script)

**Interfaces:**

- Produces: a generated instruction builder (expected name `getDepositForBurnWithHookInstructionAsync`) and program-address / PDA-finder exports under `$lib/solana/generated`. **Exact export names are confirmed in Step 5 by inspecting the generated `index.ts`** and used by Task 5.

- [ ] **Step 1: Add dev dependencies**

Run:

```bash
pnpm add -D @codama/nodes-from-anchor @codama/renderers-js codama
```

Expected: packages added under `devDependencies`. Peer warnings acceptable; hard resolution errors are not.

- [ ] **Step 2: Fetch the on-chain IDL**

The IDL is published on-chain (Anchor 0.31, new format). Fetch it (requires the Anchor CLI + Solana CLI from `scripts/solana-devnet-setup.sh`; devnet and mainnet carry the same IDL):

```bash
mkdir -p idl
anchor idl fetch CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe \
  --provider.cluster devnet > idl/token_messenger_minter_v2.json
```

Expected: a JSON file whose `instructions` array contains `deposit_for_burn_with_hook`. Verify:

```bash
grep -c "deposit_for_burn_with_hook" idl/token_messenger_minter_v2.json
```

Expected: at least `1`. If `anchor idl fetch` fails (no on-chain IDL on devnet), retry with `--provider.cluster mainnet`.

- [ ] **Step 3: Write the codegen script**

Create `scripts/gen-solana-cctp.mjs`:

```js
import { readFileSync } from 'node:fs';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const idl = JSON.parse(readFileSync('idl/token_messenger_minter_v2.json', 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.accept(renderVisitor('src/lib/solana/generated'));
console.log('Generated Solana CCTP client → src/lib/solana/generated');
```

- [ ] **Step 4: Add the script + run codegen**

Add to `package.json` `scripts`:

```json
"gen:solana-cctp": "node scripts/gen-solana-cctp.mjs"
```

Run:

```bash
pnpm gen:solana-cctp
```

Expected: `src/lib/solana/generated/` populated (an `index.ts`, `instructions/`, `programs/`, `pdas/`, `accounts/`). No error.

- [ ] **Step 5: Confirm the generated surface**

Run:

```bash
grep -rhoE "export (async )?function get[A-Za-z]*Instruction(Async)?" src/lib/solana/generated/instructions | sort -u
grep -rhoE "export function find[A-Za-z]*Pda" src/lib/solana/generated | sort -u
```

Expected: a `deposit_for_burn_with_hook` builder (likely `getDepositForBurnWithHookInstructionAsync` and a sync `getDepositForBurnWithHookInstruction`) and PDA finders (e.g. `findRemoteTokenMessengerPda`, `findLocalTokenPda`). **Record the exact builder name and open `src/lib/solana/generated/instructions/depositForBurnWithHook.ts` to note the exact input field names (account + arg keys)** — Task 5 depends on these.

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: PASS (generated code is TS and must compile against `@solana/kit` 6.x). If prettier/eslint objects to generated files, add `src/lib/solana/generated/` to `.prettierignore` and the eslint ignores rather than editing generated output.

- [ ] **Step 7: Commit**

```bash
git add idl/ scripts/gen-solana-cctp.mjs src/lib/solana/generated package.json pnpm-lock.yaml .prettierignore eslint.config.js
git commit -m "feat: codama-generate TokenMessengerMinterV2 Kit client from IDL"
```

---

### Task 3: Retain the Wallet Standard account for signing

**Files:**

- Modify: `src/lib/solana/wallet.ts`

**Interfaces:**

- Consumes: `WalletAccount` type from `@wallet-standard/base`.
- Produces: `SolanaWallet` gains an `account: WalletAccount` field (alongside `name`, `icon`, `address`); `connectSolana` and `detectExistingSolana` populate it.

- [ ] **Step 1: Add the account to `SolanaWallet` and the connect paths**

In `src/lib/solana/wallet.ts`:

Add `WalletAccount` to the type import:

```ts
import type { Wallet, WalletAccount } from '@wallet-standard/base';
```

Extend the type:

```ts
export type SolanaWallet = {
    name: string;
    icon: string;
    address: string;
    account: WalletAccount;
};
```

Update the return in `connectSolana` (the `accounts[0]` is a `WalletAccount`):

```ts
return { name: info.name, icon: info.icon, address: accounts[0].address, account: accounts[0] };
```

Update the return in `detectExistingSolana` likewise:

```ts
return { name: info.name, icon: info.icon, address: accounts[0].address, account: accounts[0] };
```

The local `ConnectableAccount` type is no longer precise enough (we now keep the whole account). Change the `ConnectFeature` type to return real accounts:

```ts
type ConnectFeature = {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }>;
};
```

and delete the `type ConnectableAccount = { address: string };` line.

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. `SolanaPanel.svelte` reads only `wallet.name`/`.address`, so adding a field doesn't break it.

- [ ] **Step 3: Commit**

```bash
git add src/lib/solana/wallet.ts
git commit -m "feat: retain Wallet Standard account on SolanaWallet for signing"
```

---

### Task 4: Solana signer (Wallet Standard + ephemeral keypair)

**Files:**

- Create: `src/lib/solana/signer.ts`

**Interfaces:**

- Consumes: `SolanaWallet` from `$lib/solana/wallet`; `solanaRpc` from `$lib/solana/client`; `@solana/kit`.
- Produces: `signAndSendBurnTx(args: { wallet: SolanaWallet; instruction: IInstruction; extraSigners: KeyPairSigner[] }): Promise<string>` — builds a tx with `instruction`, fee payer = wallet address, recent blockhash from `solanaRpc`; the wallet signs via Wallet Standard `solana:signTransaction`; `extraSigners` (the ephemeral event-data keypair) partial-sign; submits via `solanaRpc` and returns the base58 signature.

> **API-name caveat:** `@solana/kit` 6.x re-exports the modular `@solana/*` packages. The imports below are the current Kit surface; if `pnpm check` reports a missing export, find the equivalent in the installed `node_modules/@solana/kit` types and adjust the import — do NOT switch to `@solana/web3.js`.

- [ ] **Step 1: Implement the signer**

Create `src/lib/solana/signer.ts`:

```ts
import {
    appendTransactionMessageInstruction,
    assertIsTransactionMessageWithSingleSendingSigner,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    partiallySignTransactionMessageWithSigners,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type IInstruction,
    type KeyPairSigner,
    type Address,
} from '@solana/kit';
import { getBase64Decoder } from '@solana/kit';
import { solanaRpc } from './client';
import type { SolanaWallet } from './wallet';

const SOLANA_DEVNET_CHAIN = 'solana:devnet';

// Minimal shape of the Wallet Standard solana:signTransaction feature.
// Kept local (mirrors evm/wallet.ts keeping EIP-6963 types local).
type SignTransactionFeature = {
    signTransaction: (input: {
        account: SolanaWallet['account'];
        transaction: Uint8Array;
        chain: string;
    }) => Promise<
        { signedTransaction: Uint8Array } | ReadonlyArray<{ signedTransaction: Uint8Array }>
    >;
};

export async function signAndSendBurnTx(args: {
    wallet: SolanaWallet;
    instruction: IInstruction;
    extraSigners: KeyPairSigner[];
}): Promise<string> {
    const { wallet, instruction, extraSigners } = args;

    const { value: blockhash } = await solanaRpc.getLatestBlockhash().send();

    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(wallet.address as Address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstruction(instruction, m),
    );

    // Ephemeral signers (the message_sent_event_data keypair) sign locally;
    // the fee-payer (wallet) slot is left for Phantom to fill.
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message, {
        // extraSigners are attached to the message via the instruction's
        // account signers; partiallySign collects whatever KeyPairSigners it finds.
    });

    // Hand the wire bytes to Phantom for the fee-payer signature.
    const feature = wallet.account.features as unknown as Record<string, unknown>;
    const signFeature = feature['solana:signTransaction'] as SignTransactionFeature;
    const wireUnsigned = new Uint8Array(
        Buffer.from(getBase64EncodedWireTransaction(partiallySigned), 'base64'),
    );
    const res = await signFeature.signTransaction({
        account: wallet.account,
        transaction: wireUnsigned,
        chain: SOLANA_DEVNET_CHAIN,
    });
    const signed = Array.isArray(res) ? res[0] : (res as { signedTransaction: Uint8Array });

    const wireBase64 = getBase64Decoder().decode(signed.signedTransaction);
    const signature = await solanaRpc
        .sendTransaction(wireBase64, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();

    return signature;
}
```

> **Implementation reality check for the executor:** the exact mechanism for attaching `extraSigners` to the message and getting Kit to embed the ephemeral signature depends on whether the generated instruction marks `messageSentEventData` as a `TransactionSigner` account. Two known-good options — pick whichever the installed Kit + generated types support, verified by `pnpm check` and Task 7's run:
>
> 1. Pass the ephemeral signer as the `messageSentEventData` account **value** when building the instruction in Task 5 (a `KeyPairSigner`, not a bare `Address`). Then `partiallySignTransactionMessageWithSigners(message)` embeds its signature automatically and `extraSigners` is unused here.
> 2. If the generated builder only accepts an `Address` for that account, generate the keypair, add it via `addSignersToTransactionMessage([ephemeral], message)` before partial-signing.
>
> Prefer option 1. The `assertIsTransactionMessageWithSingleSendingSigner` import is only needed if you switch to a send-via-wallet flow; it can be dropped for the sign-then-send-via-our-RPC flow above.

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. Fix any import-name drift per the caveat above.

- [ ] **Step 3: Commit**

```bash
git add src/lib/solana/signer.ts
git commit -m "feat: Solana tx signer via Wallet Standard + ephemeral keypair"
```

---

### Task 5: `burnUsdcToStellar` + config + amount parse

**Files:**

- Create: `src/lib/solana/cctp.ts`
- Modify: `src/lib/solana/usdc.ts` (add `parseUsdcSolana`)
- Modify: `src/lib/config.ts` (`Direction` + `SOLANA_MAX_FEE`)

**Interfaces:**

- Consumes: generated builder from `$lib/solana/generated` (name from Task 2 Step 5); `strkeyToBytes32`, `encodeStellarForwarderHookData` from `$lib/stellar/recipient`; `findAssociatedTokenPda`, `TOKEN_PROGRAM_ADDRESS` from `@solana-program/token`; `signAndSendBurnTx` from `$lib/solana/signer`; `solanaRpc`; `SOLANA`, `STELLAR`, `STANDARD_THRESHOLD` from config; `generateKeyPairSigner`, `address`, `getBytesEncoder` from `@solana/kit`.
- Produces:
    - `parseUsdcSolana(amount: string): bigint` (in `usdc.ts`)
    - `burnUsdcToStellar(args: { wallet: SolanaWallet; amount: bigint; stellarRecipient: string; maxFee: bigint; minFinalityThreshold: number }): Promise<{ signature: string }>` (in `cctp.ts`)
    - config: `Direction` includes `'solana-to-stellar'`; `export const SOLANA_MAX_FEE = 500n`

- [ ] **Step 1: Add `parseUsdcSolana`**

Append to `src/lib/solana/usdc.ts`:

```ts
// "5" / "5.25" → 6-dp USDC subunits (5_000000n / 5_250000n).
export function parseUsdcSolana(amount: string): bigint {
    const [whole, frac = ''] = amount.trim().split('.');
    const fracPadded = (frac + '000000').slice(0, 6);
    return BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0');
}
```

- [ ] **Step 2: Extend config**

In `src/lib/config.ts`, change the `Direction` type (currently `export type Direction = 'stellar-to-evm' | 'evm-to-stellar';`) to:

```ts
export type Direction = 'stellar-to-evm' | 'evm-to-stellar' | 'solana-to-stellar';
```

And add, next to `EVM_MAX_FEE`:

```ts
// Solana USDC is 6-dp like EVM, so the same 500n (≈ $0.0005) buffer applies.
export const SOLANA_MAX_FEE = 500n;
```

- [ ] **Step 3: Implement `burnUsdcToStellar`**

Create `src/lib/solana/cctp.ts`. Replace `getDepositForBurnWithHookInstructionAsync` and the input field names with the exact names recorded in Task 2 Step 5 if they differ:

```ts
import { address, generateKeyPairSigner, getBytesEncoder } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { hexToBytes, type Hex } from 'viem';
import { getDepositForBurnWithHookInstructionAsync } from './generated';
import { encodeStellarForwarderHookData, strkeyToBytes32 } from '$lib/stellar/recipient';
import { signAndSendBurnTx } from './signer';
import { SOLANA, STELLAR } from '$lib/config';
import type { SolanaWallet } from './wallet';

// 32 raw bytes of the Stellar CctpForwarder contract id — used for BOTH
// mintRecipient and destinationCaller. Getting this wrong bricks funds, so
// derive it once from config via the shared strkey decoder.
function forwarderBytes32(): Uint8Array {
    const hex = strkeyToBytes32(STELLAR.contracts.cctpForwarder) as Hex; // 0x + 64 hex
    const bytes = hexToBytes(hex);
    if (bytes.length !== 32) throw new Error('Forwarder did not decode to 32 bytes');
    return bytes;
}

export async function burnUsdcToStellar(args: {
    wallet: SolanaWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    minFinalityThreshold: number;
}): Promise<{ signature: string }> {
    const owner = address(args.wallet.address);
    const mint = address(SOLANA.usdc.mint);

    const [burnTokenAccount] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    const recipient = forwarderBytes32(); // mintRecipient === destinationCaller
    const hookData = hexToBytes(encodeStellarForwarderHookData(args.stellarRecipient) as Hex);

    // Ephemeral account that stores the MessageSent event data (a signer).
    const messageSentEventData = await generateKeyPairSigner();

    const instruction = await getDepositForBurnWithHookInstructionAsync({
        // accounts we must supply (PDAs auto-resolve from IDL seeds):
        owner: { address: owner } as never, // see note: owner is the wallet signer
        eventRentPayer: { address: owner } as never,
        burnTokenAccount,
        burnTokenMint: mint,
        messageSentEventData,
        // args:
        amount: args.amount,
        destinationDomain: STELLAR.domain,
        mintRecipient: recipient,
        destinationCaller: recipient,
        maxFee: args.maxFee,
        minFinalityThreshold: args.minFinalityThreshold,
        hookData,
    });

    const signature = await signAndSendBurnTx({
        wallet: args.wallet,
        instruction,
        extraSigners: [messageSentEventData],
    });
    return { signature };
}
```

> **Signer wiring note (resolve during build, confirmed by Task 7):** `owner`/`eventRentPayer` are the Phantom-signed fee payer. The generated builder may want these as a `TransactionSigner`. Since Phantom signs the assembled wire bytes (not via a Kit signer), pass the owner as an address-only account — if the generated type requires a signer object, wrap it as a no-op signer whose signing is deferred to the wallet, OR pass `owner` as the fee payer only (already set in the signer) and the account list as addresses. The `as never` casts above are placeholders to be replaced with whatever the generated input type actually requires; remove them once the real shape is known. This is the single most fragile spot — expect one iteration here against the generated types.

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS once the account-input shape matches the generated types. Adjust field names/casts per Task 2 Step 5's recorded surface.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solana/cctp.ts src/lib/solana/usdc.ts src/lib/config.ts
git commit -m "feat: burnUsdcToStellar Solana CCTP burn + config wiring"
```

---

### Task 6: `runSolanaToStellar` in the transfer store

**Files:**

- Modify: `src/lib/stores/transfer.svelte.ts`

**Interfaces:**

- Consumes: `burnUsdcToStellar` from `$lib/solana/cctp`; `parseUsdcSolana` from `$lib/solana/usdc`; `SolanaWallet` from `$lib/solana/wallet`; `SOLANA`, `SOLANA_MAX_FEE`, `STANDARD_THRESHOLD` from config; existing `fetchBurnFee`, `computeMaxFee`, `feeBpsFor`, `thresholdFor`, `pollAttestation`, `mintAndForward`, `performStep`.
- Produces: `start` accepts optional `solanaWallet?: SolanaWallet`; dispatches to a new `runSolanaToStellar` when `direction === 'solana-to-stellar'`.

- [ ] **Step 1: Add imports**

At the top of `src/lib/stores/transfer.svelte.ts`, add to the config import the `SOLANA` and `SOLANA_MAX_FEE` names, and add:

```ts
import { burnUsdcToStellar } from '$lib/solana/cctp';
import { parseUsdcSolana } from '$lib/solana/usdc';
import type { SolanaWallet } from '$lib/solana/wallet';
```

- [ ] **Step 2: Add `runSolanaToStellar`**

Add this function next to `runEvmToStellar` (mirrors it, no approve step). `stellarAddress` is the connected Freighter address; it is both the mint caller and (by default) the `stellarRecipient` in the hook:

```ts
async function runSolanaToStellar(args: {
    stellarAddress: string;
    stellarRecipient: string;
    solanaWallet: SolanaWallet;
    amount: string;
    speed: TransferSpeed;
}) {
    state.amount = args.amount;
    const solAmount = parseUsdcSolana(args.amount);

    const burnHash = await performStep('burning', 'burn', async () => {
        const feeRows = await fetchBurnFee(SOLANA.domain, STELLAR.domain);
        const maxFee = computeMaxFee(solAmount, feeBpsFor(feeRows, args.speed), SOLANA_MAX_FEE);
        const { signature } = await burnUsdcToStellar({
            wallet: args.solanaWallet,
            amount: solAmount,
            stellarRecipient: args.stellarRecipient,
            maxFee,
            minFinalityThreshold: thresholdFor(args.speed),
        });
        return {
            result: signature,
            patch: {
                hash: signature,
                hashUrl: `${SOLANA.explorer}/tx/${signature}?cluster=devnet`,
            },
        };
    });
    if (burnHash === null) return;

    const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
        const msg = await pollAttestation(SOLANA.domain, burnHash, {
            onProgress: ({ elapsedMs, status }) => {
                patchStep('attest', { detail: `${Math.round(elapsedMs / 1000)}s — ${status}` });
            },
        });
        return { result: msg };
    });
    if (attest === null) return;
    state.attestation = attest;

    const mintHash = await performStep('minting', 'mint', async () => {
        const { hash } = await mintAndForward({
            caller: args.stellarAddress,
            message: hexToBytes(attest.message as Hex),
            attestation: hexToBytes(attest.attestation as Hex),
        });
        return { result: hash, patch: { hash, hashUrl: stellarTxUrl(hash) } };
    });
    if (mintHash === null) return;

    state.phase = 'done';
}
```

- [ ] **Step 3: Thread through `start`**

In `start`'s args object, add:

```ts
        solanaWallet?: SolanaWallet;
        stellarRecipient?: string;
```

and change the dispatch block:

```ts
try {
    if (args.direction === 'stellar-to-evm') {
        await runStellarToEvm(args);
    } else if (args.direction === 'solana-to-stellar') {
        if (!args.solanaWallet) throw new Error('Solana wallet not connected.');
        await runSolanaToStellar({
            stellarAddress: args.stellarAddress,
            stellarRecipient: args.stellarRecipient ?? args.stellarAddress,
            solanaWallet: args.solanaWallet,
            amount: args.amount,
            speed: args.speed,
        });
    } else {
        await runEvmToStellar(args);
    }
} catch (err) {
    fail(errMsg(err));
}
```

- [ ] **Step 4: Handle the step list**

`stepsFor` builds per-direction step lists. Find its `switch`/branches and add a `solana-to-stellar` case producing the burn→attest→mint steps (no approve):

```ts
// inside stepsFor, add a branch:
if (direction === 'solana-to-stellar') {
    return [
        { key: 'burn', label: 'Burn USDC on Solana', status: 'pending' },
        { key: 'attest', label: 'Circle attestation', status: 'pending' },
        { key: 'mint', label: 'Mint USDC on Stellar', status: 'pending' },
    ];
}
```

(Match the exact `Step` object shape already used in `stepsFor` — copy the field style of the existing `evm-to-stellar` branch, adding `hashUrl`/`detail` only if that branch does.)

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS. `IrisMessage`, `Hex`, `hexToBytes`, `stellarTxUrl` are already imported in this file (used by `runEvmToStellar`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/stores/transfer.svelte.ts
git commit -m "feat: runSolanaToStellar orchestration (burn -> attest -> mint)"
```

---

### Task 7: Burn harness on `/solana-spike` + end-to-end verification

**Files:**

- Modify: `src/lib/components/SolanaPanel.svelte` (add burn form + step readout)
- Modify: `src/routes/solana-spike/+page.svelte` (add Freighter connect + wire the store)

**Interfaces:**

- Consumes: `createTransferStore` from `$lib/stores/transfer.svelte`; `connectFreighter`, `detectFreighter`, `type FreighterState` from `$lib/stellar/freighter`; `DEFAULT_SPEED` from config.

- [ ] **Step 1: Add the burn form to `SolanaPanel.svelte`**

Add to the `<script>` new `$bindable` props for the burn form and delegate the action to a parent-provided callback (keeps the panel dumb; the page owns the store). Add props:

```ts
let {
    wallet = $bindable<SolanaWallet | null>(null),
    amount = $bindable<string>('5'),
    recipient = $bindable<string>(''),
    onBurn,
    steps = [],
}: {
    wallet?: SolanaWallet | null;
    amount?: string;
    recipient?: string;
    onBurn?: () => void;
    steps?: { key: string; label: string; status: string; hashUrl?: string; detail?: string }[];
} = $props();
```

Add to the connected-wallet block of the markup:

```svelte
{#if wallet}
    <label>Amount USDC <input bind:value={amount} /></label>
    <label>Stellar recipient (G…) <input bind:value={recipient} /></label>
    <button onclick={() => onBurn?.()}>Burn → Stellar</button>
    <ul class="steps">
        {#each steps as s (s.key)}
            <li>
                {s.label}: {s.status}
                {#if s.detail}<span class="detail"> ({s.detail})</span>{/if}
                {#if s.hashUrl}<a href={s.hashUrl} target="_blank" rel="noreferrer">tx</a>{/if}
            </li>
        {/each}
    </ul>
{/if}
```

- [ ] **Step 2: Validate with Svelte MCP**

Run `svelte-autofixer` on `src/lib/components/SolanaPanel.svelte`; apply fixes until clean.

- [ ] **Step 3: Wire the store + Freighter in the route**

Rewrite `src/routes/solana-spike/+page.svelte`:

```svelte
<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import SolanaPanel from '$lib/components/SolanaPanel.svelte';
    import type { SolanaWallet } from '$lib/solana/wallet';
    import { connectFreighter, detectFreighter, type FreighterState } from '$lib/stellar/freighter';
    import { createTransferStore } from '$lib/stores/transfer.svelte';
    import { DEFAULT_SPEED, DEFAULT_EVM_CHAIN } from '$lib/config';

    let wallet = $state<SolanaWallet | null>(null);
    let amount = $state('5');
    let recipient = $state('');
    let stellar = $state<FreighterState>({
        installed: false,
        address: null,
        networkPassphrase: null,
    });

    const store = createTransferStore(
        'solana-to-stellar',
        DEFAULT_EVM_CHAIN,
        'two-tx',
        false,
        'two-tx',
    );

    onMount(async () => {
        if (!browser) return;
        stellar = await detectFreighter();
        if (stellar.address) recipient = stellar.address;
    });

    async function connectStellar() {
        stellar = await connectFreighter();
        if (stellar.address && !recipient) recipient = stellar.address;
    }

    async function burn() {
        if (!wallet || !stellar.address) return;
        await store.start({
            direction: 'solana-to-stellar',
            stellarAddress: stellar.address,
            stellarRecipient: recipient || stellar.address,
            solanaWallet: wallet,
            amount,
            // unused by this direction but required by the start() arg shape:
            evmWallet: undefined as never,
            evmChainId: DEFAULT_EVM_CHAIN,
            outboundFlow: 'two-tx',
            forwarding: false,
            inboundFlow: 'two-tx',
            speed: DEFAULT_SPEED,
        });
    }
</script>

<h1>Solana → Stellar burn spike</h1>

{#if !stellar.address}
    <button onclick={connectStellar}>Connect Freighter (destination)</button>
{:else}
    <p>Stellar: <code>{stellar.address}</code></p>
{/if}

<SolanaPanel bind:wallet bind:amount bind:recipient steps={store.state.steps} onBurn={burn} />

{#if store.state.error}<p class="error">{store.state.error}</p>{/if}
```

> **Note on `start`'s arg shape:** `start` currently requires `evmWallet`/`evmChainId`/`outboundFlow`/`inboundFlow`. Rather than pass `undefined as never`, prefer making those fields optional in `start`'s type (Task 6) since `solana-to-stellar` ignores them. If Task 6 didn't already loosen them, do it now (make `evmWallet?`, and default the others) and re-run `pnpm check`.

- [ ] **Step 4: Validate route with Svelte MCP**

Run `svelte-autofixer` on `src/routes/solana-spike/+page.svelte`; apply fixes until clean.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm check && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: End-to-end manual verification (the real gate)**

Precondition: Phantom on devnet funded with USDC (from the balance spike); Freighter on Stellar **testnet** with a funded account for the mint fee.

1. Run: `pnpm dev`
2. Open `http://localhost:5173/solana-spike` (use whatever URL `pnpm dev` prints).
3. Connect Phantom; confirm the USDC balance shows.
4. Connect Freighter (destination); confirm its G-address fills the recipient field.
5. Enter amount `5`, click **Burn → Stellar**, approve the Phantom prompt.
6. Watch: **burn** completes (Solana tx link), **attest** progresses then completes, **mint** completes (Stellar tx link).
7. **Confirm on stellar.expert/explorer/testnet** that the recipient G-address received ~5 USDC.

**Iris risk checkpoint:** if the **attest** step hangs/errors with a 404-style "message not found", the Solana signature is likely being sent to Iris in the wrong encoding. Fix: in `circle/iris.ts` (or at the `pollAttestation` call), hex-encode the base58 signature before the Iris lookup, then re-run. Do this only if it actually fails — verify first.

Pass criterion: step 7 shows the USDC arrived. Green = the Solana → Stellar path works end-to-end.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/SolanaPanel.svelte src/routes/solana-spike/+page.svelte src/lib/stores/transfer.svelte.ts
git commit -m "feat: /solana-spike burn harness — Solana -> Stellar transfer"
```

---

## Verification summary

- Tasks 1–6: `pnpm check` passes after each (+ `pnpm lint` on 1 and 7).
- Task 7: a real 5-USDC transfer burns on Solana devnet and mints to a Stellar testnet G-address, confirmed on stellar.expert.
- Highest-risk spots, in order: (a) the generated builder's account/signer input shape (Task 5 signer-wiring note), (b) Phantom `solana:signTransaction` + ephemeral co-signer assembly (Task 4), (c) Iris signature encoding (Task 7 checkpoint). None are provable by typecheck — Task 7 is the gate.
