<script lang="ts">
    import StellarPanel from '$lib/components/StellarPanel.svelte';
    import EvmPanel from '$lib/components/EvmPanel.svelte';
    import DirectionSwitcher from '$lib/components/DirectionSwitcher.svelte';
    import TransferForm from '$lib/components/TransferForm.svelte';
    import TransferProgress from '$lib/components/TransferProgress.svelte';
    import HookDataPreview from '$lib/components/HookDataPreview.svelte';
    import StellarBurnPreview from '$lib/components/StellarBurnPreview.svelte';
    import EvmBurnPreview from '$lib/components/EvmBurnPreview.svelte';
    import ResumeForm from '$lib/components/ResumeForm.svelte';
    import { createTransferStore } from '$lib/stores/transfer.svelte';
    import type { FreighterState } from '$lib/stellar/freighter';
    import type { EvmWallet } from '$lib/evm/wallet';
    import type { SendCallsCapability } from '$lib/evm/capabilities';
    import {
        DEFAULT_EVM_CHAIN,
        DEFAULT_FORWARDER,
        DEFAULT_INBOUND_FLOW,
        DEFAULT_OUTBOUND_FLOW,
        DEFAULT_SPEED,
        EVM_CHAINS,
        type Direction,
        type EvmChainId,
        type InboundFlow,
        type OutboundFlow,
        type TransferSpeed,
    } from '$lib/config';

    let stellar = $state<FreighterState>({
        installed: false,
        address: null,
        networkPassphrase: null,
    });
    let evm = $state<EvmWallet | null>(null);
    let evmChainId = $state<EvmChainId>(DEFAULT_EVM_CHAIN);
    let direction = $state<Direction>('stellar-to-evm');
    let outboundFlow = $state<OutboundFlow>(DEFAULT_OUTBOUND_FLOW);
    let forwarder = $state<boolean>(DEFAULT_FORWARDER);
    let inboundFlow = $state<InboundFlow>(DEFAULT_INBOUND_FLOW);
    let sendCallsCap = $state<SendCallsCapability>({ supported: false, atomic: false });
    let amount = $state('');
    let speed = $state<TransferSpeed>(DEFAULT_SPEED);

    // Component instance handles, populated by `bind:this`. Used to imperatively
    // refresh each panel's balance after a successful transfer.
    let stellarPanel = $state<{ refresh: () => Promise<void> } | undefined>();
    let evmPanel = $state<{ refresh: () => Promise<void> } | undefined>();

    const transfer = createTransferStore(
        'stellar-to-evm',
        DEFAULT_EVM_CHAIN,
        DEFAULT_OUTBOUND_FLOW,
        DEFAULT_FORWARDER,
        DEFAULT_INBOUND_FLOW,
    );

    let bothConnected = $derived(!!stellar.address && !!evm);
    let busy = $derived(
        transfer.state.phase !== 'idle' &&
            transfer.state.phase !== 'done' &&
            transfer.state.phase !== 'error',
    );
    let canSubmit = $derived(bothConnected && amount.trim() !== '' && !busy);

    let evmLabel = $derived(EVM_CHAINS[evmChainId].label);

    // Stellar finalizes in seconds and always attests at the finalized threshold,
    // so Fast Transfer is not possible with Stellar as the source. Coerce the
    // submitted/previewed speed to standard for that direction regardless of the
    // picker's lingering value (the UI also disables Fast there).
    let effectiveSpeed = $derived<TransferSpeed>(
        direction === 'stellar-to-evm' ? 'standard' : speed,
    );

    async function send() {
        if (!stellar.address || !evm) return;
        await transfer.start({
            direction,
            stellarAddress: stellar.address,
            evmWallet: evm,
            evmChainId,
            outboundFlow,
            forwarder,
            inboundFlow,
            amount: amount.trim(),
            speed: effectiveSpeed,
        });
        // Skip refetch on error — the burn may not have landed, and a failed RPC
        // call here would clobber the error state shown to the user.
        if (transfer.state.phase === 'done') {
            await Promise.all([stellarPanel?.refresh(), evmPanel?.refresh()]);
        }
    }

    async function resume(burnHash: string) {
        if (!stellar.address || !evm) return;
        await transfer.resume({
            burnHash,
            direction,
            stellarAddress: stellar.address,
            evmWallet: evm,
            evmChainId,
        });
        if (transfer.state.phase === 'done') {
            await Promise.all([stellarPanel?.refresh(), evmPanel?.refresh()]);
        }
    }

    function reset() {
        transfer.reset();
        amount = '';
    }
