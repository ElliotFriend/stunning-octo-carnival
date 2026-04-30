<script lang="ts">
    import { encodeStellarForwarderHookData } from '$lib/evm/cctp';

    let { stellarRecipient }: { stellarRecipient: string } = $props();

    type Encoded = { ok: true; hex: string } | { ok: false; error: string };

    // encodeStellarForwarderHookData throws on invalid strkeys; surface that
    // as a typed result so the template can render an error state instead.
    let encoded = $derived<Encoded>(
        (() => {
            try {
                return { ok: true, hex: encodeStellarForwarderHookData(stellarRecipient) };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        })(),
    );

    // Each row spans a byte range; the slice into the hex string is
    // `2 + start*2` to `2 + end*2 + 2` (the leading `0x` plus 2 chars per byte).
    type Row = { label: string; range: string; hex: string };

    function sliceBytes(hex: string, startByte: number, endByte: number): string {
        // hex starts with '0x'; each byte is 2 hex chars. endByte is exclusive.
        const a = 2 + startByte * 2;
        const b = 2 + endByte * 2;
        return hex.slice(a, b);
    }

    function buildRows(hex: string): Row[] {
        const totalBytes = (hex.length - 2) / 2;
        return [
            {
                label: 'magic prefix (Circle-reserved zeros)',
                range: '0–23',
                hex: sliceBytes(hex, 0, 24),
            },
            {
                label: 'version (uint32)',
                range: '24–27',
                hex: sliceBytes(hex, 24, 28),
            },
            {
                label: 'recipient strkey length (uint32)',
                range: '28–31',
                hex: sliceBytes(hex, 28, 32),
            },
            {
                label: 'recipient strkey (UTF-8)',
                range: `32–${totalBytes - 1}`,
                hex: sliceBytes(hex, 32, totalBytes),
            },
        ];
    }

    let rows = $derived(encoded.ok ? buildRows(encoded.hex) : []);
</script>

<section class="hook-preview">
    <header class="head">
        <h4 class="title">Hook data preview</h4>
        <span class="sub">
            Encoded routing instructions appended to the burn — tells the Stellar forwarder where to
            deliver the freshly minted USDC.
        </span>
    </header>

    {#if encoded.ok}
        <code class="full-hex">{encoded.hex}</code>
        <ul class="rows">
            {#each rows as row (row.range)}
                <li class="row">
                    <span class="range">bytes {row.range}</span>
                    <span class="label">{row.label}</span>
                    <code class="hex">{row.hex}</code>
                </li>
            {/each}
        </ul>
    {:else}
        <p class="error">Couldn't encode hook data: {encoded.error}</p>
    {/if}
</section>

<style>
    .hook-preview {
        background: var(--bg-elev-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }

    .head {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }

    .title {
        margin: 0;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text);
    }

    .sub {
        font-size: 0.8rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .full-hex {
        display: block;
        padding: 0.5rem;
        background: var(--bg);
        border-radius: var(--radius);
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text-muted);
        word-break: break-all;
        overflow-x: auto;
    }

    .rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .row {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.2rem 0.75rem;
        padding: 0.4rem 0.5rem;
        background: var(--bg);
        border-radius: var(--radius);
        border-left: 2px solid var(--accent);
    }

    .range {
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--accent);
        font-weight: 600;
    }

    .label {
        font-size: 0.78rem;
        color: var(--text-muted);
    }

    .row .hex {
        grid-column: 1 / -1;
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text);
        word-break: break-all;
        overflow-x: auto;
    }

    .error {
        margin: 0;
        color: var(--error);
        font-size: 0.8rem;
        font-family: var(--mono);
        word-break: break-word;
    }
</style>
