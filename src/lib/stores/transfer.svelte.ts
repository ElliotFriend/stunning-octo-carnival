import { hexToBytes, type Hex } from 'viem';
import { BASE, STELLAR, type Direction } from '$lib/config';
import { depositForBurnToBase, mintAndForward } from '$lib/stellar/cctp';
import { approveUsdc, getUsdcAllowance, parseUsdcStellar } from '$lib/stellar/usdc';
import {
	approveEvmUsdc,
	getEvmUsdcAllowance,
	parseEvmUsdc
} from '$lib/evm/usdc';
import {
	depositForBurnWithHookToStellar,
	receiveMessageOnBase
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
	phase: Phase;
	amount: string;
	steps: Step[];
	error: string | null;
};

const initialState = (direction: Direction): TransferState => ({
	direction,
	phase: 'idle',
	amount: '',
	steps: stepsFor(direction),
	error: null
});

function stepsFor(direction: Direction): Step[] {
	if (direction === 'stellar-to-base') {
		return [
			{ key: 'approve', label: 'Approve TokenMessenger on Stellar', status: 'pending' },
			{ key: 'burn', label: 'Burn USDC on Stellar', status: 'pending' },
			{ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
			{ key: 'mint', label: 'Mint USDC on Base', status: 'pending' }
		];
	}
	return [
		{ key: 'approve', label: 'Approve USDC on Base', status: 'pending' },
		{ key: 'burn', label: 'Burn USDC on Base', status: 'pending' },
		{ key: 'attest', label: 'Wait for Circle attestation', status: 'pending' },
		{ key: 'mint', label: 'Mint USDC on Stellar (forwarder)', status: 'pending' }
	];
}

export function createTransferStore(initial: Direction = 'stellar-to-base') {
	let state = $state<TransferState>(initialState(initial));

	function setDirection(d: Direction) {
		state = initialState(d);
	}

	function reset() {
		state = initialState(state.direction);
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

	async function runStellarToBase(args: {
		stellarAddress: string;
		evmWallet: EvmWallet;
		amount: string;
	}) {
		state.amount = args.amount;
		const stellarAmount = parseUsdcStellar(args.amount);

		// Approve TMM as a spender on USDC SAC. The contract pulls tokens via
		// SEP-41 `transfer_from`, which requires a pre-existing allowance —
		// Soroban auth on the burn tx alone does not authorize the spend.
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

		// Burn on Stellar
		state.phase = 'burning';
		patchStep('burn', { status: 'active', startedAt: Date.now() });
		let burnHash: string;
		try {
			const result = await depositForBurnToBase({
				caller: args.stellarAddress,
				amount: stellarAmount,
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

		// Mint on Base
		state.phase = 'minting';
		patchStep('mint', { status: 'active', startedAt: Date.now() });
		let mintHash: `0x${string}`;
		try {
			mintHash = await receiveMessageOnBase({
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
			hashUrl: `${BASE.explorer}/tx/${mintHash}`
		});

		state.phase = 'done';
	}

	async function runBaseToStellar(args: {
		stellarAddress: string;
		evmWallet: EvmWallet;
		amount: string;
	}) {
		state.amount = args.amount;
		const evmAmount = parseEvmUsdc(args.amount);

		// Approve if needed
		state.phase = 'approving';
		patchStep('approve', { status: 'active', startedAt: Date.now() });
		try {
			const allowance = await getEvmUsdcAllowance(
				args.evmWallet.address,
				BASE.contracts.tokenMessengerV2
			);
			if (allowance < evmAmount) {
				const hash = await approveEvmUsdc(
					args.evmWallet,
					BASE.contracts.tokenMessengerV2,
					evmAmount
				);
				patchStep('approve', {
					status: 'done',
					endedAt: Date.now(),
					hash,
					hashUrl: `${BASE.explorer}/tx/${hash}`,
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

		// Burn on Base
		state.phase = 'burning';
		patchStep('burn', { status: 'active', startedAt: Date.now() });
		let burnHash: `0x${string}`;
		try {
			burnHash = await depositForBurnWithHookToStellar({
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
			hashUrl: `${BASE.explorer}/tx/${burnHash}`
		});

		// Attest (Base finality ~15min for Standard)
		state.phase = 'attesting';
		patchStep('attest', {
			status: 'active',
			startedAt: Date.now(),
			detail: 'Base finality is ~15 min for Standard transfers'
		});
		let attest: IrisMessage;
		try {
			attest = await pollAttestation(BASE.domain, burnHash, {
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
		amount: string;
	}) {
		state.error = null;
		state.steps = stepsFor(state.direction);
		if (state.direction === 'stellar-to-base') {
			await runStellarToBase(args);
		} else {
			await runBaseToStellar(args);
		}
	}

	return {
		get state() {
			return state;
		},
		setDirection,
		reset,
		start
	};
}

function errMsg(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	return JSON.stringify(err);
}
