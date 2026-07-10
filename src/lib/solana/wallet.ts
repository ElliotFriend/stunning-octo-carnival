import { browser } from '$app/environment';
import { getWallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';
import { sleep } from '$lib/utils';

const NAME_STORAGE_KEY = 'cctp-demo:solana-wallet';

export type SolanaWalletInfo = {
    name: string;
    icon: string;
    wallet: Wallet;
};

export type SolanaWallet = {
    name: string;
    icon: string;
    address: string;
};

// Minimal shape of the standard:connect feature. Kept local rather than
// pulling @wallet-standard/features just for the type — mirrors how
// evm/wallet.ts keeps its EIP-6963 types local.
type ConnectableAccount = { address: string };
type ConnectFeature = {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly ConnectableAccount[] }>;
};

function isSolana(w: Wallet): boolean {
    return w.chains.some((c) => c.startsWith('solana:')) && 'standard:connect' in w.features;
}

function connectFeature(w: Wallet): ConnectFeature {
    return w.features['standard:connect'] as unknown as ConnectFeature;
}

function readStoredName(): string | null {
    if (!browser) return null;
    try {
        return window.localStorage.getItem(NAME_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredName(name: string): void {
    if (!browser) return;
    try {
        window.localStorage.setItem(NAME_STORAGE_KEY, name);
    } catch {
        // private windows / sandboxed iframes can throw — non-fatal.
    }
}

export function discoverSolanaWallets(): SolanaWalletInfo[] {
    if (!browser) return [];
    return getWallets()
        .get()
        .filter(isSolana)
        .map((w) => ({ name: w.name, icon: w.icon, wallet: w }));
}

export async function connectSolana(info: SolanaWalletInfo): Promise<SolanaWallet> {
    const { accounts } = await connectFeature(info.wallet).connect();
    if (accounts.length === 0) throw new Error('Wallet returned no accounts.');
    writeStoredName(info.name);
    return { name: info.name, icon: info.icon, address: accounts[0].address };
}

// Silent reconnect: standard:connect with { silent: true } asks the wallet to
// return previously-authorized accounts without prompting. `silent` is a HINT
// per the Wallet Standard spec — a wallet MAY prompt anyway. Null if the user
// never connected, the wallet is gone, or it declines.
//
// Timing: this runs on page load, when the wallet extension may not have
// registered yet. Wallet Standard's app-ready/register handshake usually makes
// getWallets().get() synchronously complete, but a late-injecting extension can
// miss the first pass — so if our stored wallet isn't present, wait briefly and
// look again once (mirrors the EIP-6963 sleep in evm/wallet.ts) before giving up.
export async function detectExistingSolana(): Promise<SolanaWallet | null> {
    if (!browser) return null;
    const name = readStoredName();
    if (!name) return null;

    let info = discoverSolanaWallets().find((w) => w.name === name);
    if (!info) {
        await sleep(250);
        info = discoverSolanaWallets().find((w) => w.name === name);
    }
    if (!info) return null;

    try {
        const { accounts } = await connectFeature(info.wallet).connect({ silent: true });
        if (accounts.length === 0) return null;
        return { name: info.name, icon: info.icon, address: accounts[0].address };
    } catch {
        return null;
    }
}
