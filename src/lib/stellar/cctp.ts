import {
    Address,
    BASE_FEE,
    Contract,
    TransactionBuilder,
    nativeToScVal,
    xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import {
    STELLAR,
    CCTP_CANONICAL_DECIMALS,
    FINALIZED_THRESHOLD,
    STELLAR_MAX_FEE,
} from '$lib/config';
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
                nativeToScVal(STELLAR_MAX_FEE, { type: 'i128' }),
                nativeToScVal(FINALIZED_THRESHOLD, { type: 'u32' }),
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
                nativeToScVal(STELLAR_MAX_FEE, { type: 'i128' }),
                nativeToScVal(FINALIZED_THRESHOLD, { type: 'u32' }),
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
    return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

// CCTP canonical amount uses 6 decimals; Stellar USDC stores 7. The contract
// truncates the 7th decimal on outbound. Surface that to the UI so users see
// what will actually arrive.
export function canonicalFromStellarAmount(stellar7: bigint): bigint {
    const scale = 10n ** BigInt(STELLAR.usdc.decimals - CCTP_CANONICAL_DECIMALS);
    return stellar7 / scale;
}

export function stellarAmountFromCanonical(canonical6: bigint): bigint {
    const scale = 10n ** BigInt(STELLAR.usdc.decimals - CCTP_CANONICAL_DECIMALS);
    return canonical6 * scale;
}