</script>

<main class="page">
    <header class="header">
        <h1 class="title">CCTP Demo</h1>
        <p class="subtitle">
            Bridge USDC between Stellar testnet and any CCTP-supported EVM chain using Circle's
            Cross-Chain Transfer Protocol V2.
        </p>
    </header>

    <div class="wallets">
        <StellarPanel
            bind:this={stellarPanel}
            bind:freighter={stellar}
            bind:outboundFlow
            bind:forwarder
            {direction}
            disabled={busy}
        />
        <EvmPanel
            bind:this={evmPanel}
            bind:wallet={evm}
            bind:chainId={evmChainId}
            bind:inboundFlow
            bind:sendCallsCap
            {direction}
            disabled={busy}
        />
    </div>

    <section class="action">
        <DirectionSwitcher bind:direction disabled={busy} {evmLabel} />
        <TransferForm
            {direction}
            {evmLabel}
            bind:amount
            bind:speed
            disabled={busy}
            {busy}
            {canSubmit}
            onsubmit={send}
        />
        {#if !bothConnected}
            <p class="hint">Connect both wallets to enable transfers.</p>
        {/if}
        {#if transfer.state.phase === 'idle'}
            <ResumeForm {direction} {bothConnected} disabled={busy} onResume={resume} />
        {/if}
        {#if direction === 'evm-to-stellar' && stellar.address && evm && transfer.state.phase === 'idle'}
            <EvmBurnPreview
                evmAddress={evm.address}
                {evmChainId}
                stellarRecipient={stellar.address}
                {amount}
                {inboundFlow}
                {sendCallsCap}
                {speed}
            />
            <HookDataPreview stellarRecipient={stellar.address} />
        {/if}
        {#if direction === 'stellar-to-evm' && stellar.address && evm && transfer.state.phase === 'idle'}
            <StellarBurnPreview
                stellarAddress={stellar.address}
                evmRecipient={evm.address}
                {evmChainId}
                {amount}
                {outboundFlow}
                {forwarder}
                speed={effectiveSpeed}
            />
        {/if}
    </section>

    {#if transfer.state.phase !== 'idle'}
        <TransferProgress transfer={transfer.state} />
        {#if transfer.state.phase === 'done' || transfer.state.phase === 'error'}
            <button class="reset" onclick={reset}>Start a new transfer</button>
        {/if}
    {/if}

    <footer class="footer">
        <a
            href="https://developers.circle.com/cctp/references/stellar"
            target="_blank"
            rel="noreferrer">Circle CCTP on Stellar</a
        >
        ·
        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">USDC faucet</a>
        ·
        <a href="https://lab.stellar.org/account/fund" target="_blank" rel="noreferrer"
            >XLM faucet</a
        >
    </footer>
</main>

<style>
    .page {
        max-width: 720px;
        margin: 0 auto;
        padding: 3rem 1.25rem 4rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .header {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        text-align: center;
    }

    .title {
        margin: 0;
        font-size: 2rem;
        font-weight: 700;
        letter-spacing: -0.01em;
    }

    .subtitle {
        margin: 0;
        color: var(--text-muted);
        max-width: 32rem;
        margin-inline: auto;
    }

    .wallets {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
    }

    @media (max-width: 560px) {
        .wallets {
            grid-template-columns: 1fr;
        }
    }

    .action {
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
    }

    .hint {
        margin: 0;
        text-align: center;
        color: var(--text-dim);
        font-size: 0.85rem;
    }

    .reset {
        align-self: flex-end;
        background: var(--bg-elev-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        padding: 0.5rem 1rem;
        border-radius: var(--radius);
        font-size: 0.9rem;
    }

    .reset:hover {
        background: var(--accent-dim);
        border-color: var(--accent);
    }

    .footer {
        text-align: center;
        color: var(--text-dim);
        font-size: 0.85rem;
        padding-top: 1rem;
    }
</style>
