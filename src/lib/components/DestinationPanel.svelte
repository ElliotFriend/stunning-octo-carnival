<script lang="ts">
    import { tick } from 'svelte';
    import EvmPanel from './EvmPanel.svelte';
    import SolanaPanel from './SolanaPanel.svelte';
    import {
        EVM_CHAINS,
        type Direction,
        type EvmChainId,
        type InboundFlow,
        type RightChain,
    } from '$lib/config';
    import type { EvmWallet } from '$lib/evm/wallet';
    import type { SendCallsCapability } from '$lib/evm/capabilities';
    import type { SolanaWallet } from '$lib/solana/wallet';

    let {
        chain = $bindable<RightChain>('arc'),
        evmWallet = $bindable<EvmWallet | null>(null),
        evmChainId = $bindable<EvmChainId>('arc'),
        solanaWallet = $bindable<SolanaWallet | null>(null),
        inboundFlow = $bindable<InboundFlow>('two-tx'),
        sendCallsCap = $bindable<SendCallsCapability>({ supported: false, atomic: false }),
        direction,
        disabled = false,
    }: {
        chain?: RightChain;
        evmWallet?: EvmWallet | null;
        evmChainId?: EvmChainId;
        solanaWallet?: SolanaWallet | null;
        inboundFlow?: InboundFlow;
        sendCallsCap?: SendCallsCapability;
        direction: Direction;
        disabled?: boolean;
    } = $props();

    let evmRef = $state<
        { refresh: () => Promise<void>; setChain: (id: EvmChainId) => Promise<void> } | undefined
    >();
    let solRef = $state<{ refresh: () => Promise<void> } | undefined>();

    // Refetch the active body's balance after a transfer.
    export function refresh() {
        return chain === 'solana'
            ? (solRef?.refresh() ?? Promise.resolve())
            : (evmRef?.refresh() ?? Promise.resolve());
    }

    async function pick(id: RightChain) {
        if (id === chain) return;
        chain = id;
        if (id !== 'solana') {
            // Let EvmPanel mount (when coming from Solana) before driving it.
            await tick();
            // setChain owns the chainId write + wallet network switch + refreshes.
            // Do NOT pre-assign evmChainId, or setChain's id-equality guard skips
            // everything. Fall back to a bare assignment only if the ref isn't up
            // yet (fresh mount seeds its initial chain via the binding + onMount).
            if (evmRef) await evmRef.setChain(id);
            else evmChainId = id;
        }
    }
</script>

<section class="dest">
    <div class="chain-picker" role="tablist" aria-label="Destination chain">
        {#each Object.values(EVM_CHAINS) as cfg (cfg.id)}
            <button
                type="button"
                class="chip"
                class:active={chain === cfg.id}
                {disabled}
                onclick={() => pick(cfg.id)}
                role="tab"
                aria-selected={chain === cfg.id}
            >
                {cfg.label}
            </button>
        {/each}
        <button
            type="button"
            class="chip"
            class:active={chain === 'solana'}
            {disabled}
            onclick={() => pick('solana')}
            role="tab"
            aria-selected={chain === 'solana'}
        >
            Solana
        </button>
    </div>

    {#if chain === 'solana'}
        <SolanaPanel bind:this={solRef} bind:wallet={solanaWallet} {disabled} />
    {:else}
        <EvmPanel
            bind:this={evmRef}
            bind:wallet={evmWallet}
            bind:chainId={evmChainId}
            bind:inboundFlow
            bind:sendCallsCap
            {direction}
            {disabled}
        />
    {/if}
</section>

<style>
    .dest {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }
    .chain-picker {
        display: flex;
        gap: 0.4rem;
    }
    .chip {
        flex: 1;
        background: var(--bg-elev-2);
        color: var(--text-muted);
        border: 1px solid var(--border);
        padding: 0.4rem 0.6rem;
        border-radius: var(--radius);
        font-size: 0.8rem;
        font-weight: 500;
        transition: all 120ms;
    }
    .chip:hover:not(:disabled) {
        color: var(--text);
        border-color: var(--border-strong);
    }
    .chip.active {
        background: var(--accent-dim);
        color: var(--text);
        border-color: var(--accent);
    }
    .chip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
</style>
