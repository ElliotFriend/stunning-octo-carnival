<script lang="ts">
    // Orientation-based: the page owns the (rightChain, stellarIsSource) →
    // Direction derivation, since the right side can now be Solana or an EVM chain.
    let {
        stellarIsSource = $bindable<boolean>(true),
        otherLabel = 'EVM',
        disabled = false,
    }: {
        stellarIsSource?: boolean;
        otherLabel?: string;
        disabled?: boolean;
    } = $props();

    function flip() {
        stellarIsSource = !stellarIsSource;
    }

    let otherShort = $derived(otherLabel.split(' ')[0]);
</script>

<div class="switcher">
    <span class="from">{stellarIsSource ? 'Stellar' : otherShort}</span>
    <button class="flip" onclick={flip} {disabled} aria-label="Flip direction"> ⇄ </button>
    <span class="to">{stellarIsSource ? otherShort : 'Stellar'}</span>
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
