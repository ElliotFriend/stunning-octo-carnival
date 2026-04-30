import { hexToBytes, type Hex } from 'viem';
import {
	EVM_CCTP_CONTRACTS,
	EVM_CHAINS,
	STELLAR,
	type Direction,
	type EvmChainId,
	type OutboundFlow
} from '$lib/config';
import {
	bridgeUsdcToEvm,
	depositForBurnToEvm,
	mintAndForward
} from '$lib/stellar/cctp';
import { approveUsdc, getUsdcAllowance, parseUsdcStellar } from '$lib/stellar/usdc';
import {
	approveEvmUsdc,
	getEvmUsdcAllowance,
	parseEvmUsdc
} from '$lib/evm/usdc';
import {
	depositForBurnWithHookToStellar,
	receiveMessageOnEvm
} from '$lib/evm/cctp';
import { pollAttestation, type IrisMessage } from '$lib/circle/iris';
import type { EvmWallet } from '$lib/evm/wallet';

export type Phase =
	| 'idle'
	| 'approving'
	| 'burning'
	| 'attesting'
	| 'minting'
	| 'done'
	| 'error';

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
	phase: Phase;
	amount: string;
	steps: Step[];
	error: string | null;
};

const initialState = (
	direction: Direction,
	evmChainId: EvmChainId,
	outboundFlow: OutboundFlow
): TransferState => ({
	direction,
	evmChainId,
	outboundFlow,
	phase: 'idle',
	amount: '',
	steps: stepsFor(direction, evmChainId, outboundFlow),
	error: null
});

