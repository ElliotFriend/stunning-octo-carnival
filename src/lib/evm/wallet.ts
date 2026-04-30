import { browser } from '$app/environment';
import injectedModule from '@web3-onboard/injected-wallets';
import Onboard, { type OnboardAPI, type WalletState } from '@web3-onboard/core';
import {
	createWalletClient,
	custom,
	type WalletClient,
	type EIP1193Provider
} from 'viem';
import { BASE } from '$lib/config';

let onboardInstance: OnboardAPI | null = null;

function getOnboard(): OnboardAPI {
	if (!browser) throw new Error('Onboard is browser-only');
	if (onboardInstance) return onboardInstance;
	onboardInstance = Onboard({
		wallets: [injectedModule()],
		chains: [
			{
				id: `0x${BASE.chain.id.toString(16)}`,
				token: BASE.chain.nativeCurrency.symbol,
				label: BASE.chain.name,
				rpcUrl: BASE.chain.rpcUrls.default.http[0]
			}
		],
		appMetadata: {
			name: 'CCTP Demo',
			description: 'Bridge USDC between Stellar and Base via Circle CCTP',
			icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#7c8cff"/></svg>'
		},
		accountCenter: { desktop: { enabled: false }, mobile: { enabled: false } }
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

export async function ensureBaseSepolia(wallet: EvmWallet): Promise<EvmWallet> {
	if (wallet.chainId === BASE.chain.id) return wallet;
	const onboard = getOnboard();
	const ok = await onboard.setChain({ chainId: `0x${BASE.chain.id.toString(16)}` });
	if (!ok) throw new Error(`Switch your wallet to ${BASE.chain.name} (chainId ${BASE.chain.id}).`);
	const [updated] = onboard.state.get().wallets;
	return adapt(updated);
}

function adapt(w: WalletState): EvmWallet {
	const account = w.accounts[0];
	if (!account) throw new Error('Wallet returned no account');
	const chain = w.chains[0];
	const chainId = chain ? parseInt(chain.id, 16) : 0;
	const provider = w.provider as EIP1193Provider;
	const walletClient = createWalletClient({
		account: account.address as `0x${string}`,
		chain: BASE.chain,
		transport: custom(provider)
	});
	return {
		address: account.address as `0x${string}`,
		chainId,
		walletClient,
		provider
	};
}
