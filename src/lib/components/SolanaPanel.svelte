<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import {
        connectSolana,
        detectExistingSolana,
        discoverSolanaWallets,
        type SolanaWallet,
    } from '$lib/solana/wallet';
    import { getUsdcBalance } from '$lib/solana/usdc';
    import { shortAddr } from '$lib/utils';

    let { wallet = $bindable<SolanaWallet | null>(null) }: { wallet?: SolanaWallet | null } =
        $props();

    let balance = $state<string | null>(null);
    let error = $state<string | null>(null);
    let connecting = $state(false);

    onMount(async () => {
        if (!browser) return;
        const existing = await detectExistingSolana();
        if (existing) {
            wallet = existing;
            await refreshBalance();
        }
    });

    async function refreshBalance() {
        if (!wallet) return;
        error = null;
        try {
            balance = await getUsdcBalance(wallet.address);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function connect() {
        error = null;
        connecting = true;
        try {
            const wallets = discoverSolanaWallets();
            if (wallets.length === 0) {
                throw new Error(
                    'No Solana wallet found. Install Phantom from phantom.app and reload.',
                );
            }
            const pick =
                wallets.find((w) => w.name.toLowerCase().includes('phantom')) ?? wallets[0];
            wallet = await connectSolana(pick);
            await refreshBalance();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            connecting = false;
        }
    }
</script>

<div class="panel">
    <h2>Solana (devnet)</h2>
    {#if !wallet}
        <button onclick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect Phantom'}
        </button>
    {:else}
        <p>Wallet: {wallet.name}</p>
        <p><code title={wallet.address}>{shortAddr(wallet.address, 6, 6)}</code></p>
        <p>USDC: {balance ?? '…'}</p>
        <button onclick={refreshBalance}>Refresh</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
    .panel {
        border: 1px solid currentColor;
        border-radius: 8px;
        padding: 1rem;
        max-width: 24rem;
    }
    .error {
        color: crimson;
    }
</style>