function stepsFor(
	direction: Direction,
	evmChainId: EvmChainId,
	outboundFlow: OutboundFlow
): Step[] {
	const evmLabel = EVM_CHAINS[evmChainId].label;
	if (direction === 'stellar-to-evm') {
		if (outboundFlow === 'wrapper') {
			return [
				{
					key: 'burn',
					label: 'Approve + burn USDC on Stellar (one tx)',
					status: 'pending'
				},
				{ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
				{ key: 'mint', label: `Mint USDC on ${evmLabel}`, status: 'pending' }
			];
		}
		return [
			{ key: 'approve', label: 'Approve TokenMessenger on Stellar', status: 'pending' },
			{ key: 'burn', label: 'Burn USDC on Stellar', status: 'pending' },
			{ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
			{ key: 'mint', label: `Mint USDC on ${evmLabel}`, status: 'pending' }
		];
	}
	return [
		{ key: 'approve', label: `Approve USDC on ${evmLabel}`, status: 'pending' },
		{ key: 'burn', label: `Burn USDC on ${evmLabel}`, status: 'pending' },
		{ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
		{ key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' }
	];
}

export function createTransferStore(
	initialDirection: Direction,
	initialEvmChain: EvmChainId,
	initialFlow: OutboundFlow
) {
	let state = $state<TransferState>(
		initialState(initialDirection, initialEvmChain, initialFlow)
	);

	// Single setter so callers don't have to read existing store state to
	// update one field — that would create a read+write cycle inside any
	// $effect that calls these.
	function setShape(shape: {
		direction: Direction;
		evmChainId: EvmChainId;
		outboundFlow: OutboundFlow;
	}) {
		state = initialState(shape.direction, shape.evmChainId, shape.outboundFlow);
	}

	function reset() {
		state = initialState(state.direction, state.evmChainId, state.outboundFlow);
	}

	function patchStep(key: Step['key'], patch: Partial<Step>) {
		state.steps = state.steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
	}

	function fail(message: string) {
		state.phase = 'error';
		state.error = message;
		state.steps = state.steps.map((s) =>
			s.status === 'active' ? { ...s, status: 'error', endedAt: Date.now() } : s
		);
	}

	async function runStellarToEvm(args: {
		stellarAddress: string;
		evmWallet: EvmWallet;
		evmChainId: EvmChainId;
		outboundFlow: OutboundFlow;
		amount: string;
	}) {
		state.amount = args.amount;
		const stellarAmount = parseUsdcStellar(args.amount);
		const evmCfg = EVM_CHAINS[args.evmChainId];

		let burnHash: string;
		if (args.outboundFlow === 'wrapper') {
			// Approve + burn in one Soroban transaction via the wrapper contract.
			// Soroban's auth tree authorizes both inner calls from a single
			// Freighter signature.
			state.phase = 'burning';
			patchStep('burn', { status: 'active', startedAt: Date.now() });
			try {
				const result = await bridgeUsdcToEvm({
					caller: args.stellarAddress,
					amount: stellarAmount,
					destinationDomain: evmCfg.domain,
					evmRecipient: args.evmWallet.address
				});
				burnHash = result.hash;
			} catch (err) {
				return fail(errMsg(err));
			}
			patchStep('burn', {
				status: 'done',
				endedAt: Date.now(),
				hash: burnHash,
				hashUrl: `${STELLAR.explorer}/tx/${burnHash}`
			});
		} else {
			// Plain CCTP: approve, then deposit_for_burn. Two Freighter prompts,
			// two on-chain Soroban transactions.
			state.phase = 'approving';
			patchStep('approve', { status: 'active', startedAt: Date.now() });
			try {
				const existing = await getUsdcAllowance({
					from: args.stellarAddress,
					spender: STELLAR.contracts.tokenMessengerMinter
				});
				if (existing < stellarAmount) {
					const hash = await approveUsdc({
						from: args.stellarAddress,
						spender: STELLAR.contracts.tokenMessengerMinter,
						amount: stellarAmount
					});
					patchStep('approve', {
						status: 'done',
						endedAt: Date.now(),
						hash,
						hashUrl: `${STELLAR.explorer}/tx/${hash}`,
						detail: 'allowance set'
					});
				} else {
					patchStep('approve', {
						status: 'done',
						endedAt: Date.now(),
						detail: 'sufficient allowance already set'
					});
				}
			} catch (err) {
				return fail(errMsg(err));
			}

			state.phase = 'burning';
			patchStep('burn', { status: 'active', startedAt: Date.now() });
			try {
				const result = await depositForBurnToEvm({
					caller: args.stellarAddress,
					amount: stellarAmount,
					destinationDomain: evmCfg.domain,
					evmRecipient: args.evmWallet.address
				});
				burnHash = result.hash;
			} catch (err) {
				return fail(errMsg(err));
			}
			patchStep('burn', {
				status: 'done',
				endedAt: Date.now(),
				hash: burnHash,
				hashUrl: `${STELLAR.explorer}/tx/${burnHash}`
			});
		}

		// Attest
		state.phase = 'attesting';
		patchStep('attest', { status: 'active', startedAt: Date.now() });
		let attest: IrisMessage;
		try {
			attest = await pollAttestation(STELLAR.domain, burnHash, {
				onProgress: ({ elapsedMs, status }) => {
					patchStep('attest', { detail: `${Math.round(elapsedMs / 1000)}s · ${status}` });
				}
			});
		} catch (err) {
			return fail(errMsg(err));
		}
		patchStep('attest', { status: 'done', endedAt: Date.now(), detail: 'attested' });

		// Mint on the destination EVM chain
		state.phase = 'minting';
		patchStep('mint', { status: 'active', startedAt: Date.now() });
		let mintHash: `0x${string}`;
		try {
			mintHash = await receiveMessageOnEvm({
				chainId: args.evmChainId,
				wallet: args.evmWallet,
				message: attest.message,
				attestation: attest.attestation
			});
		} catch (err) {
			return fail(errMsg(err));
		}
		patchStep('mint', {
			status: 'done',
			endedAt: Date.now(),
			hash: mintHash,
			hashUrl: `${evmCfg.explorer}/tx/${mintHash}`
		});

		state.phase = 'done';
	}

	async function runEvmToStellar(args: {
		stellarAddress: string;
		evmWallet: EvmWallet;
		evmChainId: EvmChainId;
		amount: string;
	}) {
		state.amount = args.amount;
		const evmAmount = parseEvmUsdc(args.evmChainId, args.amount);
		const evmCfg = EVM_CHAINS[args.evmChainId];

		// Approve if needed
		state.phase = 'approving';
		patchStep('approve', { status: 'active', startedAt: Date.now() });
		try {
			const allowance = await getEvmUsdcAllowance(
				args.evmChainId,
				args.evmWallet.address,
				EVM_CCTP_CONTRACTS.tokenMessengerV2
			);
			if (allowance < evmAmount) {
				const hash = await approveEvmUsdc({
					chainId: args.evmChainId,
					wallet: args.evmWallet,
					spender: EVM_CCTP_CONTRACTS.tokenMessengerV2,
					amount: evmAmount
				});
				patchStep('approve', {
					status: 'done',
					endedAt: Date.now(),
					hash,
					hashUrl: `${evmCfg.explorer}/tx/${hash}`,
					detail: 'allowance set'
				});
			} else {
				patchStep('approve', {
					status: 'done',
					endedAt: Date.now(),
					detail: 'sufficient allowance already set'
				});
			}
		} catch (err) {
			return fail(errMsg(err));
		}

		// Burn on EVM
		state.phase = 'burning';
		patchStep('burn', { status: 'active', startedAt: Date.now() });
		let burnHash: `0x${string}`;
		try {
			burnHash = await depositForBurnWithHookToStellar({
				chainId: args.evmChainId,
				wallet: args.evmWallet,
				amount: evmAmount,
				stellarRecipient: args.stellarAddress
			});
		} catch (err) {
			return fail(errMsg(err));
		}
		patchStep('burn', {
			status: 'done',
			endedAt: Date.now(),
			hash: burnHash,
			hashUrl: `${evmCfg.explorer}/tx/${burnHash}`
		});

		// Attest
		state.phase = 'attesting';
		const finalityNote = finalityHint(args.evmChainId);
		patchStep('attest', {
			status: 'active',
			startedAt: Date.now(),
			detail: finalityNote
		});
		let attest: IrisMessage;
		try {
			attest = await pollAttestation(evmCfg.domain, burnHash, {
				onProgress: ({ elapsedMs, status }) => {
					patchStep('attest', {
						detail: `${Math.round(elapsedMs / 1000)}s · ${status}`
					});
				}
			});
		} catch (err) {
			return fail(errMsg(err));
		}
		patchStep('attest', { status: 'done', endedAt: Date.now(), detail: 'attested' });

		// Mint via forwarder on Stellar (signed by user but permissionless)
		state.phase = 'minting';
		patchStep('mint', { status: 'active', startedAt: Date.now() });
		let mintHash: string;
		try {
			const r = await mintAndForward({
				caller: args.stellarAddress,
				message: hexToBytes(attest.message as Hex),
				attestation: hexToBytes(attest.attestation as Hex)
			});
			mintHash = r.hash;
		} catch (err) {
			return fail(errMsg(err));
		}
		patchStep('mint', {
			status: 'done',
			endedAt: Date.now(),
			hash: mintHash,
			hashUrl: `${STELLAR.explorer}/tx/${mintHash}`
		});

		state.phase = 'done';
	}

	async function start(args: {
		stellarAddress: string;
		evmWallet: EvmWallet;
		evmChainId: EvmChainId;
		outboundFlow: OutboundFlow;
		amount: string;
	}) {
		state.error = null;
		state.evmChainId = args.evmChainId;
		state.outboundFlow = args.outboundFlow;
		state.steps = stepsFor(state.direction, args.evmChainId, args.outboundFlow);
		if (state.direction === 'stellar-to-evm') {
			await runStellarToEvm(args);
		} else {
			await runEvmToStellar(args);
		}
	}

	return {
		get state() {
			return state;
		},
		setShape,
		reset,
		start
	};
}

function finalityHint(chainId: EvmChainId): string {
	if (chainId === 'arc') {
		return "Arc finality is fast — typically under a minute.";
	}
	return 'Base finality is ~15 min for Standard transfers.';
}

function errMsg(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	return JSON.stringify(err);
}
