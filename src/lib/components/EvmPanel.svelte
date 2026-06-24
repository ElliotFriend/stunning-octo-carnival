<script lang="ts">
    import { onMount } from 'svelte';
    import {
        connectEvm,
        detectExistingEvm,
        disconnectEvm,
        discoverEvmProviders,
        ensureChain,
        type EvmProviderInfo,
        type EvmWallet,
    } from '$lib/evm/wallet';
    import { formatEvmUsdc, getEvmUsdcBalance } from '$lib/evm/usdc';
    import { fetchSendCallsCapability, type SendCallsCapability } from '$lib/evm/capabilities';
    import { EVM_CHAINS, type Direction, type EvmChainId, type InboundFlow } from '$lib/config';
    import { shortAddr } from '$lib/utils';

    let {
        wallet = $bindable<EvmWallet | null>(null),
        chainId = $bindable<EvmChainId>('arc'),
        inboundFlow = $bindable<InboundFlow>('two-tx'),
        // EIP-5792 capability for (wallet, chainId). Owned by the parent so
        // EvmBurnPreview can read it too; refreshed here on connect / chain
        // switch via explicit dataflow.
        sendCallsCap = $bindable<SendCallsCapability>({ supported: false, atomic: false }),
        direction,
        disabled = false,
    }: {
        wallet?: EvmWallet | null;
        chainId?: EvmChainId;
        inboundFlow?: InboundFlow;
        sendCallsCap?: SendCallsCapability;
        direction: Direction;
        disabled?: boolean;
    } = $props();

    let balance = $state<bigint | null>(null);
    let balanceError = $state<string | null>(null);
    let connecting = $state(false);
    let connectError = $state<string | null>(null);
    let pickerProviders = $state<EvmProviderInfo[] | null>(null);

    let selectedCfg = $derived(EVM_CHAINS[chainId]);
    let onCorrectChain = $derived(!!wallet && wallet.chainId === selectedCfg.chain.id);
    let wrapperAvailable = $derived(!!selectedCfg.bridgeWrapper);
    let sendCallsAvailable = $derived(sendCallsCap.supported);

    onMount(async () => {
        const existing = await detectExistingEvm();
        if (existing) {
            wallet = existing;
            await refreshBalance();
            await refreshSendCallsCap();
        }
    });

    async function refreshSendCallsCap() {
        if (!wallet) {
            sendCallsCap = { supported: false, atomic: false };
            return;
        }
        sendCallsCap = await fetchSendCallsCapability(wallet, chainId);
        // If the user had send-calls selected but it's no longer available
        // (different wallet, different chain), drop back to two-tx.
        if (!sendCallsCap.supported && inboundFlow === 'send-calls') {
            inboundFlow = 'two-tx';
        }
    }

    async function refreshBalance() {
        if (!wallet) {
            balance = null;
            return;
        }
        balanceError = null;
        try {
            balance = await getEvmUsdcBalance(chainId, wallet.address);
        } catch (err) {
            balanceError = err instanceof Error ? err.message : String(err);
        }
    }

    // Exposed via `bind:this` so the parent can refetch balance after a transfer.
    export function refresh() {
        return refreshBalance();
    }

    async function startConnect() {
        connectError = null;
        connecting = true;
        try {
            const providers = await discoverEvmProviders();
            if (providers.length === 0) {
                await connectWith(undefined);
            } else if (providers.length === 1) {
                await connectWith(providers[0]);
            } else {
                pickerProviders = providers;
            }
        } catch (err) {
            connectError = err instanceof Error ? err.message : String(err);
        } finally {
            connecting = false;
        }
    }

    async function connectWith(info: EvmProviderInfo | undefined) {
        connecting = true;
        connectError = null;
        try {
            let w = await connectEvm(info);
            w = await ensureChain(w, chainId);
            wallet = w;
            await refreshBalance();
            await refreshSendCallsCap();
        } catch (err) {
            connectError = err instanceof Error ? err.message : String(err);
        } finally {
            pickerProviders = null;
            connecting = false;
        }
    }

    async function switchChain() {
        if (!wallet) return;
        connectError = null;
        try {
            wallet = await ensureChain(wallet, chainId);
            await refreshBalance();
            await refreshSendCallsCap();
        } catch (err) {
            connectError = err instanceof Error ? err.message : String(err);
        }
    }

    async function pickChain(id: EvmChainId) {
        if (id === chainId) return;
        chainId = id;
        // If switching to a chain without a deployed wrapper, drop back to
        // two-tx so the user doesn't submit with a flow this chain can't run.
        if (!EVM_CHAINS[id].bridgeWrapper && inboundFlow === 'wrapper') {
            inboundFlow = 'two-tx';
        }
        if (wallet) {
            await switchChain();
        } else {
            // No wallet to switch — just clear the stale balance for the previous chain.
            balance = null;
            sendCallsCap = { supported: false, atomic: false };
        }
    }

    async function disconnect() {
        await disconnectEvm(wallet?.provider);
        wallet = null;
        balance = null;
        sendCallsCap = { supported: false, atomic: false };
        if (inboundFlow === 'send-calls') inboundFlow = 'two-tx';
    }
</script>

