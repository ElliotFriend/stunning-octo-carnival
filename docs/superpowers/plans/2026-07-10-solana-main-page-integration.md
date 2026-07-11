# Solana Main-Page Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Make Solana a first-class chain in the main page's top-right selector (Arc · Base · Ethereum · Solana), functioning like Stellar↔EVM, and delete `/solana-spike`.

**Architecture:** A new `DestinationPanel` owns the chip selector and swaps an EVM body (`EvmPanel`, now controlled) vs a Solana body (`SolanaPanel`, restyled to match). The page derives `Direction` from `(rightChain, stellarIsSource)`. The transfer store already runs both Solana directions; only its EVM-input optionality changes.

**Tech Stack:** SvelteKit (Svelte 5 runes), existing transfer store, `@solana/kit`, viem.

## Global Constraints

- Svelte 5 runes, **no `$effect`** (explicit dataflow). Run `svelte-autofixer` on every `.svelte` file until clean.
- `pnpm check` + `pnpm lint` must pass after each task.
- Fund-safety: per-direction burn args must be exact — `stellar-to-solana` burns on Stellar to the recipient's Solana USDC **ATA** (domain 5); `solana-to-stellar` burns on Solana to the **forwarder** (domain 27) with the G-address hook. Never cross them.
- No test runner; final gate is a real main-page transfer both Solana directions + an EVM regression + `/solana-spike` gone.
- `RightChain = EvmChainId | 'solana'`.

**Direction derivation (page-owned):** `stellarIsSource` + `rightChain` →
`rightChain==='solana' ? (stellarIsSource?'stellar-to-solana':'solana-to-stellar') : (stellarIsSource?'stellar-to-evm':'evm-to-stellar')`.

---

### Task 1: config `RightChain` + store EVM-input optionality

**Files:** Modify `src/lib/config.ts`, `src/lib/stores/transfer.svelte.ts`, `src/lib/components/TransferProgress.svelte`.

**Interfaces produced:** `RightChain` type; `start()`/`resume()`/`TransferState` accept optional `evmWallet`/`evmChainId`.

- [ ] **Step 1 — config:** add after the `Direction` type in `config.ts`:

```ts
export type RightChain = EvmChainId | 'solana';
```

- [ ] **Step 2 — store types:** in `transfer.svelte.ts`, make `TransferState.evmChainId` optional (`evmChainId?: EvmChainId`), and in `start()`'s arg type make `evmWallet?: EvmWallet` and `evmChainId?: EvmChainId`. In the EVM branches of `start()` (the `stellar-to-evm` and final `else`), guard: `if (!args.evmWallet || !args.evmChainId) throw new Error('EVM wallet/chain not connected.');` before calling `runStellarToEvm`/`runEvmToStellar` (which still receive the narrowed values). Set `state.evmChainId = args.evmChainId` (may be undefined).

