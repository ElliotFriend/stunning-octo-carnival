import {
    Address,
    BASE_FEE,
    Contract,
    TransactionBuilder,
    nativeToScVal,
    xdr,
} from '@stellar/stellar-sdk';
import { STELLAR } from '$lib/config';
import { stellarRpc } from './client';
import { simulateSignAndSubmit } from './tx';

const tmm = new Contract(STELLAR.contracts.tokenMessengerMinter);
const bridgeWrapper = new Contract(STELLAR.contracts.bridgeWrapper);
const forwarder = new Contract(STELLAR.contracts.cctpForwarder);

// Direct call to the TMM's `deposit_for_burn`. Caller must `approveUsdc` for
// the TMM as a spender on USDC SAC first — the TMM pulls funds via
// `transfer_from`, not user-authorized `transfer`. Two transactions total.
export async function depositForBurnToEvm(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    destinationDomain: number;
    evmRecipient: `0x${string}`;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
    const account = await stellarRpc.getAccount(args.caller);

    const mintRecipient = leftPad32FromHex(args.evmRecipient);
    const destinationCaller = ZERO_BYTES_32;

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            tmm.call(
                'deposit_for_burn',
                Address.fromString(args.caller).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(args.destinationDomain, { type: 'u32' }),
                bytesN32(mintRecipient),
                Address.fromString(STELLAR.contracts.usdc).toScVal(),
                bytesN32(destinationCaller),
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash, sourceDomain: STELLAR.domain };
}

// Calls the user-deployed wrapper contract's `approve_and_deposit`, which
// internally `approve`s the TMM as a USDC spender and then invokes
// `deposit_for_burn` — both within one Soroban transaction. Soroban's auth
// tree lets a single user signature authorize both nested calls, so the user
// sees one Freighter prompt and pays one network fee.
export async function bridgeUsdcToEvm(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    destinationDomain: number;
    evmRecipient: `0x${string}`;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
    const account = await stellarRpc.getAccount(args.caller);

    const mintRecipient = leftPad32FromHex(args.evmRecipient);
    const destinationCaller = ZERO_BYTES_32;

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            bridgeWrapper.call(
                'approve_and_deposit',
                Address.fromString(args.caller).toScVal(),
                Address.fromString(STELLAR.contracts.usdc).toScVal(),
                Address.fromString(STELLAR.contracts.tokenMessengerMinter).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(args.destinationDomain, { type: 'u32' }),
                bytesN32(mintRecipient),
                bytesN32(destinationCaller),
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash, sourceDomain: STELLAR.domain };
}

// Wrapper flow + Circle forwarding: the wrapper's `approve_and_deposit_with_hook`
// mirrors `approve_and_deposit` but forwards a trailing `hook_data` into the
// inner `deposit_for_burn_with_hook`. One Soroban tx, one Freighter prompt, with
// the forwarding magic carried through. hookData is the same 32-byte payload the
// two-tx forwarding path uses.
export async function bridgeUsdcToEvmWithHook(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    destinationDomain: number;
    evmRecipient: `0x${string}`;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
    const account = await stellarRpc.getAccount(args.caller);

    const mintRecipient = leftPad32FromHex(args.evmRecipient);
    const destinationCaller = ZERO_BYTES_32;
    const hookData = encodeCctpForwardHookData();

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            bridgeWrapper.call(
                'approve_and_deposit_with_hook',
                Address.fromString(args.caller).toScVal(),
                Address.fromString(STELLAR.contracts.usdc).toScVal(),
                Address.fromString(STELLAR.contracts.tokenMessengerMinter).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(args.destinationDomain, { type: 'u32' }),
                bytesN32(mintRecipient),
                bytesN32(destinationCaller),
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
                nativeToScVal(hookData, { type: 'bytes' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash, sourceDomain: STELLAR.domain };
}

// ─────────────────────────────────────────────────────────────────────
//  EXPERIMENTAL — Circle Crosschain Forwarding Service trigger (outbound)
// ─────────────────────────────────────────────────────────────────────
// Same as depositForBurnToEvm, but calls deposit_for_burn_with_hook with the
// Circle forwarding-service magic hookData. Circle's hosted relayer watches
// source chains for this magic and auto-completes the destination mint,
// deducting its fee from the minted USDC — so the user pays no destination gas.
//
// hookData layout (Circle docs):
//   bytes 0–23 : 24-byte magic, ascii "cctp-forward" left-aligned, zero-padded
//   bytes 24–27: u32 version (0)
//   bytes 28–31: u32 length of additional Circle hook data (0 — none here)
//
// Stellar is NOT a documented forwarding source; this probes whether the relayer
// picks it up regardless. destination_caller is left ZERO (permissionless) so if
// the relayer ignores the burn, the mint can still be completed manually via
// receiveMessage (the demo's resume flow) — funds are never stranded.
export const CCTP_FORWARD_MAGIC = 'cctp-forward';

export function encodeCctpForwardHookData(): Uint8Array {
    // 32 bytes total: 24 magic + u32 version + u32 length, all-zero tail. Writing
    // the ascii magic at offset 0 leaves the magic padding, version, and length
    // fields at their zero defaults — exactly the documented "no extra data" form.
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode(CCTP_FORWARD_MAGIC), 0);
    return out;
}

export async function depositForBurnWithHookForwarded(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    destinationDomain: number;
    evmRecipient: `0x${string}`;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
    const account = await stellarRpc.getAccount(args.caller);

    const mintRecipient = leftPad32FromHex(args.evmRecipient);
    const destinationCaller = ZERO_BYTES_32;
    const hookData = encodeCctpForwardHookData();

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            tmm.call(
                'deposit_for_burn_with_hook',
                Address.fromString(args.caller).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(args.destinationDomain, { type: 'u32' }),
                bytesN32(mintRecipient),
                Address.fromString(STELLAR.contracts.usdc).toScVal(),
                bytesN32(destinationCaller),
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
                nativeToScVal(hookData, { type: 'bytes' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash, sourceDomain: STELLAR.domain };
}

// Inbound from EVM: mint_and_forward is permissionless (no caller arg).
// The user pays the Soroban fee but doesn't need to be the recipient.
export async function mintAndForward(args: {
    caller: string;
    message: Uint8Array;
    attestation: Uint8Array;
}): Promise<{ hash: string }> {
    const account = await stellarRpc.getAccount(args.caller);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            forwarder.call(
                'mint_and_forward',
                nativeToScVal(args.message, { type: 'bytes' }),
                nativeToScVal(args.attestation, { type: 'bytes' }),
            ),
        )
        .setTimeout(60)
        .build();

    const hash = await simulateSignAndSubmit(tx);
    return { hash };
}

function leftPad32FromHex(hex: `0x${string}`): Uint8Array {
    const clean = hex.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(clean) || clean.length > 64) {
        throw new Error(`Invalid hex address: ${hex}`);
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < clean.length / 2; i++) {
        bytes[32 - clean.length / 2 + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

const ZERO_BYTES_32 = new Uint8Array(32);

function bytesN32(bytes: Uint8Array): xdr.ScVal {
    if (bytes.length !== 32) throw new Error(`bytesN32 expects 32 bytes, got ${bytes.length}`);
    return nativeToScVal(bytes, { type: 'bytes' });
}
