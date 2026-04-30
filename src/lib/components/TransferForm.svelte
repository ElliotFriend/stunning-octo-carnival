<script lang="ts">
	import type { Direction } from '$lib/config';

	let {
		direction,
		amount = $bindable<string>(''),
		disabled = false,
		busy = false,
		canSubmit,
		onsubmit
	}: {
		direction: Direction;
		amount?: string;
		disabled?: boolean;
		busy?: boolean;
		canSubmit: boolean;
		onsubmit: () => void;
	} = $props();

	function handle(e: Event) {
		e.preventDefault();
		if (canSubmit && !busy) onsubmit();
	}

	let buttonLabel = $derived(
		busy
			? 'Working…'
			: direction === 'stellar-to-base'
				? 'Send Stellar → Base'
				: 'Send Base → Stellar'
	);
</script>

<form class="form" onsubmit={handle}>
	<label class="amount-row">
		<span class="label">Amount</span>
		<input
			class="input"
			type="text"
			inputmode="decimal"
			placeholder="0.00"
			bind:value={amount}
			{disabled}
			autocomplete="off"
		/>
		<span class="symbol">USDC</span>
	</label>
	<button type="submit" class="submit" disabled={!canSubmit || busy}>
		{buttonLabel}
	</button>
</form>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.amount-row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.6rem;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
	}

	.amount-row:focus-within {
		border-color: var(--accent);
	}

	.label {
		color: var(--text-dim);
		font-size: 0.85rem;
	}

	.input {
		background: none;
		border: none;
		color: var(--text);
		font-size: 1.4rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		outline: none;
		min-width: 0;
		width: 100%;
	}

	.input:disabled {
		color: var(--text-dim);
	}

	.symbol {
		color: var(--text-muted);
		font-weight: 500;
	}

	.submit {
		background: var(--accent);
		color: #0b0d12;
		border: none;
		padding: 0.85rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 1rem;
		transition: background 120ms;
	}

	.submit:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.submit:disabled {
		background: var(--bg-elev-2);
		color: var(--text-dim);
	}
</style>
