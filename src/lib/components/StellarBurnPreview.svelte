<script lang="ts">
    import { pad, toHex } from 'viem';
    import {
        EVM_CHAINS,
        SOLANA,
        STELLAR,
        STELLAR_MAX_FEE,
        type EvmChainId,
        type OutboundFlow,
        type TransferSpeed,
    } from '$lib/config';
    import {
        fetchBurnFee,
        feeBpsFor,
        thresholdFor,
        computeMaxFee,
        fetchForwardFee,
        forwardedMaxFeeStellar,
    } from '$lib/circle/fees';
    import { CCTP_FORWARD_MAGIC, encodeCctpForwardHookData } from '$lib/stellar/cctp';
    import { solanaAtaToBytes32 } from '$lib/stellar/recipient';
    import { parseUsdcStellar, formatUsdc } from '$lib/stellar/usdc';
    import { shortAddr } from '$lib/utils';

    // The stellar-source burn preview, reused for either destination. Pass EVM
    // fields for a Stellar→EVM burn, or `solanaRecipient` (a Solana owner
    // address) for a Stellar→Solana burn — the two are mutually exclusive.
    let {
        stellarAddress,
        evmRecipient,
        evmChainId,
        solanaRecipient,
        amount,
        outboundFlow,
        forwarding,
        speed,
    }: {
        stellarAddress: string;
        evmRecipient?: `0x${string}`;
        evmChainId?: EvmChainId;
        solanaRecipient?: string;
        amount: string;
        outboundFlow: OutboundFlow;
        forwarding: boolean;
        speed: TransferSpeed;
    } = $props();

    let toSolana = $derived(!!solanaRecipient);

    type Parsed = { ok: true; raw: bigint } | { ok: false };

    // parseUsdcStellar throws on invalid input; surface as a typed result so the
    // template can show a placeholder for empty/invalid values without rendering
    // an error.
    let parsedAmount = $derived<Parsed>(
        (() => {
            const trimmed = amount.trim();
            if (trimmed === '') return { ok: false };
            try {
                return { ok: true, raw: parseUsdcStellar(trimmed) };
            } catch {
                return { ok: false };
            }
        })(),
    );

    // EVM-only chain config — undefined for a Solana destination. Every read is
    // guarded by `toSolana` (template + deriveds) so it never indexes with undefined.
    let chain = $derived(toSolana ? undefined : EVM_CHAINS[evmChainId!]);

    // Destination domain: Solana (5) or the selected EVM chain's domain.
    let destDomain = $derived(toSolana ? SOLANA.domain : EVM_CHAINS[evmChainId!].domain);
    // Route-keyed fee promise — re-runs when the route changes, NOT per keystroke.
    let feePromise = $derived(fetchBurnFee(STELLAR.domain, destDomain));
    let threshold = $derived(thresholdFor(speed));

    // Wrapper + forwarding shapes apply to either destination (the wrapper burns
    // to any domain; the forwarding hook is dest-agnostic).
    let isWrapper = $derived(outboundFlow === 'wrapper');
    let isForwarding = $derived(forwarding);

    let contractAddress = $derived(
        isWrapper ? STELLAR.contracts.bridgeWrapper : STELLAR.contracts.tokenMessengerMinter,
    );
    let contractLabel = $derived(
        isWrapper ? 'CctpWrapper (user-deployed)' : 'TokenMessengerMinter',
    );
    // Inner burn call the wrapper makes (also the auth-tree function name).
    let innerBurnFn = $derived(isForwarding ? 'deposit_for_burn_with_hook' : 'deposit_for_burn');
    let functionName = $derived(
        isWrapper
            ? isForwarding
                ? 'approve_and_deposit_with_hook'
                : 'approve_and_deposit'
            : innerBurnFn,
    );

    // Forwarding maxFee comes from the ?forward=true quote (protocol fee +
    // forwarding service fee), keyed by route (works for the Solana dest too).
    let forwardFeePromise = $derived(fetchForwardFee(STELLAR.domain, destDomain));

    // The exact 32-byte hookData submitted on-chain, rendered as hex — single
    // source of truth is the encoder in cctp.ts.
    const hookDataHex = toHex(encodeCctpForwardHookData());

    // mint_recipient (32 bytes): an EVM address left-padded to 32, OR — for a
    // Solana destination — the recipient's Solana USDC ATA (async; resolved via
    // {#await} in the template).
    let mintRecipientHex = $derived(evmRecipient ? pad(evmRecipient, { size: 32 }) : undefined);
    let solanaAtaPromise = $derived(solanaRecipient ? solanaAtaToBytes32(solanaRecipient) : null);

    // 32 zero bytes signals "open" — anyone can call receiveMessage on the
    // destination. Restricting it to a specific caller is a different mode we
    // don't expose in the demo.
    const ZERO_BYTES_32_HEX = `0x${'0'.repeat(64)}` as const;

    // G-addresses and Soroban C-contracts are 56 chars; show 6+6 trimmed.
    const shortStrkey = (a: string) => shortAddr(a, 6, 6);
    const shortContract = (a: string) => shortAddr(a, 6, 6);
