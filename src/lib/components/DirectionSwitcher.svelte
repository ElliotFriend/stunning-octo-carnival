<script lang="ts">
    import type { Direction } from '$lib/config';

    let {
        direction = $bindable<Direction>('stellar-to-evm'),
        evmLabel = 'EVM',
        disabled = false,
    }: { direction?: Direction; evmLabel?: string; disabled?: boolean } = $props();

    function flip() {
        direction = direction === 'stellar-to-evm' ? 'evm-to-stellar' : 'stellar-to-evm';
    }

    let evmShort = $derived(evmLabel.split(' ')[0]);
</script>

<div class="switcher">
    <span class="from">
        {direction === 'stellar-to-evm' ? 'Stellar' : evmShort}
    </span>
    <button class="flip" onclick={flip} {disabled} aria-label="Flip direction"> ⇄ </button>
    <span class="to">
        {direction === 'stellar-to-evm' ? evmShort : 'Stellar'}
    </span>
</div>

<style>
    .switcher {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        font-size: 1.1rem;
        font-weight: 500;
    }

    .from,
    .to {
        color: var(--text-muted);
    }

    .flip {
        background: var(--bg-elev-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        border-radius: 999px;
        width: 2.25rem;
        height: 2.25rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 1.1rem;
        transition: all 120ms;
    }

    .flip:hover:not(:disabled) {
        background: var(--accent-dim);
        border-color: var(--accent);
        color: var(--accent-hover);
    }
</style>
