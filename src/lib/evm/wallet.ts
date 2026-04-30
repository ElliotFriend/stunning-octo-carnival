import { browser } from '$app/environment';
import injectedModule from '@web3-onboard/injected-wallets';
import Onboard, { type OnboardAPI, type WalletState } from '@web3-onboard/core';
import {
    createWalletClient,
    custom,
    type Chain,
    type WalletClient,
    type EIP1193Provider,
} from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';

let onboardInstance: OnboardAPI | null = null;

function getOnboard(): OnboardAPI {
    if (!browser) throw new Error('Onboard is browser-only');
    if (onboardInstance) return onboardInstance;
    onboardInstance = Onboard({
        wallets: [injectedModule()],
        chains: Object.values(EVM_CHAINS).map((c) => ({
            id: `0x${c.chain.id.toString(16)}`,
            token: c.chain.nativeCurrency.symbol,
            label: c.chain.name,
            rpcUrl: c.chain.rpcUrls.default.http[0],
        })),
        appMetadata: {
            name: 'CCTP Demo',
            description: 'Bridge USDC between Stellar and any EVM chain via Circle CCTP',
            icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#7c8cff"/></svg>',
        },
        accountCenter: { desktop: { enabled: false }, mobile: { enabled: false } },
    });
    return onboardInstance;
}

export type EvmWallet = {
    address: `0x${string}`;
    chainId: number;
    walletClient: WalletClient;
    provider: EIP1193Provider;
};

export async function connectEvm(): Promise<EvmWallet> {
    const onboard = getOnboard();
    const wallets: WalletState[] = await onboard.connectWallet();
    if (wallets.length === 0) throw new Error('No wallet connected');
    return adapt(wallets[0]);
}

export async function disconnectEvm(): Promise<void> {
    const onboard = getOnboard();
    const [active] = onboard.state.get().wallets;
    if (active) await onboard.disconnectWallet({ label: active.label });
}

export async function ensureChain(wallet: EvmWallet, target: EvmChainId): Promise<EvmWallet> {
    const cfg = EVM_CHAINS[target];
    if (wallet.chainId === cfg.chain.id) return wallet;
    const onboard = getOnboard();
    const ok = await onboard.setChain({ chainId: `0x${cfg.chain.id.toString(16)}` });
    if (!ok) {
        throw new Error(
            `Switch your wallet to ${cfg.label} (chainId ${cfg.chain.id}). ` +
                `If your wallet doesn't have ${cfg.label} yet, add it with RPC ` +
                `${cfg.chain.rpcUrls.default.http[0]}.`,
        );
    }
    const [updated] = onboard.state.get().wallets;
    return adapt(updated);
}

function adapt(w: WalletState): EvmWallet {
    const account = w.accounts[0];
    if (!account) throw new Error('Wallet returned no account');
    const chain = w.chains[0];
    const chainId = chain ? parseInt(chain.id, 16) : 0;
    const provider = w.provider as EIP1193Provider;
    const matched = Object.values(EVM_CHAINS).find((c) => c.chain.id === chainId);
    const viemChain: Chain | undefined = matched?.chain;
    const walletClient = createWalletClient({
        account: account.address as `0x${string}`,
        chain: viemChain,
        transport: custom(provider),
    });
    return {
        address: account.address as `0x${string}`,
        chainId,
        walletClient,
        provider,
    };
}
