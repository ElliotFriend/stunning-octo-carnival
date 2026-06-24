import { hexToBytes, type Hex } from 'viem';
import {
    EVM_CCTP_CONTRACTS,
    EVM_CHAINS,
    STELLAR,
    STELLAR_MAX_FEE,
    EVM_MAX_FEE,
    type Direction,
    type EvmChainId,
    type InboundFlow,
    type OutboundFlow,
    type TransferSpeed,
} from '$lib/config';
import { fetchBurnFee, feeBpsFor, thresholdFor, computeMaxFee } from '$lib/circle/fees';
import { bridgeUsdcToEvm, depositForBurnToEvm, mintAndForward } from '$lib/stellar/cctp';
import { approveUsdc, getUsdcAllowance, parseUsdcStellar } from '$lib/stellar/usdc';
import { approveEvmUsdc, getEvmUsdcAllowance, parseEvmUsdc } from '$lib/evm/usdc';
import {
    bridgeWithPermitToStellar,
    depositForBurnWithHookToStellar,
    receiveMessageOnEvm,
    sendCallsBridgeToStellar,
} from '$lib/evm/cctp';
import { pollAttestation, type IrisMessage } from '$lib/circle/iris';
import type { EvmWallet } from '$lib/evm/wallet';

export type Phase = 'idle' | 'approving' | 'burning' | 'attesting' | 'minting' | 'done' | 'error';

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

export type Step = {
    key: 'approve' | 'burn' | 'attest' | 'mint';
    label: string;
    status: StepStatus;
    hash?: string;
    hashUrl?: string;
    detail?: string;
    startedAt?: number;
    endedAt?: number;
};

export type TransferState = {
    direction: Direction;
    evmChainId: EvmChainId;
    outboundFlow: OutboundFlow;
    inboundFlow: InboundFlow;
    phase: Phase;
    amount: string;
    steps: Step[];
    error: string | null;
    attestation: IrisMessage | null;
};

const initialState = (
    direction: Direction,
    evmChainId: EvmChainId,
    outboundFlow: OutboundFlow,
    inboundFlow: InboundFlow,
): TransferState => ({
    direction,
    evmChainId,
    outboundFlow,
    inboundFlow,
    phase: 'idle',
    amount: '',
    steps: stepsFor(direction, evmChainId, outboundFlow, inboundFlow),
    error: null,
    attestation: null,
});

