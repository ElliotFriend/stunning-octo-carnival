<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { TransferState } from '$lib/stores/transfer.svelte';

	let { transfer }: { transfer: TransferState } = $props();

	// Drive a 1s tick so elapsed timers update without depending on the store.
	let now = $state(Date.now());
	let tick = setInterval(() => (now = Date.now()), 1000);
	onDestroy(() => clearInterval(tick));

	const LONG_WAIT_KEY = 'attest';
	const LONG_WAIT_DIRECTION = 'base-to-stellar';
	// Mean Base Sepolia → Sepolia finality, used for the estimate countdown.
	const LONG_WAIT_TARGET_MS = 15 * 60_000;

	function fmtElapsed(s: { startedAt?: number; endedAt?: number }): string | null {
		if (!s.startedAt) return null;
		const end = s.endedAt ?? now;
		const sec = Math.round((end - s.startedAt) / 1000);
		if (sec < 60) return `${sec}s`;
		const m = Math.floor(sec / 60);
		const r = sec % 60;
		return `${m}m ${r.toString().padStart(2, '0')}s`;
	}

	function fmtRemaining(startedAt: number): string {
		const elapsed = now - startedAt;
		const remaining = LONG_WAIT_TARGET_MS - elapsed;
		if (remaining <= 0) return 'any moment now';
		const m = Math.ceil(remaining / 60_000);
		return `~${m} min remaining`;
	}

	function shortHash(h: string) {
		return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
	}

	function isLongWait(stepKey: string, status: string) {
		return (
			stepKey === LONG_WAIT_KEY &&
			status === 'active' &&
			transfer.direction === LONG_WAIT_DIRECTION
		);
	}
</script>

<section class="progress">
	<header class="head">
		<h3 class="title">Transfer</h3>
		{#if transfer.amount}
			<span class="amount-tag">{transfer.amount} USDC</span>
		{/if}
	</header>

	<ol class="steps">
		{#each transfer.steps as step (step.key)}
			<li class="step status-{step.status}">
				<span class="indicator">
					{#if step.status === 'done'}✓{:else if step.status === 'active'}●{:else if step.status === 'error'}✕{:else}○{/if}
				</span>
				<div class="body">
					<div class="label-row">
						<span class="label">{step.label}</span>
						{#if fmtElapsed(step)}<span class="elapsed">{fmtElapsed(step)}</span>{/if}
					</div>
					{#if step.detail}
						<div class="detail">{step.detail}</div>
					{/if}
					{#if step.hash}
						<a class="tx-link" href={step.hashUrl} target="_blank" rel="noreferrer">
							<code>{shortHash(step.hash)}</code>
							<span class="ext">↗</span>
						</a>
					{/if}
					{#if isLongWait(step.key, step.status) && step.startedAt}
						<aside class="long-wait">
							<strong>This step usually takes about 15 minutes.</strong>
							<span class="long-wait-sub">
								Circle's attesters wait for Base's batch to settle on Sepolia
								and reach Ethereum finality. Safe to leave the tab open —
								don't refresh.
							</span>
							<span class="long-wait-eta">{fmtRemaining(step.startedAt)}</span>
						</aside>
					{/if}
				</div>
			</li>
		{/each}
	</ol>

	{#if transfer.error}
		<div class="error">{transfer.error}</div>
	{/if}

	{#if transfer.phase === 'done'}
		<div class="success">Done. Balances may take a moment to refresh.</div>
	{/if}
</section>

<style>
	.progress {
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text);
	}

	.amount-tag {
		font-family: var(--mono);
		font-size: 0.9rem;
		color: var(--text-muted);
	}

	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.step {
		display: grid;
		grid-template-columns: 1.5rem 1fr;
		gap: 0.75rem;
		align-items: start;
	}

	.indicator {
		font-size: 1rem;
		line-height: 1.5;
		text-align: center;
		color: var(--text-dim);
	}

	.status-done .indicator {
		color: var(--success);
	}

	.status-active .indicator {
		color: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
	}

	.status-error .indicator {
		color: var(--error);
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.label {
		color: var(--text);
	}

	.status-pending .label {
		color: var(--text-dim);
	}

	.elapsed {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--text-dim);
	}

	.detail {
		font-size: 0.85rem;
		color: var(--text-muted);
		font-family: var(--mono);
	}

	.tx-link {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.85rem;
		font-family: var(--mono);
		margin-top: 0.15rem;
	}

	.ext {
		font-family: var(--sans);
	}

	.error {
		background: color-mix(in srgb, var(--error) 15%, transparent);
		border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
		border-radius: var(--radius);
		padding: 0.75rem;
		color: var(--error);
		font-size: 0.85rem;
		font-family: var(--mono);
		word-break: break-word;
	}

	.success {
		background: color-mix(in srgb, var(--success) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
		border-radius: var(--radius);
		padding: 0.75rem;
		color: var(--success);
		font-size: 0.9rem;
	}

	.long-wait {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.5rem;
		padding: 0.75rem 0.85rem;
		background: color-mix(in srgb, var(--warning) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
		border-radius: var(--radius);
		font-size: 0.85rem;
		color: var(--text);
	}

	.long-wait strong {
		color: var(--warning);
		font-weight: 600;
	}

	.long-wait-sub {
		color: var(--text-muted);
		line-height: 1.4;
	}

	.long-wait-eta {
		font-family: var(--mono);
		font-size: 0.85rem;
		color: var(--warning);
		font-variant-numeric: tabular-nums;
	}
</style>
