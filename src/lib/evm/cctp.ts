import { concatHex, pad, stringToHex, toHex, type Hex } from 'viem';
import { StrKey } from '@stellar/stellar-sdk';
import {
    EVM_CCTP_CONTRACTS,
    EVM_CHAINS,
    FINALIZED_THRESHOLD,
    EVM_MAX_FEE,
    STELLAR,
    type EvmChainId,
} from '$lib/config';
import { getPublicClient } from './client';
import { signEvmUsdcPermit } from './usdc';
import type { EvmWallet } from './wallet';

// Minimal ABIs for the V2 contracts. Full ABIs are large and we only call
// these two methods.
export const tokenMessengerV2Abi = [
    {
        type: 'function',
        name: 'depositForBurnWithHook',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'amount', type: 'uint256' },
            { name: 'destinationDomain', type: 'uint32' },
            { name: 'mintRecipient', type: 'bytes32' },
            { name: 'burnToken', type: 'address' },
            { name: 'destinationCaller', type: 'bytes32' },
            { name: 'maxFee', type: 'uint256' },
            { name: 'minFinalityThreshold', type: 'uint32' },
            { name: 'hookData', type: 'bytes' },
        ],
        outputs: [],
    },
] as const;

// User-deployed wrapper (contracts-evm/cctp-wrapper). Bundles
// `usdc.permit` + `transferFrom` + `approve` + `depositForBurnWithHook`
// into one tx so the user signs an EIP-712 permit message and submits one
// transaction — analogous to the Soroban `approve_and_deposit` wrapper.
export const cctpWrapperAbi = [
    {
        type: 'function',
        name: 'bridgeWithPermit',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'amount', type: 'uint256' },
            { name: 'destinationDomain', type: 'uint32' },
            { name: 'mintRecipient', type: 'bytes32' },
            { name: 'destinationCaller', type: 'bytes32' },
            { name: 'maxFee', type: 'uint256' },
            { name: 'minFinalityThreshold', type: 'uint32' },
            { name: 'hookData', type: 'bytes' },
            { name: 'permitDeadline', type: 'uint256' },
            { name: 'permitV', type: 'uint8' },
            { name: 'permitR', type: 'bytes32' },
            { name: 'permitS', type: 'bytes32' },
        ],
        outputs: [],
    },
] as const;

export const messageTransmitterV2Abi = [
    {
        type: 'function',
        name: 'receiveMessage',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'message', type: 'bytes' },
            { name: 'attestation', type: 'bytes' },
        ],
        outputs: [{ type: 'bool' }],
    },
] as const;

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

// Convert a 32-char Stellar strkey contract or account into a 32-byte
// bytes32 for CCTP message fields. Both `mintRecipient` and
// `destinationCaller` need to be the *raw 32-byte Ed25519 pubkey*, NOT the
// strkey string itself.
export function strkeyToBytes32(strkey: string): Hex {
    const isContract = StrKey.isValidContract(strkey);
    const raw = isContract ? StrKey.decodeContract(strkey) : StrKey.decodeEd25519PublicKey(strkey);
    return toHex(raw);
}

export async function depositForBurnWithHookToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
}): Promise<`0x${string}`> {
    const cfg = EVM_CHAINS[args.chainId];
    const forwarderBytes32 = strkeyToBytes32(STELLAR.contracts.cctpForwarder);
    const hookData = encodeStellarForwarderHookData(args.stellarRecipient);

    const hash = await args.wallet.walletClient.writeContract({
        account: args.wallet.address,
        chain: cfg.chain,
        address: EVM_CCTP_CONTRACTS.tokenMessengerV2,
        abi: tokenMessengerV2Abi,
        functionName: 'depositForBurnWithHook',
        args: [
            args.amount,
            STELLAR.domain,
            forwarderBytes32,
            cfg.usdc,
            forwarderBytes32, // destinationCaller MUST equal mintRecipient (the forwarder)
            EVM_MAX_FEE,
            FINALIZED_THRESHOLD,
            hookData,
        ],
    });
    await getPublicClient(args.chainId).waitForTransactionReceipt({ hash });
    return hash;
}

// One-signature, one-tx variant of depositForBurnWithHookToStellar.
// Throws if the chain config has no `bridgeWrapper` address — i.e. the
// wrapper hasn't been deployed yet for this chain.
export async function bridgeWithPermitToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
}): Promise<`0x${string}`> {
    const cfg = EVM_CHAINS[args.chainId];
    if (!cfg.bridgeWrapper) {
        throw new Error(
            `No CctpWrapper deployed for ${cfg.label}. Deploy contracts-evm/cctp-wrapper and set bridgeWrapper in config.`,
        );
    }
    const forwarderBytes32 = strkeyToBytes32(STELLAR.contracts.cctpForwarder);
    const hookData = encodeStellarForwarderHookData(args.stellarRecipient);

    const permit = await signEvmUsdcPermit({
        chainId: args.chainId,
        wallet: args.wallet,
        spender: cfg.bridgeWrapper,
        value: args.amount,
    });

    const hash = await args.wallet.walletClient.writeContract({
        account: args.wallet.address,
        chain: cfg.chain,
        address: cfg.bridgeWrapper,
        abi: cctpWrapperAbi,
        functionName: 'bridgeWithPermit',
        args: [
            args.amount,
            STELLAR.domain,
            forwarderBytes32,
            forwarderBytes32, // destinationCaller MUST equal mintRecipient (the forwarder)
            EVM_MAX_FEE,
            FINALIZED_THRESHOLD,
            hookData,
            permit.deadline,
            permit.v,
            permit.r,
            permit.s,
        ],
    });
    await getPublicClient(args.chainId).waitForTransactionReceipt({ hash });
    return hash;
}

export async function receiveMessageOnEvm(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    message: Hex;
    attestation: Hex;
}): Promise<`0x${string}`> {
    const cfg = EVM_CHAINS[args.chainId];
    const hash = await args.wallet.walletClient.writeContract({
        account: args.wallet.address,
        chain: cfg.chain,
        address: EVM_CCTP_CONTRACTS.messageTransmitterV2,
        abi: messageTransmitterV2Abi,
        functionName: 'receiveMessage',
        args: [args.message, args.attestation],
    });
    await getPublicClient(args.chainId).waitForTransactionReceipt({ hash });
    return hash;
}
