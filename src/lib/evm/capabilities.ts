import { EVM_CHAINS, type EvmChainId } from '$lib/config';
import type { EvmWallet } from './wallet';

// What we ask about per chain: whether the wallet does EIP-5792 at all, and
// if so whether it executes the batched calls atomically (one tx) or just
// bundles the UX (still multiple txs under the hood). Both forms are useful
// — atomic gives "1 tx, 1 click", sequential gives "n tx, 1 click" — but we
// only enable the toggle for `supported` since that's where the demo story
// holds up cleanly.
export type SendCallsCapability = {
    supported: boolean; // wallet implements wallet_sendCalls on this chain
    atomic: boolean; // calls run as a single atomic transaction
};

const UNSUPPORTED: SendCallsCapability = { supported: false, atomic: false };

// EIP-5792 capability discovery. Wallets that don't implement the method
// throw — we treat any error or absence as "unsupported" rather than
// surfacing it, because the UI just disables a chip in that case.
//
// `atomic.status` per spec:
//   - 'supported' : wallet guarantees atomic execution (smart wallet or
//                   EIP-7702 delegation). One transaction.
//   - 'ready'     : wallet supports batching but execution may be sequential.
//                   Multiple transactions, single UI confirmation.
//   - absent / other : no EIP-5792 support.
export async function fetchSendCallsCapability(
    wallet: EvmWallet,
    chainId: EvmChainId,
): Promise<SendCallsCapability> {
    const targetChainId = EVM_CHAINS[chainId].chain.id;
    try {
        const raw = await wallet.walletClient.getCapabilities({
            account: wallet.address,
            chainId: targetChainId,
        });
        // viem's overload returns either the single-chain Capabilities object
        // (when chainId is passed) or a record keyed by chainId. Real-world
        // wallets honor the single-chain shape; defensively unwrap if not.
        const caps =
            'atomic' in (raw as Record<string, unknown>)
                ? (raw as { atomic?: { status?: string } })
                : ((raw as Record<number, { atomic?: { status?: string } }>)[targetChainId] ?? {});
        const atomicStatus = caps.atomic?.status;
        if (atomicStatus === 'supported') return { supported: true, atomic: true };
        if (atomicStatus === 'ready') return { supported: true, atomic: false };
        return UNSUPPORTED;
    } catch {
        return UNSUPPORTED;
    }
}
