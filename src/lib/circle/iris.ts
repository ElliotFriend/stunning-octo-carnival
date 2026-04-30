import { IRIS_API } from '$lib/config';
import type { Hex } from 'viem';

export type IrisMessage = {
	message: Hex;
	attestation: Hex;
	status: 'complete' | 'pending_confirmations' | string;
	cctpVersion: number;
	eventNonce?: string;
	sourceDomain?: string;
	destinationDomain?: string;
	decodedMessage?: Record<string, unknown>;
};

type IrisResponse = {
	messages?: IrisMessage[];
	error?: string;
};

const COMPLETE = 'complete';

export async function fetchAttestation(
	sourceDomain: number,
	transactionHash: string
): Promise<IrisMessage | null> {
	// Stellar tx hashes are hex without the 0x prefix; EVM hashes have it.
	// Iris accepts both forms but normalize to lowercase to be safe.
	const hash = transactionHash.toLowerCase();
	const url = `${IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${hash}`;
	const res = await fetch(url);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`Iris ${res.status}: ${await res.text()}`);
	}
	const body = (await res.json()) as IrisResponse;
	if (body.error) throw new Error(`Iris error: ${body.error}`);
	const messages = body.messages ?? [];
	if (messages.length === 0) return null;
	// CCTP V2 only emits one message per burn for our flows.
	return messages[0];
}

export type AttestationProgress = (info: { elapsedMs: number; status: string }) => void;

export async function pollAttestation(
	sourceDomain: number,
	transactionHash: string,
	opts: { intervalMs?: number; timeoutMs?: number; onProgress?: AttestationProgress } = {}
): Promise<IrisMessage> {
	const interval = opts.intervalMs ?? 5_000;
	const timeout = opts.timeoutMs ?? 30 * 60_000; // 30 min covers Base finality
	const start = Date.now();

	while (Date.now() - start < timeout) {
		try {
			const msg = await fetchAttestation(sourceDomain, transactionHash);
			if (msg) {
				opts.onProgress?.({ elapsedMs: Date.now() - start, status: msg.status });
				if (msg.status === COMPLETE) return msg;
			} else {
				opts.onProgress?.({ elapsedMs: Date.now() - start, status: 'not_yet_indexed' });
			}
		} catch (err) {
			// Transient errors (rate limit, network blip): keep polling.
			opts.onProgress?.({
				elapsedMs: Date.now() - start,
				status: `retry: ${err instanceof Error ? err.message : String(err)}`
			});
		}
		await sleep(interval);
	}
	throw new Error(`Attestation timed out after ${Math.round(timeout / 1000)}s`);
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
