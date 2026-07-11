<script lang="ts">
    import type { TransferSpeed } from '$lib/config';

    let {
        otherLabel = 'EVM',
        stellarIsSource = true,
        fastAllowed = false,
        amount = $bindable<string>(''),
        speed = $bindable<TransferSpeed>('standard'),
        disabled = false,
        busy = false,
        canSubmit,
        onsubmit,
    }: {
        otherLabel?: string;
        stellarIsSource?: boolean;
        // Whether Fast Transfer applies to the current route (only when a
        // non-Solana chain is the source). Stellar-source and any Solana route
        // are Standard-only.
        fastAllowed?: boolean;
        amount?: string;
        speed?: TransferSpeed;
        disabled?: boolean;
        busy?: boolean;
        canSubmit: boolean;
        onsubmit: () => void;
    } = $props();

    function handle(e: Event) {
        e.preventDefault();
        if (canSubmit && !busy) onsubmit();
    }

    let otherShort = $derived(otherLabel.split(' ')[0]);
    let buttonLabel = $derived(
        busy
            ? 'Working…'
            : stellarIsSource
              ? `Send Stellar → ${otherShort}`
              : `Send ${otherShort} → Stellar`,
    );

    let etaCaption = $derived(
        !fastAllowed
            ? 'Standard only — Fast Transfer (mint-before-finality) is not available for this route.'
            : speed === 'fast'
              ? 'Fast: mint before finality — Circle charges a basis-point fee.'
              : 'Standard: wait for source-chain finality — no fee.',
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

    <div class="speed-picker" role="tablist" aria-label="Transfer speed">
        <span class="speed-label">Speed</span>
        <div class="speed-buttons">
            <button
                type="button"
                class="chip"
                class:active={!fastAllowed || speed === 'standard'}
                {disabled}
                onclick={() => (speed = 'standard')}
                role="tab"
                aria-selected={!fastAllowed || speed === 'standard'}
                title="Wait for source-chain finality — no fee"
            >
                Standard
            </button>
            <button
                type="button"
                class="chip"
                class:active={fastAllowed && speed === 'fast'}
                disabled={disabled || !fastAllowed}
                onclick={() => (speed = 'fast')}
                role="tab"
                aria-selected={fastAllowed && speed === 'fast'}
                title={fastAllowed
                    ? 'Mint before finality — Circle charges a basis-point fee'
                    : 'Not available for this route — the source finalizes with no pre-finality window'}
            >
                Fast
            </button>
        </div>
        <span class="speed-eta">{etaCaption}</span>
    </div>

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

    .speed-picker {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border);
    }

    .speed-label {
        font-size: 0.7rem;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .speed-buttons {
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

    .speed-eta {
        font-size: 0.72rem;
        color: var(--text-dim);
        line-height: 1.4;
    }
</style>
