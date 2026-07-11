# Stellar → Solana CCTP Mint Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Burn USDC on Stellar testnet to Solana domain 5, then mint native USDC on Solana devnet via `MessageTransmitterV2.receiveMessage`, driven from the `/solana-spike` harness.

**Architecture:** Reuse the domain-parameterized Stellar `deposit_for_burn` (new Solana-recipient encoder + a `depositForBurnToSolana` variant). The new hard part is the Solana mint: a Codama-generated MessageTransmitterV2 `receiveMessage` for the fixed accounts + arg codec, with the ~11 CPI `remaining_accounts` hand-assembled (the Anchor IDL doesn't encode them). Bundle `createAssociatedTokenAccountIdempotent` so the recipient ATA exists. Orchestration mirrors `runStellarToEvm`.

**Tech Stack:** SvelteKit (Svelte 5 runes), `@solana/kit` 6.x, `@solana-program/token`, Codama, `@stellar/stellar-sdk`, viem.

## Global Constraints

- Svelte 5 runes, **no `$effect`**; browser code guarded with `browser`.
- `@solana/kit` pinned `^6.5.0`. Generated code must import from `@solana/kit` (the gen script already remaps `@solana/program-client-core` → `@solana/kit/program-client-core` and strips `process.env.NODE_ENV`).
- Standard finality only (`minFinalityThreshold = STANDARD_THRESHOLD = 2000`). Stellar-source burn fee uses the **7-dp `STELLAR_MAX_FEE`** floor and `fetchBurnFee(STELLAR.domain, SOLANA.domain)` — NOT `SOLANA_MAX_FEE`.
- **Fund-safety:** the burn `mintRecipient` is the recipient's **USDC ATA** (32 raw bytes, left-aligned — Solana pubkeys fill all 32), NOT the wallet and NOT right-aligned. `destinationCaller = ZERO_BYTES_32` (permissionless mint).
- Addresses (config): Stellar domain 27, USDC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, TMM `CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP`. Solana domain 5, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, TMM program `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, MessageTransmitter program `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`.
- `pnpm check` + `pnpm lint` pass; run `svelte-autofixer` on `.svelte` files.

**CCTP V2 message layout** (byte offsets — needed for the mint): version 0–3, sourceDomain 4–7, destinationDomain 8–11, **nonce 12–43 (32 bytes)**, sender 44–75, recipient 76–107, destinationCaller 108–139, minFinalityThreshold 140–143, finalityThresholdExecuted 144–147, **burn message body from 148**. Burn body: version 0–3 then **burnToken at body 4–35** → absolute message bytes **152–183**.

**Testing note:** no test runner; the spec's verification is a real Stellar-testnet→Solana-devnet transfer. Tasks 1–4 gate on `pnpm check`; Task 5 is the manual run. `pnpm check` proves nothing about the CPI account list — only the live run does. The mint task is expected to iterate.

---

### Task 1: Reorganize generated/ + generate MessageTransmitterV2 client

**Files:**

- Modify: `scripts/gen-solana-cctp.mjs` (fetch + render both programs into subdirs)
- Move: `src/lib/solana/generated/*` → `src/lib/solana/generated/token-messenger-minter/`
- Create: `src/lib/solana/generated/message-transmitter/**`
- Modify: `src/lib/solana/cctp.ts` (import path), `idl/` (add second IDL)

**Interfaces:**

- Produces: `getReceiveMessageInstructionAsync` (or `getReceiveMessageInstruction`) + `MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS` under `$lib/solana/generated/message-transmitter`; TMM client moves to `$lib/solana/generated/token-messenger-minter` (exact names confirmed in Step 4).

- [ ] **Step 1: Rewrite the gen script for two programs**

Replace the body of `scripts/gen-solana-cctp.mjs` below the imports with a loop over both programs. Keep the existing `patchGenerated` (core remap + `process.env` strip). Full script:

```js
import { readFileSync, writeFileSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

// Refresh IDLs with:
//   anchor idl fetch CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe --provider.cluster devnet > idl/token_messenger_minter_v2.json
//   anchor idl fetch CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC --provider.cluster devnet > idl/message_transmitter_v2.json
const PROGRAMS = [
    {
        idl: 'idl/token_messenger_minter_v2.json',
        out: 'src/lib/solana/generated/token-messenger-minter',
    },
    { idl: 'idl/message_transmitter_v2.json', out: 'src/lib/solana/generated/message-transmitter' },
];

function patchGenerated(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) patchGenerated(p);
        else if (entry.name.endsWith('.ts')) {
            const src = readFileSync(p, 'utf8');
            const fixed = src
                .replaceAll("'@solana/program-client-core'", "'@solana/kit/program-client-core'")
                .replaceAll("process.env['NODE_ENV'] !== 'production'", 'true');
            if (fixed !== src) writeFileSync(p, fixed);
        }
    }
}

for (const { idl, out } of PROGRAMS) {
    const tmp = `${out}-tmp`;
    const codama = createFromRoot(rootNodeFromAnchor(JSON.parse(readFileSync(idl, 'utf8'))));
    await codama.accept(renderVisitor(tmp, { formatCode: false }));
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    renameSync(`${tmp}/src/generated`, out);
    rmSync(tmp, { recursive: true, force: true });
    patchGenerated(out);
    console.log(`Generated → ${out}`);
}
```

- [ ] **Step 2: Fetch the MessageTransmitterV2 IDL**

Run:

```bash
anchor idl fetch CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC --provider.cluster devnet > idl/message_transmitter_v2.json
grep -c "receive_message" idl/message_transmitter_v2.json
```

Expected: file written; grep ≥ 1. If devnet fetch fails, retry `--provider.cluster mainnet`.

- [ ] **Step 3: Remove the old flat generated dir and regenerate**

```bash
rm -rf src/lib/solana/generated
pnpm gen:solana-cctp
ls src/lib/solana/generated
```

Expected: two subdirs `token-messenger-minter/` and `message-transmitter/`, each with `index.ts`, `instructions/`, `programs/`, `pdas/`, `accounts/`.

- [ ] **Step 4: Confirm the receiveMessage surface + update the TMM import**

```bash
grep -rhoE "export (async )?function getReceiveMessageInstruction(Async)?" src/lib/solana/generated/message-transmitter/instructions/*.ts | sort -u
grep -rhoE "MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS" src/lib/solana/generated/message-transmitter/programs/*.ts | head -1
```

Record the builder name and open `.../message-transmitter/instructions/receiveMessage.ts` to note the exact input field names (Task 3 depends on them). Then update `src/lib/solana/cctp.ts`: change `from './generated'` to `from './generated/token-messenger-minter'`.

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: PASS (generated code compiles; the moved import resolves).

- [ ] **Step 6: Commit**

```bash
git add idl scripts/gen-solana-cctp.mjs src/lib/solana/generated src/lib/solana/cctp.ts
git commit -m "feat: generate MessageTransmitterV2 client; split generated/ by program"
```

---

### Task 2: Stellar burn targeting Solana

**Files:**

- Modify: `src/lib/stellar/recipient.ts` (add `solanaAtaToBytes32`)
- Modify: `src/lib/stellar/cctp.ts` (add `depositForBurnToSolana`)
- Modify: `src/lib/config.ts` (`Direction += 'stellar-to-solana'`)

**Interfaces:**

- Consumes: `findAssociatedTokenPda`, `TOKEN_PROGRAM_ADDRESS` (`@solana-program/token`); `address`, `getAddressEncoder` (`@solana/kit`); `SOLANA` config.
- Produces:
    - `solanaAtaToBytes32(ownerAddress: string): Promise<Uint8Array>` (32 bytes)
    - `depositForBurnToSolana(args: { caller: string; amount: bigint; mintRecipient: Uint8Array; maxFee: bigint; finalityThreshold: number }): Promise<{ hash: string; sourceDomain: number }>`
    - `Direction` includes `'stellar-to-solana'`

- [ ] **Step 1: Add `solanaAtaToBytes32`**

Append to `src/lib/stellar/recipient.ts`:

```ts
import { address, getAddressEncoder } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { SOLANA } from '$lib/config';

// A Solana owner's USDC ATA as raw 32 bytes, for use as the CCTP burn
// mintRecipient when the destination is Solana. Solana pubkeys already fill
// all 32 bytes (left-aligned) — do NOT right-pad like the EVM helper.
export async function solanaAtaToBytes32(ownerAddress: string): Promise<Uint8Array> {
    const [ata] = await findAssociatedTokenPda({
        owner: address(ownerAddress),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: address(SOLANA.usdc.mint),
    });
    return new Uint8Array(getAddressEncoder().encode(ata));
}
```

- [ ] **Step 2: Add `depositForBurnToSolana`**

In `src/lib/stellar/cctp.ts`, after `depositForBurnToEvm` (mirrors it; recipient is passed as raw 32 bytes, domain fixed to Solana):

```ts
// Burn USDC on Stellar bound for Solana (domain 5). mintRecipient is the
// recipient's Solana USDC ATA as raw 32 bytes (see solanaAtaToBytes32).
// destinationCaller stays zero — the Solana mint is permissionless. No hook.
export async function depositForBurnToSolana(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    mintRecipient: Uint8Array; // 32 bytes — recipient's Solana USDC ATA
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
    const account = await stellarRpc.getAccount(args.caller);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            tmm.call(
                'deposit_for_burn',
                Address.fromString(args.caller).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(SOLANA.domain, { type: 'u32' }),
                bytesN32(args.mintRecipient),
                Address.fromString(STELLAR.contracts.usdc).toScVal(),
                bytesN32(ZERO_BYTES_32),
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash, sourceDomain: STELLAR.domain };
}
```

Add `SOLANA` to the config import at the top of `stellar/cctp.ts` if not already imported.

- [ ] **Step 3: Extend `Direction`**

In `src/lib/config.ts`:

```ts
export type Direction =
    'stellar-to-evm' | 'evm-to-stellar' | 'solana-to-stellar' | 'stellar-to-solana';
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm check` → PASS.

```bash
git add src/lib/stellar/recipient.ts src/lib/stellar/cctp.ts src/lib/config.ts
git commit -m "feat: Stellar deposit_for_burn targeting Solana (domain 5)"
```

---

### Task 3: Solana receiveMessage mint

**Files:**

- Create: `src/lib/solana/mint.ts`
- Modify: `src/lib/solana/signer.ts` (accept multiple instructions)

**Interfaces:**

- Consumes: generated `getReceiveMessageInstructionAsync` + `MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS` (`./generated/message-transmitter`); `TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS` (`./generated/token-messenger-minter`); `getCreateAssociatedTokenIdempotentInstructionAsync`, `findAssociatedTokenPda`, `TOKEN_PROGRAM_ADDRESS` (`@solana-program/token`); `address`, `getProgramDerivedAddress`, `getAddressEncoder`, `createNoopSigner`, `fetchEncodedAccount`, `AccountRole`, `type Instruction` (`@solana/kit`); `fetchTokenMessenger` decoder (`./generated/token-messenger-minter/accounts`); `solanaRpc`; `SOLANA`; `hexToBytes`/`Hex` (viem); `SolanaWallet`.
- Produces: `receiveMessageOnSolana(args: { wallet: SolanaWallet; recipientOwner: string; message: Hex; attestation: Hex }): Promise<{ signature: string }>`.

> **What the mint actually does (review correction):** on Solana the receive is NOT a `mint_to` — `handle_receive_finalized_message` **transfers USDC from Circle's shared `custody_token_account` to the recipient ATA** (and a fee to the fee-recipient ATA). So there is no mint account in the CPI list (correctly omitted), and success depends on Circle-side devnet state: the `token_pair(27, StellarUSDC)`, `remote_token_messenger(27)`, and a funded custody. **Pre-flight already run: `remote_token_messenger(27)` and `token_pair(27, StellarUSDC)` both EXIST on devnet** (and the `token_pair` seed encoding `["token_pair","27",decodeContract(usdc)]` is thereby confirmed). Custody funding can still cause a runtime failure — if the mint reverts with an insufficient-funds/custody error, that's Circle's devnet liquidity, not our code.

- [ ] **Step 1: Generalize the signer to take multiple instructions**

In `src/lib/solana/signer.ts`, rename `signAndSendBurnTx` → `signAndSendSolanaTx` and change `instruction: Instruction` to `instructions: Instruction[]`, appending each:

```ts
export async function signAndSendSolanaTx(args: {
    wallet: SolanaWallet;
    instructions: Instruction[];
    feePayerSigner: TransactionSigner;
}): Promise<string> {
    const { wallet, instructions, feePayerSigner } = args;
    const { value: blockhash } = await solanaRpc.getLatestBlockhash().send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => instructions.reduce((acc, ix) => appendTransactionMessageInstruction(ix, acc), m),
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const wireUnsigned = new Uint8Array(getTransactionEncoder().encode(partiallySigned));
    const features = wallet.standardWallet.features as unknown as Record<string, unknown>;
    const signFeature = features['solana:signTransaction'] as SignTransactionFeature | undefined;
    if (!signFeature) throw new Error('Wallet does not support solana:signTransaction.');
    const res = await signFeature.signTransaction({
        account: wallet.account,
        transaction: wireUnsigned,
        chain: SOLANA_DEVNET_CHAIN,
    });
    const signed = Array.isArray(res) ? res[0] : (res as SignTransactionOutput);
    const wireBase64 = getBase64Decoder().decode(
        signed.signedTransaction,
    ) as Base64EncodedWireTransaction;
    return solanaRpc
        .sendTransaction(wireBase64, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();
}
```

Update `src/lib/solana/cctp.ts` in BOTH places: the import (`import { signAndSendBurnTx }` → `import { signAndSendSolanaTx }`) AND the call (`signAndSendBurnTx({ wallet, instruction, feePayerSigner })` → `signAndSendSolanaTx({ wallet, instructions: [instruction], feePayerSigner })`). Missing the import rename fails `pnpm check`.

- [ ] **Step 2: Implement `receiveMessageOnSolana`**

Create `src/lib/solana/mint.ts`. Account order and PDA seeds are from Circle's test client (verify against the generated `receiveMessage` input names from Task 1 Step 4). The CPI `remaining_accounts` order is: tokenMessenger(ro), remoteTokenMessenger(ro), tokenMinter(w), localToken(w), tokenPair(ro), feeRecipientAta(w), recipientAta(w), custody(w), tokenProgram(ro), tokenMessengerEventAuthority(ro), tmmProgram(ro).

```ts
import {
    AccountRole,
    address,
    createNoopSigner,
    fetchEncodedAccount,
    getAddressEncoder,
    getProgramDerivedAddress,
    type Address,
    type Instruction,
} from '@solana/kit';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { hexToBytes, type Hex } from 'viem';
import { getReceiveMessageInstructionAsync } from './generated/message-transmitter';
import {
    TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS,
    fetchTokenMessenger,
} from './generated/token-messenger-minter';
import { signAndSendSolanaTx } from './signer';
import { solanaRpc } from './client';
import { SOLANA, STELLAR } from '$lib/config';
import type { SolanaWallet } from './wallet';

const MT = address(SOLANA.programs.messageTransmitterV2);
const TMM = TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS;
const enc = getAddressEncoder();

const pda = (programAddress: Address, seeds: (string | Uint8Array)[]) =>
    getProgramDerivedAddress({ programAddress, seeds }).then(([a]) => a);

export async function receiveMessageOnSolana(args: {
    wallet: SolanaWallet;
    recipientOwner: string;
    message: Hex;
    attestation: Hex;
}): Promise<{ signature: string }> {
    const message = new Uint8Array(hexToBytes(args.message));
    const attestation = new Uint8Array(hexToBytes(args.attestation));

    // CCTP V2 message fields (see plan header for offsets).
    const nonce = message.slice(12, 44); //            used_nonce seed
    const remoteDomain = String(STELLAR.domain); //    source = Stellar (27), ASCII seed
    const burnToken = message.slice(152, 184); //      token_pair remote-token seed
    const mint = address(SOLANA.usdc.mint);

    const owner = address(args.recipientOwner);
    const [recipientAta] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    // MessageTransmitter direct PDAs.
    const messageTransmitter = await pda(MT, ['message_transmitter']);
    const authorityPda = await pda(MT, [
        'message_transmitter_authority',
        new Uint8Array(enc.encode(TMM)),
    ]);
    const usedNonce = await pda(MT, ['used_nonce', nonce]);

    // TMM CPI PDAs.
    const tokenMessenger = await pda(TMM, ['token_messenger']);
    const tokenMinter = await pda(TMM, ['token_minter']);
    const remoteTokenMessenger = await pda(TMM, ['remote_token_messenger', remoteDomain]);
    const localToken = await pda(TMM, ['local_token', new Uint8Array(enc.encode(mint))]);
    const tokenPair = await pda(TMM, ['token_pair', remoteDomain, burnToken]);
    const custody = await pda(TMM, ['custody', new Uint8Array(enc.encode(mint))]);
    const tmmEventAuthority = await pda(TMM, ['__event_authority']);

    // fee_recipient ATA — read TokenMessenger.feeRecipient from chain, derive its ATA.
    const tmAcct = await fetchTokenMessenger(solanaRpc, tokenMessenger);
    const [feeRecipientAta] = await findAssociatedTokenPda({
        owner: tmAcct.data.feeRecipient,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    const ownerSigner = createNoopSigner(owner); // Phantom pays + is caller

    // Idempotent ATA create so the recipient token account exists for the mint.
    const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: ownerSigner,
        owner,
        mint,
    });

    const base = await getReceiveMessageInstructionAsync({
        payer: ownerSigner,
        caller: ownerSigner,
        messageTransmitter,
        authorityPda,
        usedNonce,
        receiver: TMM,
        message,
        attestation,
    });

    // Append the CPI remaining accounts (order + roles from Circle's client).
    const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
    const receive: Instruction = {
        ...base,
        accounts: [
            ...(base.accounts ?? []),
            ro(tokenMessenger),
            ro(remoteTokenMessenger),
            w(tokenMinter),
            w(localToken),
            ro(tokenPair),
            w(feeRecipientAta),
            w(recipientAta),
            w(custody),
            ro(TOKEN_PROGRAM_ADDRESS),
            ro(tmmEventAuthority),
            ro(TMM),
        ],
    };

    const signature = await signAndSendSolanaTx({
        wallet: args.wallet,
        instructions: [createAta, receive],
        feePayerSigner: ownerSigner,
    });
    return { signature };
}
```

> **Fragile spots to reconcile at build/run (adversarial-review-informed):**
>
> - **(critical) event-CPI alignment.** `receive_message` uses `#[event_cpi]`, so MessageTransmitter's OWN `event_authority` (`["__event_authority"]` under the MT program) + `program` (the MT program address) must be the **last two fixed accounts** in `base.accounts`. Codama normally auto-resolves them — but **verify they're present** before appending the CPI accounts. If they're missing, every hand-appended CPI account is shifted by two and the tx fails cryptically. (This `event_authority` is the MT program's, distinct from the `tmmEventAuthority` in the CPI list, which is TMM's.)
> - Generated `getReceiveMessageInstructionAsync` field names + which of authorityPda/usedNonce/messageTransmitter it auto-resolves (adjust per Task 1 Step 4).
> - `receiver: TMM` as an `Address` is confirmed correct (deepwiki: `receiver` is an `UncheckedAccount`, and `authority_pda` seeds are `["message_transmitter_authority", receiver.key()]`).
> - `fetchTokenMessenger` field name confirmed `feeRecipient`; its ATA (not the wallet) is `fee_recipient_token_account`.
> - Account roles: signer flags come from the generated base ix; every hand-appended CPI account is non-signer (READONLY/WRITABLE only). `tokenMinter` is WRITABLE (matches Circle's client even though the Rust field isn't `mut`).
>
> The CPI account **order + roles below are a verified exact match to Circle's `test_client.ts`** — do not reorder them.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm check` → PASS (fix the `ownerSigner` name and any generated-field mismatches).

```bash
git add src/lib/solana/mint.ts src/lib/solana/signer.ts src/lib/solana/cctp.ts
git commit -m "feat: receiveMessageOnSolana mint (Codama + hand-assembled CPI)"
```

---

### Task 4: runStellarToSolana orchestration

**Files:**

- Modify: `src/lib/stores/transfer.svelte.ts`

**Interfaces:**

- Consumes: `depositForBurnToSolana` (`stellar/cctp`), `solanaAtaToBytes32` (`stellar/recipient`), `receiveMessageOnSolana` (`solana/mint`), existing `approveUsdc`/`getUsdcAllowance`/`parseUsdcStellar` (`stellar/usdc`), `fetchBurnFee`/`computeMaxFee`/`feeBpsFor`/`thresholdFor`, `pollAttestation`, `SOLANA`, `STELLAR`, `STELLAR_MAX_FEE`, `SolanaWallet`.
- Produces: `runStellarToSolana`; `start` handles `'stellar-to-solana'`; `stepsFor` case.

- [ ] **Step 1: Imports**

Add to `transfer.svelte.ts`: `import { depositForBurnToSolana } from '$lib/stellar/cctp';` (add to the existing `stellar/cctp` import), `import { solanaAtaToBytes32 } from '$lib/stellar/recipient';`, `import { receiveMessageOnSolana } from '$lib/solana/mint';`. (`approveUsdc`, `getUsdcAllowance`, `parseUsdcStellar`, `SolanaWallet`, `STELLAR_MAX_FEE` already imported.)

- [ ] **Step 2: Add `runStellarToSolana`**

Next to `runStellarToEvm` (approve → burn → attest → mint). `solanaWallet` is the destination; its ATA is the burn recipient and it signs the mint:

```ts
async function runStellarToSolana(args: {
    stellarAddress: string;
    solanaWallet: SolanaWallet;
    amount: string;
    speed: TransferSpeed;
}) {
    state.amount = args.amount;
    const stellarAmount = parseUsdcStellar(args.amount);

    const approved = await performStep('approving', 'approve', async () => {
        // Signatures per stellar/usdc.ts: {from, spender} objects; spender = the
        // TMM (it pulls via transfer_from). Copied from runStellarToEvm two-tx path.
        const existing = await getUsdcAllowance({
            from: args.stellarAddress,
            spender: STELLAR.contracts.tokenMessengerMinter,
        });
        if (existing < stellarAmount) {
            await approveUsdc({
                from: args.stellarAddress,
                spender: STELLAR.contracts.tokenMessengerMinter,
                amount: stellarAmount,
            });
        }
        return { result: true };
    });
    if (approved === null) return;

    const burnHash = await performStep('burning', 'burn', async () => {
        const feeRows = await fetchBurnFee(STELLAR.domain, SOLANA.domain);
        const maxFee = computeMaxFee(
            stellarAmount,
            feeBpsFor(feeRows, args.speed),
            STELLAR_MAX_FEE,
        );
        const mintRecipient = await solanaAtaToBytes32(args.solanaWallet.address);
        const { hash } = await depositForBurnToSolana({
            caller: args.stellarAddress,
            amount: stellarAmount,
            mintRecipient,
            maxFee,
            finalityThreshold: thresholdFor(args.speed),
        });
        return { result: hash, patch: { hash, hashUrl: stellarTxUrl(hash) } };
    });
    if (burnHash === null) return;

    const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
        const msg = await pollAttestation(STELLAR.domain, burnHash, {
            onProgress: ({ elapsedMs, status }) => {
                patchStep('attest', { detail: `${Math.round(elapsedMs / 1000)}s — ${status}` });
            },
        });
        return { result: msg };
    });
    if (attest === null) return;
    state.attestation = attest;

    const mintSig = await performStep('minting', 'mint', async () => {
        const { signature } = await receiveMessageOnSolana({
            wallet: args.solanaWallet,
            recipientOwner: args.solanaWallet.address,
            message: attest.message as Hex,
            attestation: attest.attestation as Hex,
        });
        return {
            result: signature,
            patch: {
                hash: signature,
                hashUrl: `${SOLANA.explorer}/tx/${signature}?cluster=devnet`,
            },
        };
    });
    if (mintSig === null) return;

    state.phase = 'done';
}
```

These `{from, spender, amount}` signatures are confirmed against `stellar/usdc.ts` and match `runStellarToEvm`'s two-tx approve block.

- [ ] **Step 3: stepsFor case + start branch**

In `stepsFor`, add before the EVM fallthrough:

```ts
if (direction === 'stellar-to-solana') {
    return [
        { key: 'approve', label: 'Approve TokenMessenger on Stellar', status: 'pending' },
        { key: 'burn', label: 'Burn USDC on Stellar', status: 'pending' },
        { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
        { key: 'mint', label: 'Mint USDC on Solana', status: 'pending' },
    ];
}
```

In `start`'s dispatch, add:

```ts
            } else if (args.direction === 'stellar-to-solana') {
                if (!args.solanaWallet) throw new Error('Solana wallet not connected.');
                await runStellarToSolana({
                    stellarAddress: args.stellarAddress,
                    solanaWallet: args.solanaWallet,
                    amount: args.amount,
                    speed: args.speed,
                });
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm check` → PASS.

```bash
git add src/lib/stores/transfer.svelte.ts
git commit -m "feat: runStellarToSolana orchestration (approve -> burn -> attest -> mint)"
```

---

### Task 5: Harness direction toggle + end-to-end verification

**Files:**

- Modify: `src/routes/solana-spike/+page.svelte`
- Modify: `src/lib/components/SolanaPanel.svelte` (optional label)

**Interfaces:**

- Consumes: `createTransferStore`, `connectFreighter`/`detectFreighter`, `DEFAULT_SPEED`, `DEFAULT_EVM_CHAIN`.

- [ ] **Step 1: Add a direction toggle + route both burns**

In `src/routes/solana-spike/+page.svelte`, add a `direction` state and radio/select, and branch the `burn()` action. Both directions need Phantom + Freighter connected. For `stellar-to-solana`: source = Freighter (signs burn), destination = Phantom (its ATA receives; signs mint). Update `store.start`:

```svelte
    let direction = $state<'solana-to-stellar' | 'stellar-to-solana'>('solana-to-stellar');
```

```svelte
    async function burn() {
        if (!wallet || !stellar.address) return;
        await store.start({
            direction,
            stellarAddress: stellar.address,
            stellarRecipient: recipient || stellar.address,
            solanaWallet: wallet,
            amount,
            evmWallet: undefined as never,
            evmChainId: DEFAULT_EVM_CHAIN,
            outboundFlow: 'two-tx',
            forwarding: false,
            inboundFlow: 'two-tx',
            speed: DEFAULT_SPEED,
        });
    }
```

Add the toggle markup near the top:

```svelte
<label>
    Direction
    <select bind:value={direction}>
        <option value="solana-to-stellar">Solana → Stellar</option>
        <option value="stellar-to-solana">Stellar → Solana</option>
    </select>
</label>
```

- [ ] **Step 2: Validate with Svelte MCP + typecheck + lint**

Run `svelte-autofixer` on the route until clean. Then `pnpm check && pnpm lint` → PASS.

- [ ] **Step 3: End-to-end manual verification (the real gate)**

Preconditions: Freighter on Stellar testnet with USDC + a trustline; Phantom on devnet with some SOL for the mint fee. (Phantom's USDC ATA need not pre-exist — the idempotent create handles it.)

1. `pnpm dev`, open `/solana-spike`, switch Direction to **Stellar → Solana**.
2. Connect both wallets. Amount `5`. Burn (approve + burn prompts in Freighter).
3. Watch approve → burn → attest → mint.
4. Confirm Phantom's devnet USDC balance increased by ~5 (SolanaPanel Refresh, or Phantom).

**Iteration expectation:** the **mint** step is where failures will surface (wrong CPI account/order/PDA). Read the Solana simulation error, compare against the account list, fix `mint.ts`, re-run. Likely suspects: `token_pair` remote-token bytes, `used_nonce` slice, event-authority account, fee-recipient ATA.

- [ ] **Step 4: Commit**

```bash
git add src/routes/solana-spike/+page.svelte src/lib/components/SolanaPanel.svelte
git commit -m "feat: /solana-spike direction toggle — Stellar -> Solana transfer"
```

---

## Verification summary

- Tasks 1–4: `pnpm check` after each.
- Task 5: a real 5-USDC Stellar-testnet→Solana-devnet transfer, confirmed by Phantom's devnet USDC balance.
- Highest-risk, in order: (a) the `receiveMessage` CPI account list/order/roles (Task 3), (b) `used_nonce` (msg[12:44]) + `token_pair` remote-token (msg[152:184]) seeds, (c) fee-recipient ATA derivation. None are provable by typecheck — Task 5 is the gate. This is why an adversarial review of the account assembly precedes execution.
