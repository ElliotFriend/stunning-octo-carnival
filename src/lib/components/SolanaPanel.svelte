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
    import { SOLANA } from '$lib/config';
    import { shortAddr } from '$lib/utils';

    let {
        wallet = $bindable<SolanaWallet | null>(null),
        disabled = false,
    }: { wallet?: SolanaWallet | null; disabled?: boolean } = $props();

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
        if (!wallet) {
            balance = null;
            return;
        }
        error = null;
        try {
            balance = await getUsdcBalance(wallet.address);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    // Exposed via bind:this so DestinationPanel can refetch after a transfer.
    export function refresh() {
        return refreshBalance();
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

    function disconnect() {
        wallet = null;
        balance = null;
    }
</script>

<section class="panel">
    <header class="head">
        <span class="badge solana">Solana</span>
        <span class="muted">domain {SOLANA.domain}</span>
    </header>

    {#if wallet}
        <div class="addr-row">
            <code class="addr" title={wallet.address}>{shortAddr(wallet.address)}</code>
            <div class="actions">
                <button class="link" onclick={refreshBalance}>refresh</button>
                <button class="link" onclick={disconnect}>disconnect</button>
            </div>
        </div>
        <div class="balance">
            <span class="amount">{balance ?? '…'}</span>
            <span class="symbol">USDC</span>
        </div>
        <p class="gas-note">Devnet · fees paid in SOL.</p>
    {:else}
        <button class="connect" onclick={connect} disabled={disabled || connecting}>
            {connecting ? 'Connecting…' : 'Connect Phantom'}
        </button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
    .panel {
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        min-height: 160px;
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .badge {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
    }
    .badge.solana {
        background: color-mix(in srgb, #14f195 20%, transparent);
        color: #14f195;
    }
    .muted {
        color: var(--text-dim);
        font-size: 0.85rem;
        font-family: var(--mono);
    }
    .connect {
        background: var(--bg-elev-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        padding: 0.6rem 1rem;
        border-radius: var(--radius);
        font-weight: 500;
    }
    .connect:hover:not(:disabled) {
        background: var(--accent-dim);
        border-color: var(--accent);
    }
    .addr-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .actions {
        display: flex;
        gap: 0.75rem;
    }
    .addr {
        font-family: var(--mono);
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .link {
        background: none;
        border: none;
        color: var(--accent);
        font-size: 0.8rem;
        padding: 0;
    }
    .link:hover {
        text-decoration: underline;
    }
    .balance {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
    }
    .amount {
        font-size: 1.6rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }
    .symbol {
        font-size: 0.95rem;
        color: var(--text-muted);
    }
    .gas-note {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-dim);
    }
    .error {
        color: var(--error);
        font-size: 0.85rem;
        margin: 0;
        word-break: break-word;
    }
</style>
