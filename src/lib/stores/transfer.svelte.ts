import { hexToBytes, type Hex } from 'viem';
import {
    EVM_CCTP_CONTRACTS,
    EVM_CHAINS,
    SOLANA,
    SOLANA_MAX_FEE,
    STELLAR,
    STELLAR_MAX_FEE,
    EVM_MAX_FEE,
    type Direction,
    type EvmChainId,
    type InboundFlow,
    type OutboundFlow,
    type TransferSpeed,
} from '$lib/config';
import { burnUsdcToStellar } from '$lib/solana/cctp';
import { getUsdcBalance as getSolanaUsdcBalance, parseUsdcSolana } from '$lib/solana/usdc';
import type { SolanaWallet } from '$lib/solana/wallet';
import {
    fetchBurnFee,
    feeBpsFor,
    thresholdFor,
    computeMaxFee,
    fetchForwardFee,
    forwardedMaxFeeStellar,
} from '$lib/circle/fees';
import {
    bridgeUsdcToEvm,
    bridgeUsdcToEvmWithHook,
    depositForBurnToEvm,
    depositForBurnToSolana,
    depositForBurnWithHookForwarded,
    leftPad32FromHex,
    mintAndForward,
} from '$lib/stellar/cctp';
import { solanaAtaToBytes32 } from '$lib/stellar/recipient';
import { receiveMessageOnSolana } from '$lib/solana/mint';
import { approveUsdc, getUsdcAllowance, parseUsdcStellar } from '$lib/stellar/usdc';
import {
    approveEvmUsdc,
    getEvmUsdcAllowance,
    getEvmUsdcBalance,
    parseEvmUsdc,
} from '$lib/evm/usdc';
import { sleep } from '$lib/utils';
import {
    bridgeWithPermitToStellar,
    depositForBurnWithHookToStellar,
    receiveMessageOnEvm,
    sendCallsBridgeToStellar,
} from '$lib/evm/cctp';
import { pollAttestation, fetchAttestation, type IrisMessage } from '$lib/circle/iris';
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
    // Undefined for Solana transfers, which carry no EVM chain.
    evmChainId?: EvmChainId;
    outboundFlow: OutboundFlow;
    forwarding: boolean;
    inboundFlow: InboundFlow;
    phase: Phase;
    amount: string;
    steps: Step[];
    error: string | null;
    attestation: IrisMessage | null;
};

const initialState = (
    direction: Direction,
    evmChainId: EvmChainId | undefined,
    outboundFlow: OutboundFlow,
    forwarding: boolean,
    inboundFlow: InboundFlow,
): TransferState => ({
    direction,
    evmChainId,
    outboundFlow,
    forwarding,
    inboundFlow,
    phase: 'idle',
    amount: '',
    steps: stepsFor(direction, evmChainId, outboundFlow, forwarding, inboundFlow),
    error: null,
    attestation: null,
});

