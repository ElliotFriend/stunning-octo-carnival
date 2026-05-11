<script lang="ts">
    import {
        EVM_CCTP_CONTRACTS,
        EVM_CHAINS,
        EVM_MAX_FEE,
        FINALIZED_THRESHOLD,
        STELLAR,
        type EvmChainId,
        type InboundFlow,
    } from '$lib/config';
    import { encodeStellarForwarderHookData, strkeyToBytes32 } from '$lib/evm/cctp';
    import {
        fetchUsdcEip712Domain,
        formatEvmUsdc,
        parseEvmUsdc,
        type EvmUsdcEip712Domain,
    } from '$lib/evm/usdc';
    import type { SendCallsCapability } from '$lib/evm/capabilities';
    import { shortAddr } from '$lib/utils';

    let {
        evmAddress,
        evmChainId,
        stellarRecipient,
        amount,
        inboundFlow,
        sendCallsCap,
    }: {
        evmAddress: `0x${string}`;
        evmChainId: EvmChainId;
        stellarRecipient: string;
        amount: string;
        inboundFlow: InboundFlow;
        sendCallsCap: SendCallsCapability;
    } = $props();

    let cfg = $derived(EVM_CHAINS[evmChainId]);

    type Parsed = { ok: true; raw: bigint } | { ok: false };

    // parseEvmUsdc throws on invalid input; surface as a typed result so the
    // template can show a placeholder for empty/invalid values without
    // rendering an error.
    let parsedAmount = $derived<Parsed>(
        (() => {
            const trimmed = amount.trim();
            if (trimmed === '') return { ok: false };
            try {
                return { ok: true, raw: parseEvmUsdc(evmChainId, trimmed) };
            } catch {
                return { ok: false };
            }
        })(),
    );

    // bytes32-padded forwarder address — the same value goes into BOTH
    // `mintRecipient` and `destinationCaller`. CCTPv2 uses the raw 32-byte
    // pubkey, not the strkey string.
    let forwarderBytes32 = $derived(strkeyToBytes32(STELLAR.contracts.cctpForwarder));

    // hookData encoding: 24 zero bytes + uint32 version + uint32 length + UTF-8
    // strkey. Validated in encodeStellarForwarderHookData; we wrap with a typed
    // result here too so an invalid recipient surfaces inline.
    type Hookdata = { ok: true; hex: string } | { ok: false; error: string };
    let hookData = $derived<Hookdata>(
        (() => {
            try {
                return { ok: true, hex: encodeStellarForwarderHookData(stellarRecipient) };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        })(),
    );

    let isWrapper = $derived(inboundFlow === 'wrapper');
    let isSendCalls = $derived(inboundFlow === 'send-calls');

    let contractAddress = $derived(
        isWrapper ? cfg.bridgeWrapper : EVM_CCTP_CONTRACTS.tokenMessengerV2,
    );
    let contractLabel = $derived(isWrapper ? 'CctpWrapper (user-deployed)' : 'TokenMessengerV2');
    let functionName = $derived(isWrapper ? 'bridgeWithPermit' : 'depositForBurnWithHook');

    // Memoized EIP-712 domain fetch per chain. The (name, version) pair is
    // immutable for a deployed FiatToken proxy so we read once per chain and
    // share across instances. Re-runs only when evmChainId changes (the
    // {#await} block in the template keys on the returned Promise identity).
    // Plain object cache to keep this non-reactive — Svelte's SvelteMap would
    // also work but adds reactivity we don't need for a pure memo.
    const domainCache: Partial<Record<EvmChainId, Promise<EvmUsdcEip712Domain>>> = {};
    function getDomain(chainId: EvmChainId): Promise<EvmUsdcEip712Domain> {
        let p = domainCache[chainId];
        if (!p) {
            p = fetchUsdcEip712Domain(chainId);
            domainCache[chainId] = p;
        }
        return p;
    }
</script>

<section class="burn-preview">
    <header class="head">
        <h4 class="title">Burn invocation preview</h4>
        <span class="sub">
            What you're about to sign in MetaMask, decoded into human-readable args.
        </span>
    </header>

    <div class="meta">
        <div class="meta-row">
            <span class="meta-label">Contract</span>
            <code class="meta-value" title={contractAddress ?? ''}>
                {contractAddress ? shortAddr(contractAddress, 6, 4) : '—'}
            </code>
            <span class="meta-aside">{contractLabel}</span>
        </div>
        <div class="meta-row">
            <span class="meta-label">Function</span>
            <code class="meta-value">{functionName}</code>
        </div>
        <div class="meta-row">
            <span class="meta-label">Caller</span>
            <code class="meta-value" title={evmAddress}>{shortAddr(evmAddress, 6, 4)}</code>
            <span class="meta-aside">
                msg.sender — your EVM wallet pays gas and (for the wrapper flow) is the permit
                `owner`.
            </span>
        </div>
    </div>

    {#if isWrapper}
        <p class="flow-note">
            Wrapper flow — one EIP-712 signature (off-chain, no gas) + one tx. The wrapper calls <code
                >usdc.permit → transferFrom → approve → depositForBurnWithHook</code
            > atomically.
        </p>
    {:else if isSendCalls}
        <p class="flow-note">
            Batched flow — the wallet bundles <code>usdc.approve(...)</code> and
            <code>depositForBurnWithHook(...)</code> behind one confirmation via EIP-5792
            <code>wallet_sendCalls</code>.
            {#if sendCallsCap.atomic}
                Wallet reports <strong>atomic</strong> execution — one on-chain tx.
            {:else if sendCallsCap.supported}
                Wallet reports <strong>sequential</strong> execution — one prompt, two on-chain txs.
            {:else}
                Wallet does not advertise this capability on this chain.
            {/if}
        </p>
    {:else}
        <p class="flow-note">
            Two-tx flow — a separate <code>usdc.approve(...)</code> precedes this burn (skipped if allowance
            is sufficient).
        </p>
    {/if}

    {#if isWrapper}
        <details class="signed-block" open>
            <summary>EIP-712 Permit signature (off-chain — no gas)</summary>
            <div class="signed-body">
                <h6 class="block-section">Domain</h6>
                {#await getDomain(evmChainId)}
                    <p class="loading">Reading USDC name + version…</p>
                {:then domain}
                    <ul class="rows tight">
                        <li class="row">
                            <span class="arg-name">name</span>
                            <span class="arg-type">string</span>
                            <code class="arg-value">"{domain.name}"</code>
                            <span class="arg-note">read from usdc.name()</span>
                        </li>
                        <li class="row">
                            <span class="arg-name">version</span>
                            <span class="arg-type">string</span>
                            <code class="arg-value">"{domain.version}"</code>
                            <span class="arg-note">read from usdc.version()</span>
                        </li>
                        <li class="row">
                            <span class="arg-name">chainId</span>
                            <span class="arg-type">uint256</span>
                            <code class="arg-value">{domain.chainId}</code>
                            <span class="arg-note">{cfg.label}</span>
                        </li>
                        <li class="row">
                            <span class="arg-name">verifyingContract</span>
                            <span class="arg-type">address</span>
                            <code class="arg-value" title={domain.verifyingContract}>
                                {shortAddr(domain.verifyingContract, 6, 4)}
                            </code>
                            <span class="arg-note">USDC on {cfg.label}</span>
                        </li>
                    </ul>
                {:catch err}
                    <p class="error">Couldn't read USDC domain: {err.message}</p>
                {/await}

                <h6 class="block-section">Permit message</h6>
                <ul class="rows tight">
                    <li class="row">
                        <span class="arg-name">owner</span>
                        <span class="arg-type">address</span>
                        <code class="arg-value" title={evmAddress}>
                            {shortAddr(evmAddress, 6, 4)}
                        </code>
                        <span class="arg-note">caller</span>
                    </li>
                    <li class="row">
                        <span class="arg-name">spender</span>
                        <span class="arg-type">address</span>
                        <code class="arg-value" title={cfg.bridgeWrapper ?? ''}>
                            {cfg.bridgeWrapper ? shortAddr(cfg.bridgeWrapper, 6, 4) : '—'}
                        </code>
                        <span class="arg-note">CctpWrapper</span>
                    </li>
                    <li class="row">
                        <span class="arg-name">value</span>
                        <span class="arg-type">uint256</span>
                        {#if parsedAmount.ok}
                            <code class="arg-value">{parsedAmount.raw.toString()}</code>
                            <span class="arg-note">
                                same as the burn amount ({formatEvmUsdc(
                                    evmChainId,
                                    parsedAmount.raw,
                                )} USDC)
                            </span>
                        {:else}
                            <span class="arg-placeholder">Enter an amount above</span>
                        {/if}
                    </li>
                    <li class="row">
                        <span class="arg-name">nonce</span>
                        <span class="arg-type">uint256</span>
                        <span class="arg-placeholder">
                            read at sign time from usdc.nonces(owner)
                        </span>
                    </li>
                    <li class="row">
                        <span class="arg-name">deadline</span>
                        <span class="arg-type">uint256</span>
                        <span class="arg-placeholder"> set at sign time to now + 30 min </span>
                    </li>
                </ul>
            </div>
        </details>
    {/if}

    {#if isSendCalls}
        <details class="signed-block" open>
            <summary>
                wallet_sendCalls bundle
                <span class="badge {sendCallsCap.atomic ? 'atomic' : 'sequential'}">
                    {sendCallsCap.atomic
                        ? 'atomic'
                        : sendCallsCap.supported
                          ? 'sequential'
                          : 'unsupported'}
                </span>
            </summary>
            <div class="signed-body">
                <p class="block-blurb">
                    The wallet receives two encoded calls and routes them according to its
                    capability response. The receipt order matches the calls order; the burn (call
                    2) is always the last receipt — that's the hash used for the Iris attestation
                    poll.
                </p>

                <div class="bundle-call">
                    <div class="bundle-head">
                        <span class="bundle-num">1</span>
                        <code class="bundle-target" title={cfg.usdc}>
                            {shortAddr(cfg.usdc, 6, 4)}
                        </code>
                        <span class="bundle-dot">·</span>
                        <code class="bundle-fn">approve</code>
                    </div>
                    <ul class="rows tight">
                        <li class="row">
                            <span class="arg-name">spender</span>
                            <span class="arg-type">address</span>
                            <code class="arg-value" title={EVM_CCTP_CONTRACTS.tokenMessengerV2}>
                                {shortAddr(EVM_CCTP_CONTRACTS.tokenMessengerV2, 6, 4)}
                            </code>
                            <span class="arg-note">TokenMessengerV2</span>
                        </li>
                        <li class="row">
                            <span class="arg-name">amount</span>
                            <span class="arg-type">uint256</span>
                            {#if parsedAmount.ok}
                                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                                <span class="arg-note"> same as the burn amount </span>
                            {:else}
                                <span class="arg-placeholder">Enter an amount above</span>
                            {/if}
                        </li>
                    </ul>
                </div>

                <div class="bundle-call">
                    <div class="bundle-head">
                        <span class="bundle-num">2</span>
                        <code class="bundle-target" title={EVM_CCTP_CONTRACTS.tokenMessengerV2}>
                            {shortAddr(EVM_CCTP_CONTRACTS.tokenMessengerV2, 6, 4)}
                        </code>
                        <span class="bundle-dot">·</span>
                        <code class="bundle-fn">depositForBurnWithHook</code>
                    </div>
                    <p class="bundle-note">
                        Same 8-arg payload as the table below — the wallet just hands the encoded
                        calldata to the chain.
                    </p>
                </div>
            </div>
        </details>
    {/if}

    <h5 class="section-title">
        {isWrapper ? 'bridgeWithPermit arguments' : 'depositForBurnWithHook arguments'}
    </h5>
    <ul class="rows">
        <li class="row">
            <span class="arg-name">amount</span>
            <span class="arg-type">uint256</span>
            {#if parsedAmount.ok}
                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                <span class="arg-note">
                    {formatEvmUsdc(evmChainId, parsedAmount.raw)} USDC (canonical 6 decimals)
                </span>
            {:else}
                <span class="arg-placeholder">Enter an amount above</span>
            {/if}
        </li>

        <li class="row">
            <span class="arg-name">destinationDomain</span>
            <span class="arg-type">uint32</span>
            <code class="arg-value">{STELLAR.domain}</code>
            <span class="arg-note">Stellar Testnet</span>
        </li>

        <li class="row wide">
            <span class="arg-name">mintRecipient</span>
            <span class="arg-type">bytes32</span>
            <code class="arg-hex">{forwarderBytes32}</code>
            <span class="arg-note">
                → {STELLAR.contracts.cctpForwarder} (CctpForwarder — required for Stellar inbound)
            </span>
        </li>

        {#if !isWrapper}
            <li class="row">
                <span class="arg-name">burnToken</span>
                <span class="arg-type">address</span>
                <code class="arg-value" title={cfg.usdc}>{shortAddr(cfg.usdc, 6, 4)}</code>
                <span class="arg-note">USDC on {cfg.label}</span>
            </li>
        {/if}

        <li class="row wide">
            <span class="arg-name">destinationCaller</span>
            <span class="arg-type">bytes32</span>
            <code class="arg-hex">{forwarderBytes32}</code>
            <span class="arg-note">
                MUST equal mintRecipient — only the forwarder can call mint_and_forward on Stellar.
            </span>
        </li>

        <li class="row">
            <span class="arg-name">maxFee</span>
            <span class="arg-type">uint256</span>
            <code class="arg-value">{EVM_MAX_FEE.toString()}</code>
            <span class="arg-note">defensive cap, canonical 6-decimal units</span>
        </li>

        <li class="row">
            <span class="arg-name">minFinalityThreshold</span>
            <span class="arg-type">uint32</span>
            <code class="arg-value">{FINALIZED_THRESHOLD}</code>
            <span class="arg-note">Standard / finalized</span>
        </li>

        <li class="row wide">
            <span class="arg-name">hookData</span>
            <span class="arg-type">bytes</span>
            {#if hookData.ok}
                <code class="arg-hex">{hookData.hex}</code>
                <span class="arg-note">
                    Forwarder routing payload — see the Hook data preview below for the byte-level
                    layout.
                </span>
            {:else}
                <span class="arg-placeholder">{hookData.error}</span>
            {/if}
        </li>

        {#if isWrapper}
            <li class="row">
                <span class="arg-name">permitDeadline</span>
                <span class="arg-type">uint256</span>
                <span class="arg-placeholder">set at sign time to now + 30 min</span>
            </li>
            <li class="row">
                <span class="arg-name">permitV</span>
                <span class="arg-type">uint8</span>
                <span class="arg-placeholder">27 or 28 (ECDSA recovery id)</span>
            </li>
            <li class="row">
                <span class="arg-name">permitR</span>
                <span class="arg-type">bytes32</span>
                <span class="arg-placeholder">first 32 bytes of the signature</span>
            </li>
            <li class="row">
                <span class="arg-name">permitS</span>
                <span class="arg-type">bytes32</span>
                <span class="arg-placeholder">middle 32 bytes of the signature</span>
            </li>
        {/if}
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

    .flow-note strong {
        color: var(--text);
        font-weight: 600;
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

    .rows.tight {
        gap: 0.25rem;
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

    .rows.tight .row {
        padding: 0.3rem 0.45rem;
        background: var(--bg-elev-2);
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

    .signed-block {
        margin-top: 0.25rem;
        background: var(--bg);
        border-radius: var(--radius);
        padding: 0.5rem 0.6rem;
        border-left: 2px solid var(--accent);
    }

    .signed-block summary {
        cursor: pointer;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--text);
        list-style: none;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .signed-block summary::-webkit-details-marker {
        display: none;
    }

    .signed-block summary::before {
        content: '▸';
        display: inline-block;
        width: 1em;
        color: var(--text-muted);
        transition: transform 120ms;
    }

    .signed-block[open] summary::before {
        transform: rotate(90deg);
    }

    .signed-body {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.5rem;
    }

    .block-section {
        margin: 0.25rem 0 0;
        font-size: 0.7rem;
        font-weight: 600;
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .block-blurb {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .loading {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-dim);
        font-style: italic;
    }

    .error {
        margin: 0;
        color: var(--error);
        font-size: 0.8rem;
        font-family: var(--mono);
        word-break: break-word;
    }

    .badge {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.15rem 0.45rem;
        border-radius: 999px;
        font-family: var(--mono);
    }

    .badge.atomic {
        background: color-mix(in srgb, var(--success) 18%, transparent);
        color: var(--success);
    }

    .badge.sequential {
        background: color-mix(in srgb, var(--warning) 18%, transparent);
        color: var(--warning);
    }

    .bundle-call {
        background: var(--bg-elev-2);
        border-radius: var(--radius);
        padding: 0.4rem 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        border-left: 2px solid var(--border-strong);
    }

    .bundle-head {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
        flex-wrap: wrap;
    }

    .bundle-num {
        font-family: var(--mono);
        font-size: 0.72rem;
        font-weight: 700;
        color: var(--accent);
        background: var(--bg);
        border-radius: 999px;
        padding: 0.05rem 0.4rem;
    }

    .bundle-target {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text-muted);
    }

    .bundle-dot {
        color: var(--text-dim);
    }

    .bundle-fn {
        font-family: var(--mono);
        font-size: 0.78rem;
        color: var(--text);
        font-weight: 600;
    }

    .bundle-note {
        margin: 0;
        font-size: 0.75rem;
        color: var(--text-muted);
        line-height: 1.4;
    }
</style>
