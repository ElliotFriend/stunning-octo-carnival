import { concatHex, encodeFunctionData, erc20Abi, pad, stringToHex, toHex, type Hex } from 'viem';
import { StrKey } from '@stellar/stellar-sdk';
import { EVM_CCTP_CONTRACTS, EVM_CHAINS, STELLAR, type EvmChainId } from '$lib/config';
import { getPublicClient } from './client';
import { signEvmUsdcPermit } from './usdc';
import type { EvmWallet } from './wallet';

// ─────────────────────────────────────────────────────────────────────
//  EVM → Stellar via CCTP V2
// ─────────────────────────────────────────────────────────────────────
//
// CCTP V2 burns USDC on the source EVM chain and emits a signed message
// Circle attests. The destination calls `receiveMessage` to mint fresh
// USDC. For Stellar this can't deliver directly to a G-address — CCTP
// messages address a 32-byte slot and there's no way to tell a G-account
// from a C-contract on the wire. So the flow is:
//
//   burn on EVM  ──►  Circle attests  ──►  mint on Stellar via CctpForwarder
//
// **Invariant (critical):** `mintRecipient === destinationCaller ===
// CctpForwarder.address` (left-padded to 32 bytes). The forwarder is the
// only address authorized to call `mint_and_forward`, and the G-recipient
// is encoded into `hookData`. Anything else permanently bricks the funds.
//
// This module exposes three flows for the burn side, plus the inverse
// `receiveMessage` call for the Stellar → EVM direction:
//
//   1. depositForBurnWithHookToStellar   2 user txs (approve + burn)
//   2. bridgeWithPermitToStellar         1 signature + 1 tx via CctpWrapper
//   3. sendCallsBridgeToStellar          1 wallet confirmation via EIP-5792
//
// All three end up calling `TokenMessengerV2.depositForBurnWithHook` with
// the same 8-arg payload — they differ only in who submits the tx and
// whether the approve is bundled into the same on-chain action.

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

// User-deployed wrapper (contracts/evm/cctp-wrapper). Bundles
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

// Convert a Stellar strkey contract or account into a 32-byte bytes32 for
// CCTP message fields. Both `mintRecipient` and `destinationCaller` need
// to be the *raw 32-byte Ed25519 pubkey*, NOT the strkey string itself.
export function strkeyToBytes32(strkey: string): Hex {
    const isContract = StrKey.isValidContract(strkey);
    const raw = isContract ? StrKey.decodeContract(strkey) : StrKey.decodeEd25519PublicKey(strkey);
    return toHex(raw);
}

// Shared shape used by all three burn flows. The 8-arg tuple matches
// `TokenMessengerV2.depositForBurnWithHook` exactly; the CctpWrapper drops
// `burnToken` from its own ABI because it knows its USDC, but on the wire
// the underlying call still uses this same payload.
function buildBurnToStellar(
    chainId: EvmChainId,
    amount: bigint,
    stellarRecipient: string,
    maxFee: bigint,
    finalityThreshold: number,
) {
    const cfg = EVM_CHAINS[chainId];
    const forwarderBytes32 = strkeyToBytes32(STELLAR.contracts.cctpForwarder);
    const hookData = encodeStellarForwarderHookData(stellarRecipient);
    const burnArgs = [
        amount, //                  amount
        STELLAR.domain, //          destinationDomain (Stellar's CCTP domain)
        forwarderBytes32, //        mintRecipient (the forwarder — see invariant)
        cfg.usdc, //                burnToken (per-chain USDC address)
        forwarderBytes32, //        destinationCaller (MUST equal mintRecipient)
        maxFee, //                  maxFee
        finalityThreshold, //       minFinalityThreshold
        hookData, //                hookData (G-address routing payload)
    ] as const;
    return { cfg, forwarderBytes32, hookData, burnArgs };
}

