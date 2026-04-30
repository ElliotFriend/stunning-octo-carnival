import { createPublicClient, http, type PublicClient } from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';

const cache = new Map<EvmChainId, PublicClient>();

// Tradeoffs we're tuning:
//
// - `pollingInterval` controls how often viem polls during operations like
//   `waitForTransactionReceipt`. Default is 4s, which on Arc's tight public
//   RPC stacks with MetaMask + onboard background polling and can trigger
//   429s. 8s is still well within Arc's 2s block time UX-wise.
//
// - `cacheTime: 0` disables viem's per-call read cache. The cache was
//   making the manual refresh button look broken — clicks within the cache
//   window returned a stale response. Each call goes to the network now.
//
// - HTTP transport retries with longer-than-default backoff so transient
//   429s become brief slowdowns instead of hard errors. viem retries with
//   exponential backoff (delay × 2^attempt), so 1500ms gives us 1.5/3/6s
//   waits across the 3 retries — long enough to clear most rate-limit
//   windows.
const POLLING_INTERVAL_MS = 8_000;
const RPC_RETRY_DELAY_MS = 1_500;
const RPC_RETRY_COUNT = 3;

export function getPublicClient(chainId: EvmChainId): PublicClient {
	const cached = cache.get(chainId);
	if (cached) return cached;
	const cfg = EVM_CHAINS[chainId];
	const client = createPublicClient({
		chain: cfg.chain,
		transport: http(undefined, {
			retryCount: RPC_RETRY_COUNT,
			retryDelay: RPC_RETRY_DELAY_MS
		}),
		pollingInterval: POLLING_INTERVAL_MS,
		cacheTime: 0
	}) as PublicClient;
	cache.set(chainId, client);
	return client;
}
