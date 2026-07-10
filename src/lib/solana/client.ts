import { createSolanaRpc } from '@solana/kit';
import { SOLANA } from '$lib/config';

// Devnet JSON-RPC client. Balance reads go through this, not through the
// wallet, so Phantom's own cluster selection can't cause a wrong-network read.
export const solanaRpc = createSolanaRpc(SOLANA.rpcUrl);
