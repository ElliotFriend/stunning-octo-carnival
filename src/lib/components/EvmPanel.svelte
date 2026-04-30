<script lang="ts">
	import {
		connectEvm,
		disconnectEvm,
		ensureBaseSepolia,
		type EvmWallet
	} from '$lib/evm/wallet';
	import { formatEvmUsdc, getEvmUsdcBalance } from '$lib/evm/usdc';
	import { BASE } from '$lib/config';

	let { wallet = $bindable<EvmWallet | null>(null) } = $props();

	let balance = $state<bigint | null>(null);
	let balanceError = $state<string | null>(null);
	let connecting = $state(false);
	let connectError = $state<string | null>(null);

	async function refreshBalance() {
		if (!wallet) return;
		balanceError = null;
		try {
			balance = await getEvmUsdcBalance(wallet.address);
		} catch (err) {
			balanceError = err instanceof Error ? err.message : String(err);
		}
	}

	$effect(() => {
		if (wallet) refreshBalance();
		else balance = null;
	});

	async function connect() {
		connecting = true;
		connectError = null;
		try {
			let w = await connectEvm();
			w = await ensureBaseSepolia(w);
			wallet = w;
		} catch (err) {
			connectError = err instanceof Error ? err.message : String(err);
		} finally {
			connecting = false;
		}
	}

	async function disconnect() {
		await disconnectEvm();
		wallet = null;
	}

	function shortAddr(a: string) {
		return `${a.slice(0, 6)}…${a.slice(-4)}`;
	}
</script>

<section class="panel">
	<header class="head">
		<span class="badge base">Base Sepolia</span>
		<span class="muted">domain 6</span>
	</header>

	{#if !wallet}
		<button class="connect" onclick={connect} disabled={connecting}>
			{connecting ? 'Connecting…' : 'Connect EVM Wallet'}
		</button>
		{#if connectError}<p class="error">{connectError}</p>{/if}
	{:else}
		<div class="addr-row">
			<code class="addr" title={wallet.address}>{shortAddr(wallet.address)}</code>
			<div class="actions">
				<button class="link" onclick={refreshBalance}>refresh</button>
				<button class="link" onclick={disconnect}>disconnect</button>
			</div>
		</div>
		<div class="balance">
			<span class="amount">
				{balance === null ? '…' : formatEvmUsdc(balance)}
			</span>
			<span class="symbol">USDC</span>
		</div>
		{#if wallet.chainId !== BASE.chain.id}
			<p class="warn">Wrong network — switch to {BASE.chain.name}.</p>
		{/if}
		{#if balanceError}<p class="error">{balanceError}</p>{/if}
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

	.badge.base {
		background: color-mix(in srgb, var(--base) 30%, transparent);
		color: #94b8ff;
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

	.error {
		color: var(--error);
		font-size: 0.85rem;
		margin: 0;
	}

	.warn {
		color: var(--warning);
		font-size: 0.85rem;
		margin: 0;
	}
</style>
