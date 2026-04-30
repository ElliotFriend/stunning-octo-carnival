<script lang="ts">
	import { untrack } from 'svelte';
	import StellarPanel from '$lib/components/StellarPanel.svelte';
	import EvmPanel from '$lib/components/EvmPanel.svelte';
	import DirectionSwitcher from '$lib/components/DirectionSwitcher.svelte';
	import TransferForm from '$lib/components/TransferForm.svelte';
	import TransferProgress from '$lib/components/TransferProgress.svelte';
	import { createTransferStore } from '$lib/stores/transfer.svelte';
	import type { FreighterState } from '$lib/stellar/freighter';
	import type { EvmWallet } from '$lib/evm/wallet';
	import {
		DEFAULT_EVM_CHAIN,
		DEFAULT_OUTBOUND_FLOW,
		EVM_CHAINS,
		type Direction,
		type EvmChainId,
		type OutboundFlow
	} from '$lib/config';

	let stellar = $state<FreighterState>({
		installed: false,
		address: null,
		networkPassphrase: null
	});
	let evm = $state<EvmWallet | null>(null);
	let evmChainId = $state<EvmChainId>(DEFAULT_EVM_CHAIN);
	let direction = $state<Direction>('stellar-to-evm');
	let outboundFlow = $state<OutboundFlow>(DEFAULT_OUTBOUND_FLOW);
	let amount = $state('');
	// Bumped when a transfer finishes — panels watch this to refetch balances.
	let refreshSignal = $state(0);

	const transfer = createTransferStore(
		'stellar-to-evm',
		DEFAULT_EVM_CHAIN,
		DEFAULT_OUTBOUND_FLOW
	);

	// One effect, no store-state reads inside — avoids effect_update_depth_exceeded.
	$effect(() => {
		transfer.setShape({ direction, evmChainId, outboundFlow });
	});

	// `refreshSignal++` reads + writes refreshSignal, which would make it a
	// dependency of this effect and re-fire the effect on every write — an
	// infinite loop where each iteration re-triggers the panels' balance
	// refresh effects. `untrack` excludes the read from dependency tracking.
	$effect(() => {
		if (transfer.state.phase === 'done') {
			untrack(() => refreshSignal++);
		}
	});

	let bothConnected = $derived(!!stellar.address && !!evm);
	let busy = $derived(
		transfer.state.phase !== 'idle' &&
			transfer.state.phase !== 'done' &&
			transfer.state.phase !== 'error'
	);
	let canSubmit = $derived(bothConnected && amount.trim() !== '' && !busy);

	let evmLabel = $derived(EVM_CHAINS[evmChainId].label);

	async function send() {
		if (!stellar.address || !evm) return;
		await transfer.start({
			stellarAddress: stellar.address,
			evmWallet: evm,
			evmChainId,
			outboundFlow,
			amount: amount.trim()
		});
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
			Bridge USDC between Stellar testnet and any CCTP-supported EVM chain
			using Circle's Cross-Chain Transfer Protocol V2.
		</p>
	</header>

	<div class="wallets">
		<StellarPanel
			bind:freighter={stellar}
			bind:outboundFlow
			{refreshSignal}
			disabled={busy}
		/>
		<EvmPanel bind:wallet={evm} bind:chainId={evmChainId} disabled={busy} {refreshSignal} />
	</div>

	<section class="action">
		<DirectionSwitcher bind:direction disabled={busy} {evmLabel} />
		<TransferForm
			{direction}
			{evmLabel}
			bind:amount
			disabled={busy}
			{busy}
			{canSubmit}
			onsubmit={send}
		/>
		{#if !bothConnected}
			<p class="hint">Connect both wallets to enable transfers.</p>
		{/if}
	</section>

	{#if transfer.state.phase !== 'idle'}
		<TransferProgress transfer={transfer.state} />
		{#if transfer.state.phase === 'done' || transfer.state.phase === 'error'}
			<button class="reset" onclick={reset}>Start a new transfer</button>
		{/if}
	{/if}

	<footer class="footer">
		<a href="https://developers.circle.com/cctp/references/stellar" target="_blank" rel="noreferrer"
			>Circle CCTP on Stellar</a
		>
		·
		<a href="https://faucet.circle.com" target="_blank" rel="noreferrer">USDC faucet</a>
		·
		<a href="https://lab.stellar.org/account/fund" target="_blank" rel="noreferrer">XLM faucet</a>
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