<section class="panel">
    <header class="head">
        <span class="badge {chainId}">{selectedCfg.label}</span>
        <span class="muted">domain {selectedCfg.domain}</span>
    </header>

    <div class="chain-picker" role="tablist" aria-label="EVM chain">
        {#each Object.values(EVM_CHAINS) as cfg (cfg.id)}
            <button
                type="button"
                class="chip"
                class:active={chainId === cfg.id}
                disabled={disabled || connecting}
                onclick={() => pickChain(cfg.id)}
                role="tab"
                aria-selected={chainId === cfg.id}
            >
                {cfg.label}
            </button>
        {/each}
    </div>

    {#if wallet}
        <div class="addr-row">
            <code class="addr" title={wallet.address}>{shortAddr(wallet.address)}</code>
            <div class="actions">
                <button class="link" onclick={refreshBalance}>refresh</button>
                <button class="link" onclick={disconnect}>disconnect</button>
            </div>
        </div>
        <div class="balance">
            <span class="amount">
                {balance === null ? '…' : formatEvmUsdc(chainId, balance)}
            </span>
            <span class="symbol">USDC</span>
        </div>
        <p class="gas-note">{selectedCfg.gasNote}</p>
        {#if !onCorrectChain}
            <div class="wrong-chain">
                <span>Wallet is on chain {wallet.chainId}, expected {selectedCfg.chain.id}.</span>
                <button class="link" onclick={switchChain}>switch</button>
            </div>
        {/if}
        {#if connectError}<p class="error">{connectError}</p>{/if}
        {#if balanceError}<p class="error">{balanceError}</p>{/if}
    {:else if pickerProviders}
        <div class="picker">
            <span class="picker-label">Choose a wallet</span>
            <div class="picker-list">
                {#each pickerProviders as info (info.uuid)}
                    <button
                        type="button"
                        class="connect picker-item"
                        disabled={connecting}
                        onclick={() => connectWith(info)}
                    >
                        <img class="picker-icon" src={info.icon} alt="" />
                        <span class="picker-name">{info.name}</span>
                    </button>
                {/each}
            </div>
            <button
                type="button"
                class="link picker-cancel"
                onclick={() => (pickerProviders = null)}
            >
                cancel
            </button>
            {#if connectError}<p class="error">{connectError}</p>{/if}
        </div>
    {:else}
        <button class="connect" onclick={startConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect EVM Wallet'}
        </button>
        {#if connectError}<p class="error">{connectError}</p>{/if}
    {/if}

    {#if direction === 'evm-to-stellar'}
        <div class="flow-picker" role="tablist" aria-label="EVM inbound flow">
            <span class="flow-label">Inbound flow</span>
            <div class="flow-buttons">
                <button
                    type="button"
                    class="chip"
                    class:active={inboundFlow === 'two-tx'}
                    {disabled}
                    onclick={() => (inboundFlow = 'two-tx')}
                    role="tab"
                    aria-selected={inboundFlow === 'two-tx'}
                    title="Sign approve, then sign depositForBurnWithHook separately"
                >
                    2 tx (direct)
                </button>
                <button
                    type="button"
                    class="chip"
                    class:active={inboundFlow === 'wrapper'}
                    disabled={disabled || !wrapperAvailable}
                    onclick={() => (inboundFlow = 'wrapper')}
                    role="tab"
                    aria-selected={inboundFlow === 'wrapper'}
                    title={wrapperAvailable
                        ? 'One tx via CctpWrapper — sign an EIP-2612 permit, then submit one transaction'
                        : 'No CctpWrapper deployed on this chain — set bridgeWrapper in config.ts'}
                >
                    1 tx (permit)
                </button>
                <button
                    type="button"
                    class="chip"
                    class:active={inboundFlow === 'send-calls'}
                    disabled={disabled || !sendCallsAvailable}
                    onclick={() => (inboundFlow = 'send-calls')}
                    role="tab"
                    aria-selected={inboundFlow === 'send-calls'}
                    title={sendCallsAvailable
                        ? sendCallsCap.atomic
                            ? 'Wallet bundles approve + burn atomically (EIP-5792 + EIP-7702 / smart wallet) — one click, one tx'
                            : 'Wallet bundles approve + burn behind one prompt, but submits them sequentially (still two txs)'
                        : 'This wallet does not advertise EIP-5792 wallet_sendCalls on this chain'}
                >
                    1 click {sendCallsCap.atomic ? '(atomic)' : '(batched)'}
                </button>
            </div>
        </div>
    {/if}
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

    .badge.arc {
        background: color-mix(in srgb, var(--arc) 18%, transparent);
        color: var(--arc);
    }

    .badge.base {
        background: color-mix(in srgb, var(--base) 30%, transparent);
        color: #94b8ff;
    }

    .badge.ethereum {
        background: color-mix(in srgb, #627eea 24%, transparent);
        color: #aab6f5;
    }

    .muted {
        color: var(--text-dim);
        font-size: 0.85rem;
        font-family: var(--mono);
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

    .connect {
        background: var(--bg-elev-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        padding: 0.6rem 1rem;
        border-radius: var(--radius);
        font-weight: 500;
        transition: background 120ms;
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

    .picker {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .picker-label {
        font-size: 0.78rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .picker-list {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .picker-item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        text-align: left;
        padding: 0.5rem 0.75rem;
    }

    .picker-icon {
        width: 20px;
        height: 20px;
        flex: none;
        object-fit: contain;
        border-radius: 4px;
        background: var(--bg-elev-2);
    }

    .picker-name {
        font-size: 0.9rem;
        color: var(--text);
    }

    .picker-cancel {
        align-self: flex-start;
    }

    .flow-picker {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin-top: auto;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border);
    }

    .flow-label {
        font-size: 0.7rem;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .flow-buttons {
        display: flex;
        gap: 0.4rem;
    }

    .chip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .wrong-chain {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        font-size: 0.8rem;
        color: var(--warning);
    }
</style>
