<script lang="ts">
	import { onMount } from 'svelte';
	import {
		connectFreighter,
		detectFreighter,
		type FreighterState
	} from '$lib/stellar/freighter';
	import { formatUsdc, getUsdcBalance } from '$lib/stellar/usdc';
	import type { OutboundFlow } from '$lib/config';

	let {
		freighter = $bindable<FreighterState>({
			installed: false,
			address: null,
			networkPassphrase: null
		}),
		outboundFlow = $bindable<OutboundFlow>('two-tx'),
		refreshSignal = 0,
		disabled = false
	}: {
		freighter?: FreighterState;
		outboundFlow?: OutboundFlow;
		refreshSignal?: number;
		disabled?: boolean;
	} = $props();

	let balance = $state<bigint | null>(null);
	let balanceError = $state<string | null>(null);
	let connecting = $state(false);
	let connectError = $state<string | null>(null);

	onMount(async () => {
		freighter = await detectFreighter();
	});

	async function refreshBalance() {
		if (!freighter.address) return;
		balanceError = null;
		try {
			balance = await getUsdcBalance(freighter.address);
		} catch (err) {
			balanceError = err instanceof Error ? err.message : String(err);
			balance = null;
		}
	}

	$effect(() => {
		void refreshSignal;
		if (freighter.address) refreshBalance();
		else balance = null;
	});

	async function connect() {
		connecting = true;
		connectError = null;
		try {
			freighter = await connectFreighter();
		} catch (err) {
			connectError = err instanceof Error ? err.message : String(err);
		} finally {
			connecting = false;
		}
	}

	function shortAddr(a: string) {
		return `${a.slice(0, 6)}…${a.slice(-6)}`;
	}
</script>

<section class="panel">
	<header class="head">
		<span class="badge stellar">Stellar Testnet</span>
		<span class="muted">domain 27</span>
	</header>

	{#if !freighter.address}
		<button class="connect" onclick={connect} disabled={connecting}>
			{connecting ? 'Connecting…' : 'Connect Freighter'}
		</button>
		{#if connectError}<p class="error">{connectError}</p>{/if}
	{:else}
		<div class="addr-row">
			<code class="addr" title={freighter.address}>{shortAddr(freighter.address)}</code>
			<button class="link" onclick={refreshBalance}>refresh</button>
		</div>
		<div class="balance">
			<span class="amount">
				{balance === null ? '…' : formatUsdc(balance)}
			</span>
			<span class="symbol">USDC</span>
		</div>
		{#if balanceError}<p class="error">{balanceError}</p>{/if}
	{/if}

	<div class="flow-picker" role="tablist" aria-label="Stellar outbound flow">
		<span class="flow-label" title="Only applies when bridging Stellar → EVM">
			Outbound flow
		</span>
		<div class="flow-buttons">
			<button
				type="button"
				class="chip"
				class:active={outboundFlow === 'two-tx'}
				disabled={disabled}
				onclick={() => (outboundFlow = 'two-tx')}
				role="tab"
				aria-selected={outboundFlow === 'two-tx'}
				title="Sign approve, then sign deposit_for_burn separately"
			>
				2 tx (direct)
			</button>
			<button
				type="button"
				class="chip"
				class:active={outboundFlow === 'wrapper'}
				disabled={disabled}
				onclick={() => (outboundFlow = 'wrapper')}
				role="tab"
				aria-selected={outboundFlow === 'wrapper'}
				title="One Soroban tx via wrapper contract — single Freighter prompt"
			>
				1 tx (wrapper)
			</button>
		</div>
	</div>
</section>

<style>
	.panel {
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
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

	.badge.stellar {
		background: color-mix(in srgb, var(--stellar) 20%, transparent);
		color: var(--stellar);
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
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.symbol {
		font-size: 0.95rem;
		color: var(--text-muted);
	}

	.error {
		color: var(--error);
		font-size: 0.85rem;
		margin: 0;
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

	.chip {
		flex: 1;
		background: var(--bg-elev-2);
		color: var(--text-muted);
		border: 1px solid var(--border);
		padding: 0.4rem 0.6rem;
		border-radius: var(--radius);
		font-size: 0.78rem;
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
</style>
