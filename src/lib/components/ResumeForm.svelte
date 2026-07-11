<script lang="ts">
    import type { Direction } from '$lib/config';

    let {
        direction,
        bothConnected,
        disabled,
        onResume,
    }: {
        direction: Direction;
        bothConnected: boolean;
        disabled: boolean;
        onResume: (burnHash: string) => void;
    } = $props();

    let burnHash = $state('');

    let trimmed = $derived(burnHash.trim());

    // Which chain the burn happened on, derived from the page-level direction.
    // Drives the validation hint + placeholder.
    let source = $derived<'stellar' | 'evm' | 'solana'>(
        direction === 'stellar-to-evm' || direction === 'stellar-to-solana'
            ? 'stellar'
            : direction === 'solana-to-stellar'
              ? 'solana'
              : 'evm',
    );

    // Format checks are intentionally light — Stellar tx hashes are 64 hex chars
    // (no 0x), EVM tx hashes are 0x + 64 hex, Solana signatures are base58 (~88
    // chars). Iris rejects anything it doesn't recognize when polling, so this is
    // an early-warning signal, not a security boundary.
    let formatError = $derived.by(() => {
        if (trimmed === '') return null;
        if (source === 'stellar') {
            if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
                return 'Expected a 64-character hex Stellar tx hash (no 0x prefix).';
            }
        } else if (source === 'solana') {
            if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(trimmed)) {
                return 'Expected a base58 Solana transaction signature.';
            }
        } else {
            if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
                return 'Expected a 0x-prefixed 66-character EVM tx hash.';
            }
        }
        return null;
    });

    let placeholder = $derived(
        source === 'stellar'
            ? '64-char Stellar tx hash (e.g. a1b2…)'
            : source === 'solana'
              ? 'base58 Solana signature (e.g. 5Yw…)'
              : '0x-prefixed EVM tx hash (e.g. 0xa1b2…)',
    );

    let canResume = $derived(trimmed !== '' && bothConnected && !disabled && formatError === null);

    function submit() {
        if (!canResume) return;
        onResume(trimmed);
    }
</script>

<details class="resume">
    <summary>Resume a transfer by burn hash</summary>
    <div class="body">
        <p class="blurb">
            If a previous transfer's tab closed during attestation, paste the burn transaction hash
            to pick up at attest + mint. Works for any transfer with a known hash and matching
            source domain — minting is permissionless.
        </p>
        <label class="hash-row">
            <span class="label">Burn hash</span>
            <input
                class="input"
                type="text"
                spellcheck="false"
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                {placeholder}
                bind:value={burnHash}
                {disabled}
            />
        </label>
        {#if formatError}
            <p class="format-error">{formatError}</p>
        {/if}
        <button type="button" class="submit" disabled={!canResume} onclick={submit}>
            Resume
        </button>
        {#if !bothConnected}
            <p class="hint">Connect both wallets to resume a transfer.</p>
        {/if}
    </div>
</details>

<style>
    .resume {
        background: var(--bg-elev-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        font-size: 0.9rem;
    }

    .resume > summary {
        padding: 0.6rem 0.85rem;
        cursor: pointer;
        color: var(--text-muted);
        list-style: revert;
    }

    .resume[open] > summary {
        color: var(--text);
        border-bottom: 1px solid var(--border);
    }

    .body {
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        padding: 0.85rem;
    }

    .blurb {
        margin: 0;
        color: var(--text-muted);
        font-size: 0.85rem;
        line-height: 1.4;
    }

    .hash-row {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 0.6rem;
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 0.6rem 0.85rem;
    }

    .hash-row:focus-within {
        border-color: var(--accent);
    }

    .label {
        color: var(--text-dim);
        font-size: 0.8rem;
    }

    .input {
        background: none;
        border: none;
        color: var(--text);
        font-family: var(--mono);
        font-size: 0.85rem;
        outline: none;
        min-width: 0;
        width: 100%;
    }

    .input:disabled {
        color: var(--text-dim);
    }

    .format-error {
        margin: 0;
        color: var(--error);
        font-size: 0.8rem;
    }

    .submit {
        background: var(--accent);
        color: #0b0d12;
        border: none;
        padding: 0.6rem;
        border-radius: var(--radius);
        font-weight: 600;
        font-size: 0.9rem;
        transition: background 120ms;
    }

    .submit:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .submit:disabled {
        background: var(--bg-elev);
        color: var(--text-dim);
    }

    .hint {
        margin: 0;
        text-align: center;
        color: var(--text-dim);
        font-size: 0.8rem;
    }
</style>
