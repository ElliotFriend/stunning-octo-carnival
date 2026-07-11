<script lang="ts">
    import { toHex } from 'viem';
    import { SOLANA, STELLAR, STELLAR_MAX_FEE, STANDARD_THRESHOLD } from '$lib/config';
    import { fetchBurnFee, feeBpsFor, computeMaxFee } from '$lib/circle/fees';
    import { parseUsdcStellar, formatUsdc } from '$lib/stellar/usdc';
    import { solanaAtaToBytes32 } from '$lib/stellar/recipient';
    import { shortAddr } from '$lib/utils';

    let {
        stellarAddress,
        solanaRecipient,
        amount,
    }: { stellarAddress: string; solanaRecipient: string; amount: string } = $props();

    type Parsed = { ok: true; raw: bigint } | { ok: false };
    let parsedAmount = $derived<Parsed>(
        (() => {
            const t = amount.trim();
            if (t === '') return { ok: false };
            try {
                return { ok: true, raw: parseUsdcStellar(t) };
            } catch {
                return { ok: false };
            }
        })(),
    );

    // Recipient's Solana USDC ATA as the 32-byte mint_recipient — async, so the
    // template resolves it via {#await}.
    let ataPromise = $derived(solanaAtaToBytes32(solanaRecipient));
    let feePromise = $derived(fetchBurnFee(STELLAR.domain, SOLANA.domain));

    const ZERO_BYTES_32_HEX = `0x${'0'.repeat(64)}` as const;
    const short = (a: string) => shortAddr(a, 6, 6);
</script>

<section class="burn-preview">
    <header class="head">
        <h4 class="title">Burn invocation preview</h4>
        <span class="sub"
            >What you're about to sign in Freighter, decoded into human-readable args.</span
        >
    </header>

    <div class="meta">
        <div class="meta-row">
            <span class="meta-label">Contract</span>
            <code class="meta-value" title={STELLAR.contracts.tokenMessengerMinter}>
                {short(STELLAR.contracts.tokenMessengerMinter)}
            </code>
            <span class="meta-aside">TokenMessengerMinter · deposit_for_burn</span>
        </div>
        <div class="meta-row">
            <span class="meta-label">Caller</span>
            <code class="meta-value" title={stellarAddress}>{short(stellarAddress)}</code>
            <span class="meta-aside">require_auth() — Freighter prompts for this signature.</span>
        </div>
    </div>

    <p class="flow-note">
        Two-tx flow — a separate <code>usdc.approve(...)</code> precedes this burn (skipped if allowance
        is sufficient).
    </p>

    <h5 class="section-title">Arguments</h5>
    <ul class="rows">
        <li class="row">
            <span class="arg-name">amount</span>
            <span class="arg-type">i128</span>
            {#if parsedAmount.ok}
                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                <span class="arg-note"
                    >{formatUsdc(parsedAmount.raw)} USDC (7-decimal subunits)</span
                >
            {:else}
                <span class="arg-placeholder">Enter an amount above</span>
            {/if}
        </li>
        <li class="row">
            <span class="arg-name">destination_domain</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{SOLANA.domain}</code>
            <span class="arg-note">Solana</span>
        </li>
        <li class="row wide">
            <span class="arg-name">mint_recipient</span>
            <span class="arg-type">BytesN&lt;32&gt;</span>
            {#await ataPromise then ata}
                <code class="arg-hex">{toHex(ata)}</code>
                <span class="arg-note">→ your Solana USDC ATA (owner {short(solanaRecipient)})</span
                >
            {:catch}
                <span class="arg-placeholder">Invalid Solana recipient</span>
            {/await}
        </li>
        <li class="row">
            <span class="arg-name">burn_token</span>
            <span class="arg-type">Address</span>
            <code class="arg-value" title={STELLAR.contracts.usdc}>
                {short(STELLAR.contracts.usdc)}
            </code>
            <span class="arg-note">Stellar USDC SAC</span>
        </li>
        <li class="row wide">
            <span class="arg-name">destination_caller</span>
            <span class="arg-type">BytesN&lt;32&gt;</span>
            <code class="arg-hex">{ZERO_BYTES_32_HEX}</code>
            <span class="arg-note">open — the Solana mint is permissionless.</span>
        </li>
        <li class="row">
            <span class="arg-name">max_fee</span>
            <span class="arg-type">i128</span>
            {#await feePromise then rows}
                {@const bps = feeBpsFor(rows, 'standard')}
                <code class="arg-value">
                    {computeMaxFee(
                        parsedAmount.ok ? parsedAmount.raw : 0n,
                        bps,
                        STELLAR_MAX_FEE,
                    ).toString()}
                </code>
                <span class="arg-note">{bps > 0 ? `${bps} bps + floor` : 'floor (no fee)'}</span>
            {:catch}
                <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
                <span class="arg-note">floor (fee API unavailable)</span>
            {/await}
        </li>
        <li class="row">
            <span class="arg-name">min_finality_threshold</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{STANDARD_THRESHOLD}</code>
            <span class="arg-note">standard (finalized)</span>
        </li>
    </ul>
</section>

<style>
    .burn-preview {
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
    .meta {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        padding: 0.5rem 0.6rem;
        background: var(--bg);
        border-radius: var(--radius);
    }
    .meta-row {
        display: grid;
        grid-template-columns: max-content max-content 1fr;
        align-items: baseline;
        gap: 0.5rem;
    }
    .meta-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .meta-value {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text);
    }
    .meta-aside {
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.4;
    }
    .flow-note {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.4;
    }
    .flow-note code {
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text);
    }
    .section-title {
        margin: 0.2rem 0 0;
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
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
        grid-template-columns: max-content max-content 1fr;
        align-items: baseline;
        gap: 0.2rem 0.6rem;
        padding: 0.4rem 0.5rem;
        background: var(--bg);
        border-radius: var(--radius);
        border-left: 2px solid var(--accent);
    }
    .row.wide {
        grid-template-columns: max-content max-content;
    }
    .arg-name {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text);
        font-weight: 500;
    }
    .arg-type {
        font-family: var(--mono);
        font-size: 0.72rem;
        color: var(--accent);
        font-weight: 600;
    }
    .arg-value {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text);
        word-break: break-all;
        justify-self: end;
    }
    .arg-note {
        grid-column: 1 / -1;
        font-size: 0.75rem;
        color: var(--text-muted);
        line-height: 1.4;
    }
    .arg-placeholder {
        grid-column: 3 / -1;
        font-size: 0.75rem;
        color: var(--text-dim);
        font-style: italic;
        justify-self: end;
    }
    .arg-hex {
        grid-column: 1 / -1;
        font-family: var(--mono);
        font-size: 0.75rem;
        color: var(--text);
        word-break: break-all;
        overflow-x: auto;
    }
</style>