// Flow 1 — direct: caller pre-approves TokenMessengerV2 as a USDC spender
// (in a separate tx, handled by the store), then this fn submits the burn.
// Two on-chain transactions total.
//
// Wire call:  TokenMessengerV2.depositForBurnWithHook(...burnArgs)
//
// Returns the burn tx hash for Iris polling.
export async function depositForBurnWithHookToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, burnArgs } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );
    const hash = await args.wallet.walletClient.writeContract({
        account: args.wallet.address,
        chain: cfg.chain,
        address: EVM_CCTP_CONTRACTS.tokenMessengerV2,
        abi: tokenMessengerV2Abi,
        functionName: 'depositForBurnWithHook',
        args: burnArgs,
    });
    await getPublicClient(args.chainId).waitForTransactionReceipt({ hash });
    return hash;
}

// Flow 2 — wrapper + permit: one EIP-712 signature (no on-chain tx) + one
// transaction. The wrapper calls `usdc.permit → transferFrom → approve →
// depositForBurnWithHook` atomically. Falls back with a clear error if no
// CctpWrapper has been deployed for this chain (see config.ts).
//
// Wire call:  CctpWrapper.bridgeWithPermit(
//   amount, destinationDomain, mintRecipient, destinationCaller, maxFee,
//   minFinalityThreshold, hookData, permitDeadline, permitV, permitR, permitS
// )
//
// Note: the wrapper's argument list omits `burnToken` — it's an immutable
// stored on the contract. On the underlying TokenMessengerV2 call burnToken
// is still passed (= cfg.usdc), matching the standard 8-arg payload.
//
// Returns the burn tx hash for Iris polling.
export async function bridgeWithPermitToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, forwarderBytes32, hookData } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );
    if (!cfg.bridgeWrapper) {
        throw new Error(
            `No CctpWrapper deployed for ${cfg.label}. Deploy contracts/evm/cctp-wrapper and set bridgeWrapper in config.`,
        );
    }

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
            forwarderBytes32,
            args.maxFee,
            args.finalityThreshold,
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

// Flow 3 — EIP-5792 wallet_sendCalls: the WALLET bundles approve +
// depositForBurnWithHook into a single user confirmation. On EIP-7702 EOAs
// or smart wallets this executes atomically in one transaction; on plain
// EOAs the wallet still presents one prompt but submits the two txs
// sequentially. Capability is detected per (wallet, chain) — see
// `src/lib/evm/capabilities.ts`.
//
// Wire calls (bundled by the wallet):
//   1. USDC.approve(TokenMessengerV2, amount)
//   2. TokenMessengerV2.depositForBurnWithHook(...burnArgs)
//
// Returns the burn tx hash — the LAST receipt in the bundle, which is
// always the depositForBurnWithHook regardless of atomicity.
export async function sendCallsBridgeToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, burnArgs } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );

    const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [EVM_CCTP_CONTRACTS.tokenMessengerV2, args.amount],
    });
    const burnData = encodeFunctionData({
        abi: tokenMessengerV2Abi,
        functionName: 'depositForBurnWithHook',
        args: burnArgs,
    });

    const { id } = await args.wallet.walletClient.sendCalls({
        account: args.wallet.address,
        chain: cfg.chain,
        calls: [
            { to: cfg.usdc, data: approveData },
            { to: EVM_CCTP_CONTRACTS.tokenMessengerV2, data: burnData },
        ],
    });

    const status = await args.wallet.walletClient.waitForCallsStatus({ id });
    if (status.status !== 'success') {
        throw new Error(`wallet_sendCalls did not confirm (status: ${status.status})`);
    }
    // Atomic batches return one receipt covering both calls; sequential
    // batches return one per call. The burn is always the last receipt.
    const receipts = status.receipts ?? [];
    const burn = receipts[receipts.length - 1];
    if (!burn?.transactionHash) {
        throw new Error('No burn receipt returned from wallet_sendCalls');
    }
    return burn.transactionHash;
}

// Inverse direction (Stellar → EVM): after Circle attests, anyone can
// submit the message + signature to MessageTransmitterV2 and mint USDC
// to the embedded recipient. `receiveMessage` is permissionless when
// the burn's `destinationCaller` was set to zero (our convention for
// outbound transfers from Stellar — see stellar/cctp.ts).
//
// Wire call:  MessageTransmitterV2.receiveMessage(message, attestation)
//
// Returns the mint tx hash.
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