function stepsFor(
    direction: Direction,
    evmChainId: EvmChainId | undefined,
    outboundFlow: OutboundFlow,
    forwarding: boolean,
    inboundFlow: InboundFlow,
): Step[] {
    // Only the EVM branches below reference this; the Solana branches return
    // first, so it's fine that it's empty when evmChainId is undefined.
    const evmLabel = evmChainId ? EVM_CHAINS[evmChainId].label : '';
    if (direction === 'stellar-to-evm') {
        // The wrapper shape bundles approve + burn into one tx (no separate
        // approve step); the forwarding toggle only changes the burn/mint labels.
        const burnLabel =
            outboundFlow === 'wrapper'
                ? `Approve + burn USDC on Stellar (one tx${forwarding ? ', forwarding hook' : ''})`
                : `Burn USDC on Stellar${forwarding ? ' (forwarding hook)' : ''}`;
        const mintStep: Step = forwarding
            ? { key: 'mint', label: `Await Circle relayer mint on ${evmLabel}`, status: 'pending' }
            : { key: 'mint', label: `Mint USDC on ${evmLabel}`, status: 'pending' };
        const steps: Step[] = [];
        if (outboundFlow !== 'wrapper') {
            steps.push({
                key: 'approve',
                label: 'Approve TokenMessenger on Stellar',
                status: 'pending',
            });
        }
        steps.push({ key: 'burn', label: burnLabel, status: 'pending' });
        steps.push({ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' });
        steps.push(mintStep);
        return steps;
    }
    if (direction === 'solana-to-stellar') {
        // No approve step: Solana deposit_for_burn burns under the owner's
        // signature via CPI. Mints on Stellar through the forwarder.
        return [
            { key: 'burn', label: 'Burn USDC on Solana', status: 'pending' },
            { key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
            { key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' },
        ];
    }
    if (direction === 'stellar-to-solana') {
        const burnLabel =
            outboundFlow === 'wrapper'
                ? `Approve + burn USDC on Stellar (one tx${forwarding ? ', forwarding hook' : ''})`
                : `Burn USDC on Stellar${forwarding ? ' (forwarding hook)' : ''}`;
        const steps: Step[] = [];
        if (outboundFlow !== 'wrapper') {
            steps.push({
                key: 'approve',
                label: 'Approve TokenMessenger on Stellar',
                status: 'pending',
            });
        }
        steps.push({ key: 'burn', label: burnLabel, status: 'pending' });
        steps.push({ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' });
        steps.push({
            key: 'mint',
            label: forwarding ? 'Await Circle relayer mint on Solana' : 'Mint USDC on Solana',
            status: 'pending',
        });
        return steps;
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
    initialForwarding: boolean,
    initialInbound: InboundFlow,
) {
    let state = $state<TransferState>(
        initialState(
            initialDirection,
            initialEvmChain,
            initialOutbound,
            initialForwarding,
            initialInbound,
        ),
    );

    function reset() {
        state = initialState(
            state.direction,
            state.evmChainId,
            state.outboundFlow,
            state.forwarding,
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
        forwarding: boolean;
        amount: string;
        speed: TransferSpeed;
    }) {
        state.amount = args.amount;
        const stellarAmount = parseUsdcStellar(args.amount);
        const evmCfg = EVM_CHAINS[args.evmChainId];

        // EXPERIMENTAL forwarding path — burn with the Circle forwarding hookData
        // (via the wrapper or two-tx shape), then *observe* whether Circle's
        // relayer mints on the EVM side (no user receiveMessage). Isolated as an
        // early return to keep the standard wrapper/two-tx flow untouched.
        if (args.forwarding) {
            await runStellarToEvmForwarded(args, stellarAmount, evmCfg);
            return;
        }

        // Fetches burn-fee params. Called as the first line inside each burn
        // performStep so any network/parse failure is caught by performStep → fail().
        async function burnParams() {
            const feeRows = await fetchBurnFee(STELLAR.domain, evmCfg.domain);
            return {
                maxFee: computeMaxFee(
                    stellarAmount,
                    feeBpsFor(feeRows, args.speed),
                    STELLAR_MAX_FEE,
                ),
                finalityThreshold: thresholdFor(args.speed),
            };
        }

        let burnHash: string;
        if (args.outboundFlow === 'wrapper') {
            // Approve + burn in one Soroban transaction via the wrapper contract.
            // Soroban's auth tree authorizes both inner calls from a single
            // Freighter signature.
            const h = await performStep('burning', 'burn', async () => {
                const { maxFee, finalityThreshold } = await burnParams();
                const r = await bridgeUsdcToEvm({
                    caller: args.stellarAddress,
                    amount: stellarAmount,
                    destinationDomain: evmCfg.domain,
                    mintRecipient: leftPad32FromHex(args.evmWallet.address),
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
                const { maxFee, finalityThreshold } = await burnParams();
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

    // EXPERIMENTAL — Stellar→EVM burn that triggers Circle's Crosschain
    // Forwarding Service via hookData, then observes whether the relayer mints
    // on the EVM destination without the user submitting receiveMessage.
    async function runStellarToEvmForwarded(
        args: {
            stellarAddress: string;
            evmWallet: EvmWallet;
            evmChainId: EvmChainId;
            outboundFlow: OutboundFlow;
            speed: TransferSpeed;
        },
        stellarAmount: bigint,
        evmCfg: (typeof EVM_CHAINS)[EvmChainId],
    ) {
        // The wrapper shape bundles approve + burn into one Soroban tx via
        // approve_and_deposit_with_hook, so the separate approve step is only run
        // for the two-tx shape.
        const isWrapper = args.outboundFlow === 'wrapper';

        if (!isWrapper) {
            const approved = await performStep('approving', 'approve', async () => {
                const existing = await getUsdcAllowance({
                    from: args.stellarAddress,
                    spender: STELLAR.contracts.tokenMessengerMinter,
                });
                if (existing >= stellarAmount) {
                    return { result: true, patch: { detail: 'sufficient allowance already set' } };
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
        }

        // Recipient balance before the burn — the observe step watches for an
        // increase to detect a relayer-completed mint.
        let baseline: bigint;
        try {
            baseline = await getEvmUsdcBalance(args.evmChainId, args.evmWallet.address);
        } catch (err) {
            fail(errMsg(err));
            return;
        }

        const burnHash = await performStep('burning', 'burn', async () => {
            const rows = await fetchForwardFee(STELLAR.domain, evmCfg.domain);
            const maxFee = forwardedMaxFeeStellar(rows, args.speed, stellarAmount);
            const burnArgs = {
                caller: args.stellarAddress,
                amount: stellarAmount,
                destinationDomain: evmCfg.domain,
                mintRecipient: leftPad32FromHex(args.evmWallet.address),
                maxFee,
                finalityThreshold: thresholdFor(args.speed),
            };
            const r = isWrapper
                ? await bridgeUsdcToEvmWithHook(burnArgs)
                : await depositForBurnWithHookForwarded(burnArgs);
            return {
                result: r.hash,
                patch: {
                    hash: r.hash,
                    hashUrl: stellarTxUrl(r.hash),
                    detail: `forwarding hook · maxFee ${maxFee}`,
                },
            };
        });
        if (burnHash === null) return;

        const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
            const r = await pollAttestation(STELLAR.domain, burnHash, {
                onProgress: ({ elapsedMs, status }) => {
                    patchStep('attest', { detail: `${Math.round(elapsedMs / 1000)}s · ${status}` });
                },
            });
            return { result: r, patch: { detail: 'attested' } };
        });
        if (attest === null) return;
        state.attestation = attest;

        // OBSERVE: poll the recipient balance for a relayer-completed mint. If it
        // never lands, the burn is still attested and recoverable via the resume
        // flow (manual receiveMessage) — destination_caller was left zero.
        const minted = await performStep('minting', 'mint', async () => {
            const start = Date.now();
            const timeout = 3 * 60_000;
            while (Date.now() - start < timeout) {
                const bal = await getEvmUsdcBalance(args.evmChainId, args.evmWallet.address);
                if (bal > baseline) {
                    return {
                        result: bal,
                        patch: { detail: `relayer minted +${bal - baseline} (no user tx)` },
                    };
                }
                patchStep('mint', {
                    detail: `awaiting Circle relayer… ${Math.round((Date.now() - start) / 1000)}s`,
                });
                await sleep(5_000);
            }
            throw new Error(
                'Circle relayer did not mint within 3 min — burn is attested and funds are recoverable: use the resume flow with the burn hash to mint manually.',
            );
        });
        if (minted === null) return;

        // Refresh the Iris message now that the relayer has minted — forwardState
        // and forwardTxHash populate after the forward completes, not at
        // attestation time, so the CCTP message display would otherwise omit them.
        // Non-fatal: the mint already succeeded, so keep the earlier message on any
        // error.
        try {
            const finalMsg = await fetchAttestation(STELLAR.domain, burnHash);
            if (finalMsg) state.attestation = finalMsg;
        } catch {
            // ignore — display keeps the attestation-time message
        }

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

        // Fetches burn-fee params. Called as the first line inside each burn
        // performStep so any network/parse failure is caught by performStep → fail().
        async function burnParams() {
            const feeRows = await fetchBurnFee(evmCfg.domain, STELLAR.domain);
            return {
                maxFee: computeMaxFee(evmAmount, feeBpsFor(feeRows, args.speed), EVM_MAX_FEE),
                finalityThreshold: thresholdFor(args.speed),
            };
        }

        let burnHash: string;
        if (args.inboundFlow === 'wrapper') {
            // EIP-2612 permit + transferFrom + approve + depositForBurnWithHook
            // bundled into one tx by the CctpWrapper. User signs a typed-data
            // permit and then submits a single transaction — no separate approve.
            const h = await performStep('burning', 'burn', async () => {
                const { maxFee, finalityThreshold } = await burnParams();
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
                const { maxFee, finalityThreshold } = await burnParams();
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
                const { maxFee, finalityThreshold } = await burnParams();
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

    // Solana → Stellar. Mirrors runEvmToStellar minus the approve step: Solana
    // deposit_for_burn burns under the owner's signature in one tx, then Circle
    // attests and the forwarder mints on Stellar. stellarAddress signs/pays the
    // Stellar mint; stellarRecipient is the G-address carried in the burn hook.
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
                    patchStep('attest', {
                        detail: `${Math.round(elapsedMs / 1000)}s — ${status}`,
                    });
                },
            });
            return { result: msg };
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

    // Stellar → Solana. Mirrors runStellarToEvm (approve → burn → attest →
    // mint) but the mint completes on Solana via receiveMessage. solanaWallet
    // is the destination: its USDC ATA is the burn recipient, and it pays +
    // signs the Solana mint.
    // Approve TokenMessenger to pull USDC (two-tx path only). Shared by the
    // plain and wrapper-less Stellar-source flows.
    async function stellarApproveStep(stellarAddress: string, amount: bigint) {
        return performStep('approving', 'approve', async () => {
            const existing = await getUsdcAllowance({
                from: stellarAddress,
                spender: STELLAR.contracts.tokenMessengerMinter,
            });
            if (existing >= amount) {
                return { result: true, patch: { detail: 'sufficient allowance already set' } };
            }
            const hash = await approveUsdc({
                from: stellarAddress,
                spender: STELLAR.contracts.tokenMessengerMinter,
                amount,
            });
            return {
                result: true,
                patch: { hash, hashUrl: stellarTxUrl(hash), detail: 'allowance set' },
            };
        });
    }

    async function runStellarToSolana(args: {
        stellarAddress: string;
        solanaWallet: SolanaWallet;
        outboundFlow: OutboundFlow;
        forwarding: boolean;
        amount: string;
        speed: TransferSpeed;
    }) {
        state.amount = args.amount;
        const stellarAmount = parseUsdcStellar(args.amount);

        // EXPERIMENTAL: burn with the Circle forwarding hook and observe whether
        // the relayer mints on Solana (no user receiveMessage). Isolated like the
        // EVM forwarded path.
        if (args.forwarding) {
            await runStellarToSolanaForwarded(args, stellarAmount);
            return;
        }

        const isWrapper = args.outboundFlow === 'wrapper';

        async function burnParams() {
            const feeRows = await fetchBurnFee(STELLAR.domain, SOLANA.domain);
            return {
                maxFee: computeMaxFee(
                    stellarAmount,
                    feeBpsFor(feeRows, args.speed),
                    STELLAR_MAX_FEE,
                ),
                finalityThreshold: thresholdFor(args.speed),
            };
        }

        let burnHash: string;
        if (isWrapper) {
            const h = await performStep('burning', 'burn', async () => {
                const { maxFee, finalityThreshold } = await burnParams();
                const mintRecipient = await solanaAtaToBytes32(args.solanaWallet.address);
                const r = await bridgeUsdcToEvm({
                    caller: args.stellarAddress,
                    amount: stellarAmount,
                    destinationDomain: SOLANA.domain,
                    mintRecipient,
                    maxFee,
                    finalityThreshold,
                });
                return { result: r.hash, patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) } };
            });
            if (h === null) return;
            burnHash = h;
        } else {
            const approved = await stellarApproveStep(args.stellarAddress, stellarAmount);
            if (approved === null) return;
            const h = await performStep('burning', 'burn', async () => {
                const { maxFee, finalityThreshold } = await burnParams();
                const mintRecipient = await solanaAtaToBytes32(args.solanaWallet.address);
                const { hash } = await depositForBurnToSolana({
                    caller: args.stellarAddress,
                    amount: stellarAmount,
                    mintRecipient,
                    maxFee,
                    finalityThreshold,
                });
                return { result: hash, patch: { hash, hashUrl: stellarTxUrl(hash) } };
            });
            if (h === null) return;
            burnHash = h;
        }

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

    // EXPERIMENTAL Stellar→Solana forwarding: burn with the cctp-forward hook
    // (wrapper or two-tx), then observe the recipient's Solana USDC balance for a
    // relayer-completed mint. If it never lands the burn is attested and
    // recoverable via resume (destination_caller is zero). Mirrors the EVM path.
    async function runStellarToSolanaForwarded(
        args: {
            stellarAddress: string;
            solanaWallet: SolanaWallet;
            outboundFlow: OutboundFlow;
            speed: TransferSpeed;
        },
        stellarAmount: bigint,
    ) {
        const isWrapper = args.outboundFlow === 'wrapper';
        if (!isWrapper) {
            const approved = await stellarApproveStep(args.stellarAddress, stellarAmount);
            if (approved === null) return;
        }

        let baseline = 0;
        try {
            baseline = parseFloat(await getSolanaUsdcBalance(args.solanaWallet.address));
        } catch (err) {
            fail(errMsg(err));
            return;
        }

        const burnHash = await performStep('burning', 'burn', async () => {
            const rows = await fetchForwardFee(STELLAR.domain, SOLANA.domain);
            const maxFee = forwardedMaxFeeStellar(rows, args.speed, stellarAmount);
            const mintRecipient = await solanaAtaToBytes32(args.solanaWallet.address);
            const burnArgs = {
                caller: args.stellarAddress,
                amount: stellarAmount,
                destinationDomain: SOLANA.domain,
                mintRecipient,
                maxFee,
                finalityThreshold: thresholdFor(args.speed),
            };
            const r = isWrapper
                ? await bridgeUsdcToEvmWithHook(burnArgs)
                : await depositForBurnWithHookForwarded(burnArgs);
            return {
                result: r.hash,
                patch: {
                    hash: r.hash,
                    hashUrl: stellarTxUrl(r.hash),
                    detail: `forwarding hook · maxFee ${maxFee}`,
                },
            };
        });
        if (burnHash === null) return;

        const attest = await performStep<IrisMessage>('attesting', 'attest', async () => {
            const r = await pollAttestation(STELLAR.domain, burnHash, {
                onProgress: ({ elapsedMs, status }) => {
                    patchStep('attest', { detail: `${Math.round(elapsedMs / 1000)}s · ${status}` });
                },
            });
            return { result: r, patch: { detail: 'attested' } };
        });
        if (attest === null) return;
        state.attestation = attest;

        const minted = await performStep('minting', 'mint', async () => {
            const start = Date.now();
            const timeout = 3 * 60_000;
            while (Date.now() - start < timeout) {
                const bal = parseFloat(await getSolanaUsdcBalance(args.solanaWallet.address));
                if (bal > baseline) {
                    return {
                        result: bal,
                        patch: {
                            detail: `relayer minted (balance ${baseline} → ${bal}, no user tx)`,
                        },
                    };
                }
                patchStep('mint', {
                    detail: `awaiting Circle relayer… ${Math.round((Date.now() - start) / 1000)}s`,
                });
                await sleep(5_000);
            }
            throw new Error(
                'Circle relayer did not mint within 3 min — burn is attested and recoverable: use the resume flow with the burn hash to mint manually.',
            );
        });
        if (minted === null) return;

        state.phase = 'done';
    }

    async function start(args: {
        direction: Direction;
        stellarAddress: string;
        // EVM inputs are optional — Solana transfers omit them entirely.
        evmWallet?: EvmWallet;
        evmChainId?: EvmChainId;
        outboundFlow?: OutboundFlow;
        forwarding?: boolean;
        inboundFlow?: InboundFlow;
        amount: string;
        speed: TransferSpeed;
        solanaWallet?: SolanaWallet;
        stellarRecipient?: string;
    }) {
        const outboundFlow = args.outboundFlow ?? 'two-tx';
        const forwarding = args.forwarding ?? false;
        const inboundFlow = args.inboundFlow ?? 'two-tx';
        state.direction = args.direction;
        state.evmChainId = args.evmChainId;
        state.outboundFlow = outboundFlow;
        state.forwarding = forwarding;
        state.inboundFlow = inboundFlow;
        state.steps = stepsFor(
            args.direction,
            args.evmChainId,
            outboundFlow,
            forwarding,
            inboundFlow,
        );
        state.error = null;
        state.amount = '';
        state.attestation = null;
        try {
            if (args.direction === 'stellar-to-evm') {
                if (!args.evmWallet || !args.evmChainId)
                    throw new Error('EVM wallet/chain not connected.');
                await runStellarToEvm({
                    stellarAddress: args.stellarAddress,
                    evmWallet: args.evmWallet,
                    evmChainId: args.evmChainId,
                    outboundFlow,
                    forwarding,
                    amount: args.amount,
                    speed: args.speed,
                });
            } else if (args.direction === 'solana-to-stellar') {
                if (!args.solanaWallet) throw new Error('Solana wallet not connected.');
                await runSolanaToStellar({
                    stellarAddress: args.stellarAddress,
                    stellarRecipient: args.stellarRecipient ?? args.stellarAddress,
                    solanaWallet: args.solanaWallet,
                    amount: args.amount,
                    speed: args.speed,
                });
            } else if (args.direction === 'stellar-to-solana') {
                if (!args.solanaWallet) throw new Error('Solana wallet not connected.');
                await runStellarToSolana({
                    stellarAddress: args.stellarAddress,
                    solanaWallet: args.solanaWallet,
                    outboundFlow,
                    forwarding,
                    amount: args.amount,
                    speed: args.speed,
                });
            } else {
                if (!args.evmWallet || !args.evmChainId)
                    throw new Error('EVM wallet/chain not connected.');
                await runEvmToStellar({
                    stellarAddress: args.stellarAddress,
                    evmWallet: args.evmWallet,
                    evmChainId: args.evmChainId,
                    inboundFlow,
                    amount: args.amount,
                    speed: args.speed,
                });
            }
        } catch (err) {
            fail(errMsg(err));
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
        evmWallet?: EvmWallet;
        evmChainId?: EvmChainId;
        solanaWallet?: SolanaWallet;
    }) {
        state.direction = args.direction;
        state.evmChainId = args.evmChainId;
        state.outboundFlow = 'two-tx';
        state.forwarding = false;
        state.inboundFlow = 'two-tx';
        state.error = null;
        state.attestation = null;
        state.amount = '';

        // Which chain produced the burn (keys the attestation lookup + tx link),
        // and where the mint lands.
        const source: 'stellar' | 'evm' | 'solana' =
            args.direction === 'stellar-to-evm' || args.direction === 'stellar-to-solana'
                ? 'stellar'
                : args.direction === 'solana-to-stellar'
                  ? 'solana'
                  : 'evm';

        const burnHashUrl =
            source === 'stellar'
                ? stellarTxUrl(args.burnHash)
                : source === 'solana'
                  ? `${SOLANA.explorer}/tx/${args.burnHash}?cluster=devnet`
                  : evmTxUrl(args.evmChainId!, args.burnHash);

        state.steps = stepsFor(args.direction, args.evmChainId, 'two-tx', false, 'two-tx').map(
            (s) => {
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
            },
        );

        const sourceDomain =
            source === 'stellar'
                ? STELLAR.domain
                : source === 'solana'
                  ? SOLANA.domain
                  : EVM_CHAINS[args.evmChainId!].domain;

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
            if (args.direction === 'stellar-to-evm') {
                if (!args.evmWallet || !args.evmChainId)
                    throw new Error('EVM wallet/chain not connected.');
                const hash = await receiveMessageOnEvm({
                    chainId: args.evmChainId,
                    wallet: args.evmWallet,
                    message: attest.message,
                    attestation: attest.attestation,
                });
                return { result: hash, patch: { hash, hashUrl: evmTxUrl(args.evmChainId, hash) } };
            }
            if (args.direction === 'stellar-to-solana') {
                if (!args.solanaWallet) throw new Error('Solana wallet not connected.');
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
            }
            // evm-to-stellar and solana-to-stellar both mint on Stellar.
            const r = await mintAndForward({
                caller: args.stellarAddress,
                message: hexToBytes(attest.message as Hex),
                attestation: hexToBytes(attest.attestation as Hex),
            });
            return { result: r.hash, patch: { hash: r.hash, hashUrl: stellarTxUrl(r.hash) } };
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
