<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import SolanaPanel from '$lib/components/SolanaPanel.svelte';
    import type { SolanaWallet } from '$lib/solana/wallet';
    import { connectFreighter, detectFreighter, type FreighterState } from '$lib/stellar/freighter';
    import { createTransferStore } from '$lib/stores/transfer.svelte';
    import { DEFAULT_SPEED, DEFAULT_EVM_CHAIN } from '$lib/config';

    let wallet = $state<SolanaWallet | null>(null);
    let amount = $state('5');
    let recipient = $state('');
    let direction = $state<'solana-to-stellar' | 'stellar-to-solana'>('solana-to-stellar');
    let stellar = $state<FreighterState>({
        installed: false,
        address: null,
        networkPassphrase: null,
    });

    const store = createTransferStore(
        'solana-to-stellar',
        DEFAULT_EVM_CHAIN,
        'two-tx',
        false,
        'two-tx',
    );

    onMount(async () => {
        if (!browser) return;
        stellar = await detectFreighter();
        if (stellar.address) recipient = stellar.address;
    });

    async function connectStellar() {
        stellar = await connectFreighter();
        if (stellar.address && !recipient) recipient = stellar.address;
    }

    async function burn() {
        if (!wallet || !stellar.address) return;
        await store.start({
            direction,
            stellarAddress: stellar.address,
            stellarRecipient: recipient || stellar.address,
            solanaWallet: wallet,
            amount,
            // Ignored by the solana-to-stellar path but required by start()'s
            // shared arg shape (this is a throwaway harness).
            evmWallet: undefined as never,
            evmChainId: DEFAULT_EVM_CHAIN,
            outboundFlow: 'two-tx',
            forwarding: false,
            inboundFlow: 'two-tx',
            speed: DEFAULT_SPEED,
        });
    }
</script>

<h1>Solana ↔ Stellar spike</h1>

<label>
    Direction
    <select bind:value={direction}>
        <option value="solana-to-stellar">Solana → Stellar</option>
        <option value="stellar-to-solana">Stellar → Solana</option>
    </select>
</label>

{#if !stellar.address}
    <button onclick={connectStellar}>Connect Freighter</button>
{:else}
    <p>Stellar: <code>{stellar.address}</code></p>
{/if}

<SolanaPanel bind:wallet bind:amount bind:recipient steps={store.state.steps} onBurn={burn} />

{#if store.state.error}<p class="error">{store.state.error}</p>{/if}

<style>
    .error {
        color: crimson;
    }
</style>
