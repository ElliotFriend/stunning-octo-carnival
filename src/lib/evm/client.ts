import { createPublicClient, http, type PublicClient } from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';

const cache = new Map<EvmChainId, PublicClient>();

export function getPublicClient(chainId: EvmChainId): PublicClient {
    const cached = cache.get(chainId);
    if (cached) return cached;
    const cfg = EVM_CHAINS[chainId];
    const client = createPublicClient({
        chain: cfg.chain,
        transport: http(),
    }) as PublicClient;
    cache.set(chainId, client);
    return client;
}