- [ ] **Step 3 — stepsFor:** move the eager `const evmLabel = EVM_CHAINS[evmChainId].label;` (currently `transfer.svelte.ts:108`) INSIDE the EVM branches that use it (`stellar-to-evm` and the EVM fallthrough), so the Solana branches never index `EVM_CHAINS[undefined]`. Make the `stepsFor` `evmChainId` param optional. Where an EVM branch needs the label, compute `EVM_CHAINS[evmChainId!].label` guarded by the branch (that branch only runs for EVM directions where it's defined).

- [ ] **Step 4 — TransferProgress guard:** `TransferProgress.svelte:19` — change `longWaitChainLabel = EVM_CHAINS[transfer.evmChainId].label` to `transfer.evmChainId ? EVM_CHAINS[transfer.evmChainId].label : ''`. Confirm no other unguarded `EVM_CHAINS[transfer.evmChainId]` read remains (the `:16` one is already behind an `evm-to-stellar` ternary).

- [ ] **Step 5:** `pnpm check` → PASS. `pnpm lint` → PASS. Commit:

```bash
git add src/lib/config.ts src/lib/stores/transfer.svelte.ts src/lib/components/TransferProgress.svelte
git commit -m "refactor: RightChain type + optional EVM inputs in transfer store"
```

---

### Task 2: delete `/solana-spike`, then restyle `SolanaPanel`

Deletion first (review M6) so stripping SolanaPanel props doesn't break the spike's typecheck.

**Files:** Delete `src/routes/solana-spike/` (dir). Modify `src/lib/components/SolanaPanel.svelte`.

**Interfaces produced:** `SolanaPanel` props `{ wallet?: SolanaWallet | null (bindable); disabled?: boolean }`, `export function refresh()`.

- [ ] **Step 1 — delete the spike:**

```bash
git rm -r src/routes/solana-spike
```

- [ ] **Step 2 — rewrite `SolanaPanel.svelte`** to mirror EvmPanel's structure/styling (badge, connect button, addr row, balance, refresh/disconnect), connect-only + balance (no burn form). Full file:

```svelte
<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import {
        connectSolana,
        detectExistingSolana,
        discoverSolanaWallets,
        type SolanaWallet,
    } from '$lib/solana/wallet';
    import { getUsdcBalance } from '$lib/solana/usdc';
    import { SOLANA } from '$lib/config';
    import { shortAddr } from '$lib/utils';

    let {
        wallet = $bindable<SolanaWallet | null>(null),
        disabled = false,
    }: { wallet?: SolanaWallet | null; disabled?: boolean } = $props();

    let balance = $state<string | null>(null);
    let error = $state<string | null>(null);
    let connecting = $state(false);

    onMount(async () => {
        if (!browser) return;
        const existing = await detectExistingSolana();
        if (existing) {
            wallet = existing;
            await refreshBalance();
        }
    });

    async function refreshBalance() {
        if (!wallet) {
            balance = null;
            return;
        }
        error = null;
        try {
            balance = await getUsdcBalance(wallet.address);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    // Exposed via bind:this so DestinationPanel can refetch after a transfer.
    export function refresh() {
        return refreshBalance();
    }

    async function connect() {
        error = null;
        connecting = true;
        try {
            const wallets = discoverSolanaWallets();
            if (wallets.length === 0) {
                throw new Error(
                    'No Solana wallet found. Install Phantom from phantom.app and reload.',
                );
            }
            const pick =
                wallets.find((w) => w.name.toLowerCase().includes('phantom')) ?? wallets[0];
            wallet = await connectSolana(pick);
            await refreshBalance();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            connecting = false;
        }
    }

    function disconnect() {
        wallet = null;
        balance = null;
    }
</script>

<section class="panel">
    <header class="head">
        <span class="badge solana">Solana</span>
        <span class="muted">domain {SOLANA.domain}</span>
    </header>

    {#if wallet}
        <div class="addr-row">
            <code class="addr" title={wallet.address}>{shortAddr(wallet.address)}</code>
            <div class="actions">
                <button class="link" onclick={refreshBalance}>refresh</button>
                <button class="link" onclick={disconnect}>disconnect</button>
            </div>
        </div>
        <div class="balance">
            <span class="amount">{balance ?? '…'}</span>
            <span class="symbol">USDC</span>
        </div>
        <p class="gas-note">Devnet · fees paid in SOL.</p>
    {:else}
        <button class="connect" onclick={connect} disabled={disabled || connecting}>
            {connecting ? 'Connecting…' : 'Connect Phantom'}
        </button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
    /* Mirror EvmPanel.svelte's panel/badge/addr/balance/connect styles. */
    .panel {
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        min-height: 160px;
    }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .badge {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
        padding: 0.2rem 0.55rem;
        border-radius: 999px;
    }
    .badge.solana {
        background: color-mix(in srgb, #14f195 20%, transparent);
        color: #14f195;
    }
    .muted {
        color: var(--text-dim);
        font-size: 0.85rem;
        font-family: var(--mono);
    }
    .connect {
        background: var(--bg-elev-2);
        color: var(--text);
        border: 1px solid var(--border-strong);
        padding: 0.6rem 1rem;
        border-radius: var(--radius);
        font-weight: 500;
    }
    .connect:hover:not(:disabled) {
        background: var(--accent-dim);
        border-color: var(--accent);
    }
    .addr-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .actions {
        display: flex;
        gap: 0.75rem;
    }
    .addr {
        font-family: var(--mono);
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .link {
        background: none;
        border: none;
        color: var(--accent);
        font-size: 0.8rem;
        padding: 0;
    }
    .link:hover {
        text-decoration: underline;
    }
    .balance {
        display: flex;
        align-items: baseline;
        gap: 0.4rem;
    }
    .amount {
        font-size: 1.6rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }
    .symbol {
        font-size: 0.95rem;
        color: var(--text-muted);
    }
    .gas-note {
        margin: 0;
        font-size: 0.78rem;
        color: var(--text-dim);
    }
    .error {
        color: var(--error);
        font-size: 0.85rem;
        margin: 0;
        word-break: break-word;
    }
</style>
```

- [ ] **Step 3:** `svelte-autofixer` on `SolanaPanel.svelte` until clean; `pnpm check && pnpm lint` PASS. Commit:

```bash
git add -A src/routes/solana-spike src/lib/components/SolanaPanel.svelte
git commit -m "refactor: delete solana-spike; restyle SolanaPanel to connect+balance"
```

---

### Task 3: `SolanaBurnPreview` (new) + `StellarBurnPreview` Solana-dest support

Both burn previews are source-side. `solana-to-stellar` burns on Solana → new `SolanaBurnPreview`. `stellar-to-solana` burns on Stellar → extend `StellarBurnPreview` to accept a Solana ATA destination (back-compatible so the page still compiles before Task 4).

**Files:** Create `src/lib/components/SolanaBurnPreview.svelte`. Modify `src/lib/components/StellarBurnPreview.svelte`.

**Interfaces produced:**

- `SolanaBurnPreview` props: `{ solanaAddress: string; stellarRecipient: string; amount: string }`.
- `StellarBurnPreview` gains an optional `solanaRecipient?: string` (a Solana owner address). When set, the preview targets Solana: `destinationDomain = SOLANA.domain`, `mint_recipient = solanaAtaToBytes32(solanaRecipient)` (async → shown once resolved), no wrapper/forwarding, `evmChainId`/`evmRecipient` become optional.

- [ ] **Step 1 — `SolanaBurnPreview.svelte`** (Solana-source burn = `depositForBurnWithHook` to the forwarder, domain 27, G-address hook). Mirror the burn-preview card styling (reuse the same class names/`<style>` block as `StellarBurnPreview` for visual parity — copy that `<style>`). Script:

```svelte
<script lang="ts">
    import { SOLANA, STELLAR, SOLANA_MAX_FEE, STANDARD_THRESHOLD } from '$lib/config';
    import { fetchBurnFee, feeBpsFor, computeMaxFee } from '$lib/circle/fees';
    import { parseUsdcSolana } from '$lib/solana/usdc';
    import { strkeyToBytes32, encodeStellarForwarderHookData } from '$lib/stellar/recipient';
    import { toHex } from 'viem';
    import { shortAddr } from '$lib/utils';

    let {
        solanaAddress,
        stellarRecipient,
        amount,
    }: { solanaAddress: string; stellarRecipient: string; amount: string } = $props();

    type Parsed = { ok: true; raw: bigint } | { ok: false };
    let parsedAmount = $derived<Parsed>(
        (() => {
            const t = amount.trim();
            if (t === '') return { ok: false };
            try {
                return { ok: true, raw: parseUsdcSolana(t) };
            } catch {
                return { ok: false };
            }
        })(),
    );

    let forwarderHex = $derived(strkeyToBytes32(STELLAR.contracts.cctpForwarder));
    let hookHex = $derived(
        (() => {
            try {
                return encodeStellarForwarderHookData(stellarRecipient);
            } catch {
                return null;
            }
        })(),
    );
    let feePromise = $derived(fetchBurnFee(SOLANA.domain, STELLAR.domain));
    const short = (a: string) => shortAddr(a, 6, 6);
</script>

<section class="burn-preview">
    <header class="head">
        <h4 class="title">Burn invocation preview</h4>
        <span class="sub">What you're about to sign in Phantom, decoded.</span>
    </header>
    <div class="meta">
        <div class="meta-row">
            <span class="meta-label">Program</span>
            <code class="meta-value" title={SOLANA.programs.tokenMessengerMinterV2}>
                {short(SOLANA.programs.tokenMessengerMinterV2)}
            </code>
            <span class="meta-aside">TokenMessengerMinterV2 · deposit_for_burn_with_hook</span>
        </div>
        <div class="meta-row">
            <span class="meta-label">Owner</span>
            <code class="meta-value" title={solanaAddress}>{short(solanaAddress)}</code>
            <span class="meta-aside">signs + pays (Phantom)</span>
        </div>
    </div>
    <h5 class="section-title">Arguments</h5>
    <ul class="rows">
        <li class="row">
            <span class="arg-name">amount</span>
            <span class="arg-type">u64</span>
            {#if parsedAmount.ok}
                <code class="arg-value">{parsedAmount.raw.toString()}</code>
                <span class="arg-note">6-decimal USDC subunits</span>
            {:else}
                <span class="arg-placeholder">Enter an amount above</span>
            {/if}
        </li>
        <li class="row">
            <span class="arg-name">destinationDomain</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{STELLAR.domain}</code>
            <span class="arg-note">Stellar</span>
        </li>
        <li class="row wide">
            <span class="arg-name">mintRecipient = destinationCaller</span>
            <span class="arg-type">Pubkey</span>
            <code class="arg-hex">{forwarderHex}</code>
            <span class="arg-note"
                >the Stellar CctpForwarder — real recipient rides in hookData</span
            >
        </li>
        <li class="row">
            <span class="arg-name">maxFee</span>
            <span class="arg-type">u64</span>
            {#await feePromise then rows}
                {@const bps = feeBpsFor(rows, 'standard')}
                <code class="arg-value">
                    {computeMaxFee(
                        parsedAmount.ok ? parsedAmount.raw : 0n,
                        bps,
                        SOLANA_MAX_FEE,
                    ).toString()}
                </code>
                <span class="arg-note">{bps > 0 ? `${bps} bps + floor` : 'floor (no fee)'}</span>
            {:catch}
                <code class="arg-value">{SOLANA_MAX_FEE.toString()}</code>
                <span class="arg-note">floor (fee API unavailable)</span>
            {/await}
        </li>
        <li class="row">
            <span class="arg-name">minFinalityThreshold</span>
            <span class="arg-type">u32</span>
            <code class="arg-value">{STANDARD_THRESHOLD}</code>
            <span class="arg-note">standard (finalized)</span>
        </li>
        <li class="row wide">
            <span class="arg-name">hookData</span>
            <span class="arg-type">bytes</span>
            {#if hookHex}
                <code class="arg-hex">{hookHex}</code>
                <span class="arg-note">Stellar forwarder hook → {short(stellarRecipient)}</span>
            {:else}
                <span class="arg-placeholder">Connect a Stellar recipient</span>
            {/if}
        </li>
    </ul>
</section>

<style>
    /* Copy StellarBurnPreview.svelte's <style> block verbatim for parity. */
</style>
```

(In implementation, paste `StellarBurnPreview`'s full `<style>` block into the marked spot — same class names are used.)

- [ ] **Step 2 — extend `StellarBurnPreview.svelte`** for the Solana destination, keeping EVM behavior default. Add an optional `solanaRecipient?: string` prop and make `evmRecipient`/`evmChainId` optional. When `solanaRecipient` is set: derive `mintRecipientHex` from `await solanaAtaToBytes32(solanaRecipient)` (use an `{#await}`); set the destination row to `destination_domain = SOLANA.domain` with note "Solana", and the `mint_recipient` note to "→ your Solana USDC ATA". Force `outboundFlow='two-tx'`/`forwarding=false` for this mode (no wrapper to Solana). Guard every `EVM_CHAINS[evmChainId]` read behind `!solanaRecipient`. Import `SOLANA` + `solanaAtaToBytes32`.

- [ ] **Step 3:** `svelte-autofixer` on both; `pnpm check && pnpm lint` PASS. Commit:

```bash
git add src/lib/components/SolanaBurnPreview.svelte src/lib/components/StellarBurnPreview.svelte
git commit -m "feat: SolanaBurnPreview + StellarBurnPreview Solana-destination mode"
```

---

### Task 4: DestinationPanel + controlled EvmPanel + generalized switcher/form + page rewiring

These change props across the panel↔page boundary together, so they land as one coherent green commit.

**Files:** Create `src/lib/components/DestinationPanel.svelte`. Modify `EvmPanel.svelte`, `DirectionSwitcher.svelte`, `TransferForm.svelte`, `src/routes/+page.svelte`.

- [ ] **Step 1 — EvmPanel controlled + `setChain`:** in `EvmPanel.svelte`, delete the chip-selector markup block (`<div class="chain-picker">…</div>`, lines ~167-181) and the `.chain-picker` style. Rename `pickChain` → and expose it:

```ts
// Imperative: called by DestinationPanel when the chip row picks an EVM chain.
export async function setChain(id: EvmChainId) {
    if (id === chainId) return;
    chainId = id;
    if (!EVM_CHAINS[id].bridgeWrapper && inboundFlow === 'wrapper') {
        inboundFlow = 'two-tx';
    }
    if (wallet) {
        await switchChain();
    } else {
        balance = null;
        sendCallsCap = { supported: false, atomic: false };
    }
}
```

Keep `switchChain`, `refreshBalance`, `refreshSendCallsCap`, `refresh`, connect flow, and the `{#if direction === 'evm-to-stellar'}` inbound-flow picker. `chainId` stays a bindable prop.

- [ ] **Step 2 — `DestinationPanel.svelte`** (new). Owns the chip row (EVM chains + trailing Solana), holds `bind:this` refs to the active body, exposes `refresh()`, and calls `evmRef.setChain(id)` on EVM chip clicks:

```svelte
<script lang="ts">
    import EvmPanel from './EvmPanel.svelte';
    import SolanaPanel from './SolanaPanel.svelte';
    import {
        EVM_CHAINS,
        type Direction,
        type EvmChainId,
        type InboundFlow,
        type RightChain,
    } from '$lib/config';
    import type { EvmWallet } from '$lib/evm/wallet';
    import type { SendCallsCapability } from '$lib/evm/capabilities';
    import type { SolanaWallet } from '$lib/solana/wallet';

    let {
        chain = $bindable<RightChain>('arc'),
        evmWallet = $bindable<EvmWallet | null>(null),
        evmChainId = $bindable<EvmChainId>('arc'),
        solanaWallet = $bindable<SolanaWallet | null>(null),
        inboundFlow = $bindable<InboundFlow>('two-tx'),
        sendCallsCap = $bindable<SendCallsCapability>({ supported: false, atomic: false }),
        direction,
        disabled = false,
    }: {
        chain?: RightChain;
        evmWallet?: EvmWallet | null;
        evmChainId?: EvmChainId;
        solanaWallet?: SolanaWallet | null;
        inboundFlow?: InboundFlow;
        sendCallsCap?: SendCallsCapability;
        direction: Direction;
        disabled?: boolean;
    } = $props();

    let evmRef = $state<{
        refresh: () => Promise<void>;
        setChain: (id: EvmChainId) => Promise<void>;
    }>();
    let solRef = $state<{ refresh: () => Promise<void> }>();

    export function refresh() {
        return chain === 'solana'
            ? (solRef?.refresh() ?? Promise.resolve())
            : (evmRef?.refresh() ?? Promise.resolve());
    }

    async function pick(id: RightChain) {
        if (id === chain) return;
        chain = id;
        if (id !== 'solana') {
            evmChainId = id;
            // Wait a tick so EvmPanel is mounted before driving its chain switch.
            await Promise.resolve();
            await evmRef?.setChain(id);
        }
    }
</script>

<section class="dest">
    <div class="chain-picker" role="tablist" aria-label="Destination chain">
        {#each Object.values(EVM_CHAINS) as cfg (cfg.id)}
            <button
                type="button"
                class="chip"
                class:active={chain === cfg.id}
                {disabled}
                onclick={() => pick(cfg.id)}
                role="tab"
                aria-selected={chain === cfg.id}
            >
                {cfg.label}
            </button>
        {/each}
        <button
            type="button"
            class="chip"
            class:active={chain === 'solana'}
            {disabled}
            onclick={() => pick('solana')}
            role="tab"
            aria-selected={chain === 'solana'}
        >
            Solana
        </button>
    </div>

    {#if chain === 'solana'}
        <SolanaPanel bind:this={solRef} bind:wallet={solanaWallet} {disabled} />
    {:else}
        <EvmPanel
            bind:this={evmRef}
            bind:wallet={evmWallet}
            bind:chainId={evmChainId}
            bind:inboundFlow
            bind:sendCallsCap
            {direction}
            {disabled}
        />
    {/if}
</section>

<style>
    .dest {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }
    .chain-picker {
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
        font-size: 0.8rem;
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
    .chip:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
</style>
```

> **Note (verify at build):** the `pick()` EVM path sets `evmChainId` then calls `evmRef.setChain(id)`; since EvmPanel is already mounted for any EVM chip (only unmounts when switching to Solana), `evmRef` is present. When switching Solana→EVM, EvmPanel remounts and its `onMount` reconnect + the bound `chainId` handle it; the `setChain` call still runs after the `await Promise.resolve()` tick. If `evmRef` is momentarily undefined on the Solana→EVM transition, the optional-chain `?.` no-ops and the bound `chainId`/onMount path covers it — verify chain switching works in the Task 4 manual check.

- [ ] **Step 3 — DirectionSwitcher orientation-based:**

```svelte
<script lang="ts">
    let {
        stellarIsSource = $bindable<boolean>(true),
        otherLabel = 'EVM',
        disabled = false,
    }: { stellarIsSource?: boolean; otherLabel?: string; disabled?: boolean } = $props();
    let otherShort = $derived(otherLabel.split(' ')[0]);
    function flip() {
        stellarIsSource = !stellarIsSource;
    }
</script>

<div class="switcher">
    <span class="from">{stellarIsSource ? 'Stellar' : otherShort}</span>
    <button class="flip" onclick={flip} {disabled} aria-label="Flip direction"> ⇄ </button>
    <span class="to">{stellarIsSource ? otherShort : 'Stellar'}</span>
</div>

<style>
    /* unchanged from current DirectionSwitcher */
</style>
```

(Keep the existing `<style>` block.)

- [ ] **Step 4 — TransferForm source-aware:** replace `evmLabel` prop with `otherLabel`, and take `stellarIsSource: boolean` as a prop (page-derived) instead of inferring from `direction`. Update:

```ts
let otherShort = $derived(otherLabel.split(' ')[0]);
let buttonLabel = $derived(
    busy
        ? 'Working…'
        : stellarIsSource
          ? `Send Stellar → ${otherShort}`
          : `Send ${otherShort} → Stellar`,
);
```

Replace the internal `let stellarSource = $derived(direction === 'stellar-to-evm')` usage with the `stellarIsSource` prop everywhere it gated Fast (so Fast is disabled whenever Stellar is the source OR the right chain is Solana). Add a `fastAllowed` prop from the page (`fastAllowed = rightChain !== 'solana' && !stellarIsSource`) and gate the Fast chip on `!fastAllowed` (disabled) — simplest: pass `fastAllowed: boolean` and use it in place of `!stellarSource`. Keep `direction` only if still needed for copy; otherwise drop it.

- [ ] **Step 5 — `+page.svelte` rewiring:**
    - Imports: drop `EvmPanel` import, add `DestinationPanel` and `SolanaBurnPreview` + `type SolanaWallet` + `type RightChain`. Keep `StellarBurnPreview`.
    - State: replace `evmChainId`/`direction` with `rightChain = $state<RightChain>('arc')`, `stellarIsSource = $state(true)`, add `solana = $state<SolanaWallet | null>(null)`. Keep `evm`. Add `evmChainId = $state<EvmChainId>(DEFAULT_EVM_CHAIN)` (still needed for the EVM body + store).
    - Derived: `direction` from `(rightChain, stellarIsSource)` per Global Constraints; `rightLabel = rightChain === 'solana' ? 'Solana' : EVM_CHAINS[rightChain].label`; `rightConnected = rightChain === 'solana' ? !!solana : !!evm`; `bothConnected = !!stellar.address && rightConnected`; `effectiveSpeed = (direction === 'stellar-to-evm' ... )` → coerce to `standard` when `!(rightChain !== 'solana' && !stellarIsSource)` (i.e. standard unless EVM-source).
    - Replace `<EvmPanel .../>` with `<DestinationPanel bind:this={destPanel} bind:chain={rightChain} bind:evmWallet={evm} bind:evmChainId bind:solanaWallet={solana} bind:inboundFlow bind:sendCallsCap {direction} disabled={busy} />` and rename the `evmPanel` handle to `destPanel` (type `{ refresh }`).
    - `DirectionSwitcher`: `<DirectionSwitcher bind:stellarIsSource otherLabel={rightLabel} disabled={busy} />`.
    - `TransferForm`: pass `otherLabel={rightLabel}`, `stellarIsSource`, `fastAllowed={rightChain !== 'solana' && !stellarIsSource}` (+ keep amount/speed/etc).
    - `send()`: branch — Solana: `if (!stellar.address || !solana) return; await transfer.start({ direction, stellarAddress: stellar.address, solanaWallet: solana, amount: amount.trim(), speed: 'standard' });`. EVM: unchanged (`evmWallet: evm`, `evmChainId`). After done: `await Promise.all([stellarPanel?.refresh(), destPanel?.refresh()])`.
    - `resume()`: `if (rightChain === 'solana') return;` at top (plus keep the EVM path).
    - Resume form: `{#if transfer.state.phase === 'idle' && rightChain !== 'solana'}<ResumeForm .../>{/if}`.
    - Burn previews: keep the two EVM/Stellar blocks gated additionally on `rightChain !== 'solana'`. Add:
        - `{#if direction === 'solana-to-stellar' && stellar.address && solana && transfer.state.phase === 'idle'}<SolanaBurnPreview solanaAddress={solana.address} stellarRecipient={stellar.address} {amount} />{/if}`
        - `{#if direction === 'stellar-to-solana' && stellar.address && solana && transfer.state.phase === 'idle'}<StellarBurnPreview stellarAddress={stellar.address} solanaRecipient={solana.address} {amount} outboundFlow={'two-tx'} forwarding={false} speed={'standard'} />{/if}`
    - `gas`/hint text unaffected.

- [ ] **Step 6:** `svelte-autofixer` on every changed/new `.svelte` (DestinationPanel, EvmPanel, DirectionSwitcher, TransferForm, +page) until clean. `pnpm check && pnpm lint` PASS.

- [ ] **Step 7 — manual verification (the gate):** `pnpm dev`, open `/`:
    1. Selector shows Arc · Base · Ethereum · Solana. Pick Solana → body swaps to Phantom connect + balance.
    2. Switch EVM chips arc→base with an EVM wallet connected → wallet network switches, balance/cap refresh; picking Ethereum drops a `wrapper` inbound flow.
    3. Connect Freighter + Phantom, Solana selected: flip direction; Resume form hidden; Fast chip absent; button label correct both ways; correct burn preview per direction.
    4. Run Stellar→Solana and Solana→Stellar to completion; balances update.
    5. Run a Base↔Stellar EVM transfer — unchanged.
    6. `/solana-spike` → 404.

- [ ] **Step 8 — commit:**

```bash
git add src/lib/components/DestinationPanel.svelte src/lib/components/EvmPanel.svelte src/lib/components/DirectionSwitcher.svelte src/lib/components/TransferForm.svelte src/routes/+page.svelte
git commit -m "feat: Solana in main-page destination selector (DestinationPanel)"
```

---

## Verification summary

- Tasks 1–3 gate on `pnpm check` + `pnpm lint`.
- Task 4 gates on the full manual run: both Solana directions complete, EVM regression intact, chain-switch side effects work, Resume/Fast hidden for Solana, correct per-direction burn preview, `/solana-spike` gone.
- Highest risk: the DestinationPanel↔EvmPanel `setChain` timing on body swap (Step 2 note) and the two burn previews rendering the correct per-direction args. Only the live run settles these.