</script>

<section class="burn-preview">
    <header class="head">
        <h4 class="title">Burn invocation preview</h4>
        <span class="sub">
            What you're about to sign in Freighter, decoded into human-readable args.
        </span>
    </header>

    <div class="meta">
        <div class="meta-row">
            <span class="meta-label">Contract</span>
            <code class="meta-value" title={contractAddress}>{shortContract(contractAddress)}</code>
            <span class="meta-aside">{contractLabel}</span>
        </div>
        <div class="meta-row">
            <span class="meta-label">Function</span>
            <code class="meta-value">{functionName}</code>
        </div>
        <div class="meta-row">
            <span class="meta-label">Caller</span>
            <code class="meta-value" title={stellarAddress}>{shortStrkey(stellarAddress)}</code>
            <span class="meta-aside">
                require_auth() on this address — Freighter prompts the user for this signature.
            </span>
        </div>
    </div>

    {#if isWrapper}
        <p class="flow-note">
            Wrapper flow — one Soroban tx, one Freighter prompt. Soroban's auth tree authorizes the
            two inner calls below (<code>approve</code> + <code>{innerBurnFn}</code>) from this
            single signature.
        </p>
    {:else}
        <p class="flow-note">
            Two-tx flow — a separate <code>usdc.approve(...)</code> precedes this burn (skipped if allowance
            is sufficient).
        </p>
    {/if}
    {#if isForwarding}
        <p class="flow-note">
            Forwarding on (experimental) — the <code>hook_data</code> below tags the burn for Circle's
            forwarding relayer, which auto-mints on the destination and deducts its fee from the minted
            USDC (no destination gas from you).
        </p>
    {/if}

    <h5 class="section-title">Arguments</h5>
    <ul class="rows">
        {#if isWrapper}
            <li class="row">
                <span class="arg-name">usdc</span>
                <span class="arg-type">Address</span>
                <code class="arg-value" title={STELLAR.contracts.usdc}>
                    {shortContract(STELLAR.contracts.usdc)}
                </code>
                <span class="arg-note"
                    >Stellar USDC SAC — passed through to inner approve/burn.</span
                >
            </li>
            <li class="row">
                <span class="arg-name">tmm</span>
                <span class="arg-type">Address</span>
                <code class="arg-value" title={STELLAR.contracts.tokenMessengerMinter}>
                    {shortContract(STELLAR.contracts.tokenMessengerMinter)}
                </code>
                <span class="arg-note">TokenMessengerMinter — invoked by the wrapper.</span>
            </li>
        {/if}

        <li class="row">
            <span class="arg-name">caller</span>
            <span class="arg-type">Address</span>
            <code class="arg-value" title={stellarAddress}>{shortStrkey(stellarAddress)}</code>
        </li>

        <li class="row">
            <span class="arg-name">amount</span>
            <span class="arg-type">i128</span>
            {#if parsedAmount.ok}
                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                <span class="arg-note">
                    {formatUsdc(parsedAmount.raw)} USDC (Stellar 7-decimal subunits)
                </span>
            {:else}
                <span class="arg-placeholder">Enter an amount above</span>
            {/if}
        </li>

        <li class="row">
            <span class="arg-name">destination_domain</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{destDomain}</code>
            <span class="arg-note">{toSolana ? 'Solana' : chain?.label}</span>
        </li>

        <li class="row wide">
            <span class="arg-name">mint_recipient</span>
            <span class="arg-type">BytesN&lt;32&gt;</span>
            {#if toSolana}
                {#await solanaAtaPromise then ata}
                    <code class="arg-hex">{ata ? toHex(ata) : ''}</code>
                    <span class="arg-note"
                        >→ your Solana USDC ATA (owner {shortStrkey(solanaRecipient ?? '')})</span
                    >
                {:catch}
                    <span class="arg-placeholder">Invalid Solana recipient</span>
                {/await}
            {:else}
                <code class="arg-hex">{mintRecipientHex}</code>
                <span class="arg-note">→ {evmRecipient} on {chain?.label}</span>
            {/if}
        </li>

        <li class="row">
            <span class="arg-name">burn_token</span>
            <span class="arg-type">Address</span>
            <code class="arg-value" title={STELLAR.contracts.usdc}>
                {shortContract(STELLAR.contracts.usdc)}
            </code>
            <span class="arg-note">Stellar USDC SAC</span>
        </li>

        <li class="row wide">
            <span class="arg-name">destination_caller</span>
            <span class="arg-type">BytesN&lt;32&gt;</span>
            <code class="arg-hex">{ZERO_BYTES_32_HEX}</code>
            <span class="arg-note">
                open — any address can call receiveMessage on the destination.
            </span>
        </li>

        <li class="row">
            <span class="arg-name">max_fee</span>
            <span class="arg-type">i128</span>
            {#if isForwarding}
                {#await forwardFeePromise then rows}
                    <code class="arg-value">
                        {forwardedMaxFeeStellar(
                            rows,
                            speed,
                            parsedAmount.ok ? parsedAmount.raw : 0n,
                        ).toString()}
                    </code>
                    <span class="arg-note">
                        protocol fee + Circle forwarding fee — deducted from the minted USDC.
                    </span>
                {:catch}
                    <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
                    <span class="arg-note">floor (forward fee API unavailable)</span>
                {/await}
            {:else}
                {#await feePromise then rows}
                    {@const bps = feeBpsFor(rows, speed)}
                    <code class="arg-value">
                        {parsedAmount.ok
                            ? computeMaxFee(parsedAmount.raw, bps, STELLAR_MAX_FEE).toString()
                            : computeMaxFee(0n, bps, STELLAR_MAX_FEE).toString()}
                    </code>
                    <span class="arg-note">
                        {bps > 0 ? `${bps} bps fast fee + floor` : 'floor (no fee at this speed)'}
                    </span>
                {:catch}
                    <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
                    <span class="arg-note">floor (fee API unavailable)</span>
                {/await}
            {/if}
        </li>

        <li class="row">
            <span class="arg-name">min_finality_threshold</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{threshold}</code>
            <span class="arg-note">
                finalized — Stellar finalizes in seconds and always attests at {threshold} regardless
                of this value, so Fast Transfer (mint-before-finality) is N/A as a source.
            </span>
        </li>

        {#if isForwarding}
            <li class="row wide">
                <span class="arg-name">hook_data</span>
                <span class="arg-type">Bytes</span>
                <code class="arg-hex">{hookDataHex}</code>
                <span class="arg-note">
                    32 bytes — ascii "{CCTP_FORWARD_MAGIC}" (bytes 0–23) + u32 version 0 + u32
                    length 0. The magic Circle's forwarding relayer watches for.
                </span>
            </li>
        {/if}
    </ul>

    {#if isWrapper}
        <details class="auth-tree" open>
            <summary>Auth tree (one signature, two authorized inner calls)</summary>
            <ol class="auth-list">
                <li class="auth-call">
                    <div class="auth-head">
                        <code class="auth-target" title={STELLAR.contracts.usdc}>
                            {shortContract(STELLAR.contracts.usdc)}
                        </code>
                        <span class="auth-dot">·</span>
                        <code class="auth-fn">approve</code>
                    </div>
                    <ul class="auth-args">
                        <li>
                            <span class="arg-name">from</span>
                            <span class="arg-type">Address</span>
                            <code class="arg-value" title={stellarAddress}>
                                {shortStrkey(stellarAddress)}
                            </code>
                            <span class="arg-note">caller</span>
                        </li>
                        <li>
                            <span class="arg-name">spender</span>
                            <span class="arg-type">Address</span>
                            <code class="arg-value" title={STELLAR.contracts.tokenMessengerMinter}>
                                {shortContract(STELLAR.contracts.tokenMessengerMinter)}
                            </code>
                            <span class="arg-note">tmm</span>
                        </li>
                        <li>
                            <span class="arg-name">amount</span>
                            <span class="arg-type">i128</span>
                            {#if parsedAmount.ok}
                                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                                <span class="arg-note">{formatUsdc(parsedAmount.raw)} USDC</span>
                            {:else}
                                <span class="arg-placeholder">Enter an amount above</span>
                            {/if}
                        </li>
                        <li>
                            <span class="arg-name">expiration_ledger</span>
                            <span class="arg-type">u32</span>
                            <span class="arg-placeholder">
                                computed in-contract: (sequence + 50).next_multiple_of(50)
                            </span>
                        </li>
                    </ul>
                </li>

                <li class="auth-call">
                    <div class="auth-head">
                        <code class="auth-target" title={STELLAR.contracts.tokenMessengerMinter}>
                            {shortContract(STELLAR.contracts.tokenMessengerMinter)}
                        </code>
                        <span class="auth-dot">·</span>
                        <code class="auth-fn">{innerBurnFn}</code>
                    </div>
                    <ul class="auth-args">
                        <li>
                            <span class="arg-name">caller</span>
                            <span class="arg-type">Address</span>
                            <code class="arg-value" title={stellarAddress}>
                                {shortStrkey(stellarAddress)}
                            </code>
                        </li>
                        <li>
                            <span class="arg-name">amount</span>
                            <span class="arg-type">i128</span>
                            {#if parsedAmount.ok}
                                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                                <span class="arg-note">{formatUsdc(parsedAmount.raw)} USDC</span>
                            {:else}
                                <span class="arg-placeholder">Enter an amount above</span>
                            {/if}
                        </li>
                        <li>
                            <span class="arg-name">destination_domain</span>
                            <span class="arg-type">u32</span>
                            <code class="arg-value">{destDomain}</code>
                            <span class="arg-note">{toSolana ? 'Solana' : chain?.label}</span>
                        </li>
                        <li class="wide">
                            <span class="arg-name">mint_recipient</span>
                            <span class="arg-type">BytesN&lt;32&gt;</span>
                            {#if toSolana}
                                {#await solanaAtaPromise then ata}
                                    <code class="arg-hex">{ata ? toHex(ata) : ''}</code>
                                    <span class="arg-note">→ your Solana USDC ATA</span>
                                {/await}
                            {:else}
                                <code class="arg-hex">{mintRecipientHex}</code>
                                <span class="arg-note">→ {evmRecipient}</span>
                            {/if}
                        </li>
                        <li>
                            <span class="arg-name">burn_token</span>
                            <span class="arg-type">Address</span>
                            <code class="arg-value" title={STELLAR.contracts.usdc}>
                                {shortContract(STELLAR.contracts.usdc)}
                            </code>
                            <span class="arg-note">usdc</span>
                        </li>
                        <li class="wide">
                            <span class="arg-name">destination_caller</span>
                            <span class="arg-type">BytesN&lt;32&gt;</span>
                            <code class="arg-hex">{ZERO_BYTES_32_HEX}</code>
                            <span class="arg-note">open</span>
                        </li>
                        <li>
                            <span class="arg-name">max_fee</span>
                            <span class="arg-type">i128</span>
                            {#if isForwarding}
                                {#await forwardFeePromise then rows}
                                    <code class="arg-value">
                                        {forwardedMaxFeeStellar(
                                            rows,
                                            speed,
                                            parsedAmount.ok ? parsedAmount.raw : 0n,
                                        ).toString()}
                                    </code>
                                {:catch}
                                    <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
                                {/await}
                            {:else}
                                {#await feePromise then rows}
                                    {@const bps = feeBpsFor(rows, speed)}
                                    <code class="arg-value">
                                        {parsedAmount.ok
                                            ? computeMaxFee(
                                                  parsedAmount.raw,
                                                  bps,
                                                  STELLAR_MAX_FEE,
                                              ).toString()
                                            : computeMaxFee(0n, bps, STELLAR_MAX_FEE).toString()}
                                    </code>
                                {:catch}
                                    <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
                                {/await}
                            {/if}
                        </li>
                        <li>
                            <span class="arg-name">min_finality_threshold</span>
                            <span class="arg-type">u32</span>
                            <code class="arg-value">{threshold}</code>
                            <span class="arg-note">{speed === 'fast' ? 'fast' : 'finalized'}</span>
                        </li>
                        {#if isForwarding}
                            <li class="wide">
                                <span class="arg-name">hook_data</span>
                                <span class="arg-type">Bytes</span>
                                <code class="arg-hex">{hookDataHex}</code>
                                <span class="arg-note">ascii "{CCTP_FORWARD_MAGIC}" magic</span>
                            </li>
                        {/if}
                    </ul>
                </li>
            </ol>
        </details>
    {/if}
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

    .row.wide,
    .auth-args li.wide {
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

    .auth-tree {
        margin-top: 0.25rem;
        background: var(--bg);
        border-radius: var(--radius);
        padding: 0.5rem 0.6rem;
        border-left: 2px solid var(--accent);
    }

    .auth-tree summary {
        cursor: pointer;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text);
        list-style: none;
    }

    .auth-tree summary::-webkit-details-marker {
        display: none;
    }

    .auth-tree summary::before {
        content: '▸';
        display: inline-block;
        width: 1em;
        color: var(--text-muted);
        transition: transform 120ms;
    }

    .auth-tree[open] summary::before {
        transform: rotate(90deg);
    }

    .auth-list {
        list-style: none;
        margin: 0.5rem 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .auth-call {
        border-left: 2px solid var(--border-strong);
        padding: 0.3rem 0 0.3rem 0.6rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .auth-head {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        flex-wrap: wrap;
    }

    .auth-target {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text-muted);
    }

    .auth-dot {
        color: var(--text-dim);
    }

    .auth-fn {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text);
        font-weight: 600;
    }

    .auth-args {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .auth-args li {
        display: grid;
        grid-template-columns: max-content max-content 1fr;
        align-items: baseline;
        gap: 0.2rem 0.5rem;
        padding: 0.25rem 0.4rem;
        background: var(--bg-elev-2);
        border-radius: var(--radius);
    }
</style>
