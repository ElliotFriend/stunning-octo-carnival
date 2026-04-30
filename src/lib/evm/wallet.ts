import { browser } from '$app/environment';
import {
    createWalletClient,
    custom,
    type Chain,
    type EIP1193Provider,
    type WalletClient,
} from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';
import { sleep } from '$lib/utils';

export type EvmWallet = {
    address: `0x${string}`;
    chainId: number;
    walletClient: WalletClient;
    provider: EIP1193Provider;
};

export type EvmProviderInfo = {
    uuid: string;
    name: string;
    icon: string; // data URI or URL — fine to render with <img src={icon}>
    rdns: string;
    provider: EIP1193Provider;
};

const RDNS_STORAGE_KEY = 'cctp-demo:evm-rdns';

// EIP-6963 announce-event payload shape. Kept local — the spec is small and
// pulling a dep just for these types isn't worth it.
type AnnounceDetail = {
    info: { uuid: string; name: string; icon: string; rdns: string };
    provider: EIP1193Provider;
};

function readStoredRdns(): string | null {
    if (!browser) return null;
    try {
        return window.localStorage.getItem(RDNS_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredRdns(rdns: string): void {
    if (!browser) return;
    try {
        window.localStorage.setItem(RDNS_STORAGE_KEY, rdns);
    } catch {
        // private windows / sandboxed iframes can throw — non-fatal.
    }
}

function clearStoredRdns(): void {
    if (!browser) return;
    try {
        window.localStorage.removeItem(RDNS_STORAGE_KEY);
    } catch {
        // see writeStoredRdns
    }
}

// EIP-6963 discovery: subscribe → request → wait → unsubscribe. Wallets
// usually announce synchronously, but some queue a microtask, so we give
// them a short window.
export async function discoverEvmProviders(): Promise<EvmProviderInfo[]> {
    if (!browser) return [];

    const found = new Map<string, EvmProviderInfo>();

    const onAnnounce = (event: Event) => {
        const { info, provider } = (event as CustomEvent<AnnounceDetail>).detail;
        if (!found.has(info.uuid)) {
            found.set(info.uuid, { ...info, provider });
        }
    };

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    try {
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        await sleep(250);
    } finally {
        window.removeEventListener('eip6963:announceProvider', onAnnounce);
    }

    return Array.from(found.values());
}

export async function connectEvm(info?: EvmProviderInfo): Promise<EvmWallet> {
    const provider = info?.provider ?? getLegacyProvider();
    const accounts = (await provider.request({
        method: 'eth_requestAccounts',
    })) as `0x${string}`[];
    if (!accounts || accounts.length === 0) throw new Error('Wallet returned no accounts');
    const chainHex = (await provider.request({ method: 'eth_chainId' })) as `0x${string}`;
    if (info) {
        writeStoredRdns(info.rdns);
    } else {
        // Legacy path: we didn't track which wallet this was, so don't pretend
        // we can auto-reconnect to a specific one on reload.
        clearStoredRdns();
    }
    return adapt(provider, accounts[0], parseInt(chainHex, 16));
}

// Returns a wallet if the user has previously authorized this site, otherwise null.
// Uses eth_accounts which never prompts — silent auto-reconnect.
export async function detectExistingEvm(): Promise<EvmWallet | null> {
    if (!browser) return null;

    const storedRdns = readStoredRdns();
    if (storedRdns) {
        const providers = await discoverEvmProviders();
        const match = providers.find((p) => p.rdns === storedRdns);
        if (!match) {
            // The user explicitly chose this wallet earlier; if it's gone now,
            // bail rather than silently reconnecting to a different one.
            clearStoredRdns();
            return null;
        }
        try {
            const accounts = (await match.provider.request({
                method: 'eth_accounts',
            })) as `0x${string}`[];
            if (!accounts || accounts.length === 0) return null;
            const chainHex = (await match.provider.request({
                method: 'eth_chainId',
            })) as `0x${string}`;
            return adapt(match.provider, accounts[0], parseInt(chainHex, 16));
        } catch {
            return null;
        }
    }

    // No stored rdns: keep the pre-EIP-6963 single-wallet auto-reconnect behavior.
    if (!window.ethereum) return null;
    const provider = window.ethereum;
    try {
        const accounts = (await provider.request({
            method: 'eth_accounts',
        })) as `0x${string}`[];
        if (!accounts || accounts.length === 0) return null;
        const chainHex = (await provider.request({ method: 'eth_chainId' })) as `0x${string}`;
        return adapt(provider, accounts[0], parseInt(chainHex, 16));
    } catch {
        return null;
    }
}

export async function disconnectEvm(provider?: EIP1193Provider): Promise<void> {
    // EIP-1193 has no canonical disconnect. Newer wallets implement
    // wallet_revokePermissions; we try it and ignore wallets that don't.
    // Either way the app clears its local state, which is what users see.
    clearStoredRdns();
    if (!browser) return;
    const target = provider ?? (window.ethereum as EIP1193Provider | undefined);
    if (!target) return;
    try {
        await target.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
        } as Parameters<EIP1193Provider['request']>[0]);
    } catch {
        // Wallet doesn't support permission revocation; that's fine.
    }
}

export async function ensureChain(wallet: EvmWallet, target: EvmChainId): Promise<EvmWallet> {
    const cfg = EVM_CHAINS[target];
    if (wallet.chainId === cfg.chain.id) return wallet;
    const targetIdHex = `0x${cfg.chain.id.toString(16)}` as `0x${string}`;
    try {
        await wallet.provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetIdHex }],
        });
    } catch (err) {
        // 4902: unrecognized chain — add it then we're done (most wallets switch as part of add).
        if (isUnrecognizedChain(err)) {
            await wallet.provider.request({
                method: 'wallet_addEthereumChain',
                params: [
                    {
                        chainId: targetIdHex,
                        chainName: cfg.chain.name,
                        nativeCurrency: cfg.chain.nativeCurrency,
                        rpcUrls: cfg.chain.rpcUrls.default.http as string[],
                        blockExplorerUrls: cfg.chain.blockExplorers
                            ? [cfg.chain.blockExplorers.default.url]
                            : [],
                    },
                ],
            });
        } else {
            throw err;
        }
    }
    return adapt(wallet.provider, wallet.address, cfg.chain.id);
}

function getLegacyProvider(): EIP1193Provider {
    if (!browser) throw new Error('Wallet is browser-only');
    if (!window.ethereum) {
        throw new Error('No EVM wallet detected. Install MetaMask from metamask.io and reload.');
    }
    return window.ethereum;
}

function isUnrecognizedChain(err: unknown): boolean {
    const e = err as { code?: number; data?: { originalError?: { code?: number } } };
    return e?.code === 4902 || e?.data?.originalError?.code === 4902;
}

function adapt(provider: EIP1193Provider, address: `0x${string}`, chainId: number): EvmWallet {
    const matched = Object.values(EVM_CHAINS).find((c) => c.chain.id === chainId);
    const viemChain: Chain | undefined = matched?.chain;
    const walletClient = createWalletClient({
        account: address,
        chain: viemChain,
        transport: custom(provider),
    });
    return { address, chainId, walletClient, provider };
}
