<script lang="ts">
    import { onDestroy } from 'svelte';
    import { EVM_CHAINS } from '$lib/config';
    import { shortAddr } from '$lib/utils';
    import type { TransferState } from '$lib/stores/transfer.svelte';

    let { transfer }: { transfer: TransferState } = $props();

    // Drive a 1s tick so elapsed timers update without depending on the store.
    let now = $state(Date.now());
    let tick = setInterval(() => (now = Date.now()), 1000);
    onDestroy(() => clearInterval(tick));

    let longWaitEtaMs = $derived(
        transfer.direction === 'evm-to-stellar'
            ? EVM_CHAINS[transfer.evmChainId].attestationEtaMs
            : undefined,
    );
    let longWaitChainLabel = $derived(EVM_CHAINS[transfer.evmChainId].label);

    function fmtElapsed(s: { startedAt?: number; endedAt?: number }): string | null {
        if (!s.startedAt) return null;
        const end = s.endedAt ?? now;
        const sec = Math.round((end - s.startedAt) / 1000);
        if (sec < 60) return `${sec}s`;
        const m = Math.floor(sec / 60);
        const r = sec % 60;
        return `${m}m ${r.toString().padStart(2, '0')}s`;
    }

    function fmtRemaining(startedAt: number, etaMs: number): string {
        const elapsed = now - startedAt;
        const remaining = etaMs - elapsed;
        if (remaining <= 0) return 'any moment now';
        const m = Math.ceil(remaining / 60_000);
        return `~${m} min remaining`;
    }

    function isLongWait(stepKey: string, status: string) {
        return stepKey === 'attest' && status === 'active' && longWaitEtaMs !== undefined;
    }

    // Top-level fields from IrisMessage we always want to show, even if they
    // also appear in decodedMessage.
    const TOP_LEVEL_KEYS = [
        'cctpVersion',
        'sourceDomain',
        'destinationDomain',
        'eventNonce',
        // Forwarding-service lifecycle + attestation-delay reason. Present on
        // forwarding transfers (and delayReason on any delayed attestation);
        // skipped when absent/null so they add no noise to other flows.
        'delayReason',
        'forwardState',
        'forwardTxHash',
    ] as const;

    function isPlainObject(v: unknown): v is Record<string, unknown> {
        return typeof v === 'object' && v !== null && !Array.isArray(v);
    }

    function fmtValue(v: unknown): string {
        if (v === null || v === undefined) return String(v);
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            return String(v);
        }
        if (typeof v === 'bigint') return v.toString();
        try {
            return JSON.stringify(v);
        } catch {
            return String(v);
        }
    }

    type Row = { key: string; value: unknown };

    // Merge top-level IrisMessage fields with the decoded message fields,
    // de-duplicating by key (top-level wins). Plain array for the seen-set
    // since the lint rule discourages `Set` here and the list is tiny.
    function attestationRows(attestation: NonNullable<typeof transfer.attestation>): Row[] {
        const rows: Row[] = [];
        const seen: string[] = [];
        for (const k of TOP_LEVEL_KEYS) {
            const v = attestation[k];
            if (v === undefined || v === null) continue;
            rows.push({ key: k, value: v });
            seen.push(k);
        }
        const decoded = attestation.decodedMessage;
        if (decoded) {
            for (const [k, v] of Object.entries(decoded)) {
                if (seen.includes(k)) continue;
                rows.push({ key: k, value: v });
            }
        }
        return rows;
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
                        <a
                            class="tx-link"
                            href={step.hashUrl}
                            target="_blank"
                            rel="external noreferrer"
                        >
                            <code>{shortAddr(step.hash, 8, 6)}</code>
                            <span class="ext">↗</span>
                        </a>
                    {/if}
                    {#if isLongWait(step.key, step.status) && step.startedAt && longWaitEtaMs !== undefined}
                        <aside class="long-wait">
                            <strong>
                                This step usually takes about {Math.round(longWaitEtaMs / 60_000)} minutes.
                            </strong>
                            <span class="long-wait-sub">
                                Circle's attesters wait for {longWaitChainLabel}'s batch to settle
                                and reach finality on its parent chain. Safe to leave the tab open —
                                don't refresh.
                            </span>
                            <span class="long-wait-eta"
                                >{fmtRemaining(step.startedAt, longWaitEtaMs)}</span
                            >
                        </aside>
                    {/if}
                    {#if step.key === 'attest' && transfer.attestation}
                        <details class="cctp-msg">
                            <summary>CCTP message</summary>
                            <div class="cctp-msg-body">
                                <p class="cctp-msg-blurb">
                                    This is the CCTP message Circle's attesters signed. The
                                    destination contract verifies the signature, then mints the new
                                    USDC.
                                </p>
                                <dl class="cctp-msg-fields">
                                    {#each attestationRows(transfer.attestation) as row (row.key)}
                                        <dt>{row.key}</dt>
                                        <dd>
                                            {#if isPlainObject(row.value)}
                                                <details class="nested">
                                                    <summary>object</summary>
                                                    <pre>{JSON.stringify(row.value, null, 2)}</pre>
                                                </details>
                                            {:else}
                                                <code>{fmtValue(row.value)}</code>
                                            {/if}
                                        </dd>
                                    {/each}
                                </dl>
                                <details class="raw">
                                    <summary>raw message (hex)</summary>
                                    <code class="hex">{transfer.attestation.message}</code>
                                </details>
                                <details class="raw">
                                    <summary>raw attestation (hex)</summary>
                                    <code class="hex">{transfer.attestation.attestation}</code>
                                </details>
                            </div>
                        </details>
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
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.4;
        }
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

    .cctp-msg {
        margin-top: 0.5rem;
        background: var(--bg-elev-2);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        font-size: 0.85rem;
    }

    .cctp-msg > summary {
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        color: var(--text-muted);
        list-style: revert; /* keep the native disclosure triangle */
    }

    .cctp-msg[open] > summary {
        color: var(--text);
        border-bottom: 1px solid var(--border);
    }

    .cctp-msg-body {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        padding: 0.75rem;
    }

    .cctp-msg-blurb {
        margin: 0;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .cctp-msg-fields {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.25rem 0.75rem;
        margin: 0;
    }

    .cctp-msg-fields dt {
        color: var(--text-dim);
        font-family: var(--mono);
        font-size: 0.8rem;
    }

    .cctp-msg-fields dd {
        margin: 0;
        min-width: 0;
    }

    .cctp-msg-fields code {
        font-family: var(--mono);
        font-size: 0.8rem;
        color: var(--text);
        word-break: break-all;
    }

    .nested,
    .raw {
        font-size: 0.8rem;
    }

    .nested > summary,
    .raw > summary {
        cursor: pointer;
        color: var(--text-muted);
        list-style: revert;
    }

    .nested pre {
        margin: 0.4rem 0 0;
        padding: 0.5rem;
        background: var(--bg);
        border-radius: var(--radius);
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text);
        overflow-x: auto;
    }

    .hex {
        display: block;
        margin-top: 0.4rem;
        padding: 0.5rem;
        background: var(--bg);
        border-radius: var(--radius);
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text);
        word-break: break-all;
        overflow-x: auto;
    }
</style>