function stepsFor(
    direction: Direction,
    evmChainId: EvmChainId,
    outboundFlow: OutboundFlow,
    inboundFlow: InboundFlow,
): Step[] {
    const evmLabel = EVM_CHAINS[evmChainId].label;
    if (direction === 'stellar-to-evm') {
        if (outboundFlow === 'wrapper') {
            return [
                {
                    key: 'burn',
                    label: 'Approve + burn USDC on Stellar (one tx)',
                    status: 'pending',
                },
                { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
                { key: 'mint', label: `Mint USDC on ${evmLabel}`, status: 'pending' },
            ];
        }
        return [
            { key: 'approve', label: 'Approve TokenMessenger on Stellar', status: 'pending' },
            { key: 'burn', label: 'Burn USDC on Stellar', status: 'pending' },
            { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
            { key: 'mint', label: `Mint USDC on ${evmLabel}`, status: 'pending' },
        ];
    }
    if (inboundFlow === 'wrapper') {
        return [
            {
                key: 'burn',
                label: `Permit + burn USDC on ${evmLabel} (one tx)`,
                status: 'pending',
            },
            { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
            { key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' },
        ];
    }
    if (inboundFlow === 'send-calls') {
        return [
            {
                key: 'burn',
                label: `Approve + burn USDC on ${evmLabel} (batched by wallet)`,
                status: 'pending',
            },
            { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
            { key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' },
        ];
    }
    return [
        { key: 'approve', label: `Approve USDC on ${evmLabel}`, status: 'pending' },
        { key: 'burn', label: `Burn USDC on ${evmLabel}`, status: 'pending' },
        { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
        { key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' },
    ];
}

const stellarTxUrl = (hash: string) => `${STELLAR.explorer}/tx/${hash}`;
const evmTxUrl = (chainId: EvmChainId, hash: string) =>
    `${EVM_CHAINS[chainId].explorer}/tx/${hash}`;

export function createTransferStore(
    initialDirection: Direction,
    initialEvmChain: EvmChainId,
    initialOutbound: OutboundFlow,
    initialInbound: InboundFlow,
) {
    let state = $state<TransferState>(
        initialState(initialDirection, initialEvmChain, initialOutbound, initialInbound),
    );

    function reset() {
        state = initialState(
            state.direction,
            state.evmChainId,
            state.outboundFlow,
            state.inboundFlow,
        );
    }

    function patchStep(key: Step['key'], patch: Partial<Step>) {
        state.steps = state.steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
    }

    function fail(message: string) {
        state.phase = 'error';
        state.error = message;
        state.steps = state.steps.map((s) =>
            s.status === 'active' ? { ...s, status: 'error', endedAt: Date.now() } : s,
        );
    }

    // Generic wrapper around a single step in the runner. Owns the active/done
    // status transitions and error funnel so the per-direction sequence below
    // is just a list of `await performStep(...)` calls. Returns null on
    // failure — callers bail out of the runner immediately when that happens.
    async function performStep<T>(
        phase: Phase,
        key: Step['key'],
        op: () => Promise<{ result: T; patch?: Partial<Step> }>,
    ): Promise<T | null> {
        state.phase = phase;
        patchStep(key, { status: 'active', startedAt: Date.now() });
        try {
            const { result, patch } = await op();
            patchStep(key, { status: 'done', endedAt: Date.now(), ...patch });
            return result;
        } catch (err) {
            fail(errMsg(err));
            return null;
        }
    }

    async function runStellarToEvm(args: {
        stellarAddress: string;
        evmWallet: EvmWallet;
        evmChainId: EvmChainId;
        outboundFlow: OutboundFlow;
        amount: string;
        speed: TransferSpeed;
    }) {
        state.amount = args.amount;
        const stellarAmount = parseUsdcStellar(args.amount);
        const evmCfg = EVM_CHAINS[args.evmChainId];
        const feeRows = await fetchBurnFee(STELLAR.domain, evmCfg.domain);
        const maxFee = computeMaxFee(
            stellarAmount,
            feeBpsFor(feeRows, args.speed),
            STELLAR_MAX_FEE,
        );
        const finalityThreshold = thresholdFor(args.speed);

        let burnHash: string;
        if (args.outboundFlow === 'wrapper') {
            // Approve + burn in one Soroban transaction via the wrapper contract.
            // Soroban's auth tree authorizes both inner calls from a single
            // Freighter signature.
            const h = await performStep('burning', 'burn', async () => {
                const r = await bridgeUsdcToEvm({
                    caller: args.stellarAddress,
                    amount: stellarAmount,
                    destinationDomain: evmCfg.domain,
                    evmRecipient: args.evmWallet.address,
                    maxFee,
                    finalityThreshold,
                });
                return {
                    result: r.hash,
                    patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) },
                };
            });
            if (h === null) return;
            burnHash = h;
        } else {
            // Plain CCTP: approve, then deposit_for_burn. Two Freighter prompts,
            // two on-chain Soroban transactions.
            const approved = await performStep('approving', 'approve', async () => {
                const existing = await getUsdcAllowance({
                    from: args.stellarAddress,
                    spender: STELLAR.contracts.tokenMessengerMinter,
                });
                if (existing >= stellarAmount) {
                    return {
                        result: true,
                        patch: { detail: 'sufficient allowance already set' },
                    };
                }
                const hash = await approveUsdc({
                    from: args.stellarAddress,
                    spender: STELLAR.contracts.tokenMessengerMinter,
                    amount: stellarAmount,
                });
                return {
                    result: true,
                    patch: { hash, hashUrl: stellarTxUrl(hash), detail: 'allowance set' },
                };
            });
            if (approved === null) return;

            const h = await performStep('burning', 'burn', async () => {
                const r = await depositForBurnToEvm({
                    caller: args.stellarAddress,
                    amount: stellarAmount,
                    destinationDomain: evmCfg.domain,
                    evmRecipient: args.evmWallet.address,
                    maxFee,
                    finalityThreshold,
                });
                return {
                    result: r.hash,
                    patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) },
                };
            });
            if (h === null) return;
            burnHash = h;
        }

        const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
            const r = await pollAttestation(STELLAR.domain, burnHash, {
                onProgress: ({ elapsedMs, status }) => {
                    patchStep('attest', {
                        detail: `${Math.round(elapsedMs / 1000)}s · ${status}`,
                    });
                },
            });
            return { result: r, patch: { detail: 'attested' } };
        });
        if (attest === null) return;
        state.attestation = attest;

        const mintHash = await performStep('minting', 'mint', async () => {
            const hash = await receiveMessageOnEvm({
                chainId: args.evmChainId,
                wallet: args.evmWallet,
                message: attest.message,
                attestation: attest.attestation,
            });
            return {
                result: hash,
                patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) },
            };
        });
        if (mintHash === null) return;

        state.phase = 'done';
    }

    async function runEvmToStellar(args: {
        stellarAddress: string;
        evmWallet: EvmWallet;
        evmChainId: EvmChainId;
        inboundFlow: InboundFlow;
        amount: string;
        speed: TransferSpeed;
    }) {
        state.amount = args.amount;
        const evmAmount = parseEvmUsdc(args.evmChainId, args.amount);
        const evmCfg = EVM_CHAINS[args.evmChainId];
        const feeRows = await fetchBurnFee(evmCfg.domain, STELLAR.domain);
        const maxFee = computeMaxFee(evmAmount, feeBpsFor(feeRows, args.speed), EVM_MAX_FEE);
        const finalityThreshold = thresholdFor(args.speed);

        let burnHash: string;
        if (args.inboundFlow === 'wrapper') {
            // EIP-2612 permit + transferFrom + approve + depositForBurnWithHook
            // bundled into one tx by the CctpWrapper. User signs a typed-data
            // permit and then submits a single transaction — no separate approve.
            const h = await performStep('burning', 'burn', async () => {
                const hash = await bridgeWithPermitToStellar({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    amount: evmAmount,
                    stellarRecipient: args.stellarAddress,
                    maxFee,
                    finalityThreshold,
                });
                return {
                    result: hash,
                    patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) },
                };
            });
            if (h === null) return;
            burnHash = h;
        } else if (args.inboundFlow === 'send-calls') {
            // EIP-5792: the WALLET bundles approve + depositForBurnWithHook
            // behind one user confirmation. On smart-wallets / EIP-7702 EOAs
            // this is one atomic tx; on plain EOAs the wallet still presents
            // one prompt but submits two txs sequentially.
            const h = await performStep('burning', 'burn', async () => {
                const hash = await sendCallsBridgeToStellar({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    amount: evmAmount,
                    stellarRecipient: args.stellarAddress,
                    maxFee,
                    finalityThreshold,
                });
                return {
                    result: hash,
                    patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) },
                };
            });
            if (h === null) return;
            burnHash = h;
        } else {
            const approved = await performStep('approving', 'approve', async () => {
                const allowance = await getEvmUsdcAllowance(
                    args.evmChainId,
                    args.evmWallet.address,
                    EVM_CCTP_CONTRACTS.tokenMessengerV2,
                );
                if (allowance >= evmAmount) {
                    return {
                        result: true,
                        patch: { detail: 'sufficient allowance already set' },
                    };
                }
                const hash = await approveEvmUsdc({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    spender: EVM_CCTP_CONTRACTS.tokenMessengerV2,
                    amount: evmAmount,
                });
                return {
                    result: true,
                    patch: {
                        hash,
                        hashUrl: evmTxUrl(args.evmChainId, hash),
                        detail: 'allowance set',
                    },
                };
            });
            if (approved === null) return;

            const h = await performStep('burning', 'burn', async () => {
                const hash = await depositForBurnWithHookToStellar({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    amount: evmAmount,
                    stellarRecipient: args.stellarAddress,
                    maxFee,
                    finalityThreshold,
                });
                return {
                    result: hash,
                    patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) },
                };
            });
            if (h === null) return;
            burnHash = h;
        }

        const finalityNote = finalityHint(args.evmChainId);
        patchStep('attest', { detail: finalityNote });
        const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
            const r = await pollAttestation(evmCfg.domain, burnHash, {
                onProgress: ({ elapsedMs, status }) => {
                    patchStep('attest', {
                        detail: `${Math.round(elapsedMs / 1000)}s · ${status}`,
                    });
                },
            });
            return { result: r, patch: { detail: 'attested' } };
        });
        if (attest === null) return;
        state.attestation = attest;

        const mintHash = await performStep('minting', 'mint', async () => {
            const r = await mintAndForward({
                caller: args.stellarAddress,
                message: hexToBytes(attest.message as Hex),
                attestation: hexToBytes(attest.attestation as Hex),
            });
            return {
                result: r.hash,
                patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) },
            };
        });
        if (mintHash === null) return;

        state.phase = 'done';
    }

    async function start(args: {
        direction: Direction;
        stellarAddress: string;
        evmWallet: EvmWallet;
        evmChainId: EvmChainId;
        outboundFlow: OutboundFlow;
        inboundFlow: InboundFlow;
        amount: string;
        speed: TransferSpeed;
    }) {
        state.direction = args.direction;
        state.evmChainId = args.evmChainId;
        state.outboundFlow = args.outboundFlow;
        state.inboundFlow = args.inboundFlow;
        state.steps = stepsFor(
            args.direction,
            args.evmChainId,
            args.outboundFlow,
            args.inboundFlow,
        );
        state.error = null;
        state.amount = '';
        state.attestation = null;
        if (args.direction === 'stellar-to-evm') {
            await runStellarToEvm(args);
        } else {
            await runEvmToStellar(args);
        }
    }

    // Pick up an interrupted (or third-party) transfer at the attest step.
    // Which flow originally produced the burn is irrelevant here — we're
    // skipping straight to attest + mint — so we render the two-tx step
    // list with approve + burn pre-marked done, regardless of whether the
    // original transfer used the wrapper, permit, or send-calls path.
    async function resume(args: {
        burnHash: string;
        direction: Direction;
        stellarAddress: string;
        evmWallet: EvmWallet;
        evmChainId: EvmChainId;
    }) {
        state.direction = args.direction;
        state.evmChainId = args.evmChainId;
        state.outboundFlow = 'two-tx';
        state.inboundFlow = 'two-tx';
        state.error = null;
        state.attestation = null;
        state.amount = '';

        const stellarSource = args.direction === 'stellar-to-evm';
        const burnHashUrl = stellarSource
            ? stellarTxUrl(args.burnHash)
            : evmTxUrl(args.evmChainId, args.burnHash);

        state.steps = stepsFor(args.direction, args.evmChainId, 'two-tx', 'two-tx').map((s) => {
            if (s.key === 'approve') {
                return { ...s, status: 'done', detail: 'skipped (resumed)' };
            }
            if (s.key === 'burn') {
                return {
                    ...s,
                    status: 'done',
                    detail: 'skipped (resumed)',
                    hash: args.burnHash,
                    hashUrl: burnHashUrl,
                };
            }
            return s;
        });

        const sourceDomain = stellarSource ? STELLAR.domain : EVM_CHAINS[args.evmChainId].domain;

        const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
            const r = await pollAttestation(sourceDomain, args.burnHash, {
                onProgress: ({ elapsedMs, status }) => {
                    patchStep('attest', {
                        detail: `${Math.round(elapsedMs / 1000)}s · ${status}`,
                    });
                },
            });
            return { result: r, patch: { detail: 'attested' } };
        });
        if (attest === null) return;
        state.attestation = attest;

        const mintHash = await performStep('minting', 'mint', async () => {
            if (stellarSource) {
                const hash = await receiveMessageOnEvm({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    message: attest.message,
                    attestation: attest.attestation,
                });
                return {
                    result: hash,
                    patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) },
                };
            }
            const r = await mintAndForward({
                caller: args.stellarAddress,
                message: hexToBytes(attest.message as Hex),
                attestation: hexToBytes(attest.attestation as Hex),
            });
            return {
                result: r.hash,
                patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) },
            };
        });
        if (mintHash === null) return;

        state.phase = 'done';
    }

    return {
        get state() {
            return state;
        },
        reset,
        start,
        resume,
    };
}

function finalityHint(chainId: EvmChainId): string {
    const cfg = EVM_CHAINS[chainId];
    if (!cfg.attestationEtaMs) {
        return `${cfg.label} finality is fast — typically under a minute.`;
    }
    const minutes = Math.round(cfg.attestationEtaMs / 60_000);
    return `${cfg.label} finality is ~${minutes} min for Standard transfers.`;
}

function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err);
}
