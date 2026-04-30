import { createPublicClient, http } from 'viem';
import { BASE } from '$lib/config';

export const publicClient = createPublicClient({
	chain: BASE.chain,
	transport: http()
});
