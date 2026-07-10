# Solana Balance Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the `@solana/kit` + Wallet Standard (Phantom) + Associated Token Account stack works in this app by reading a devnet USDC balance on a throwaway `/solana-spike` route.

**Architecture:** Mirror the existing `evm/` + `stellar/` module shape — plain-function wallet/client/usdc modules plus a Svelte panel. Wallet state is component-local `$state` passed into the panel via `$bindable`. Balance reads use the app's own devnet Kit RPC, so Phantom's cluster setting can't cause a wrong-network read. Everything lives under an isolated route and is deletable.

**Tech Stack:** SvelteKit (Svelte 5 runes), `@solana/kit`, `@solana-program/token`, `@wallet-standard/app`, `@wallet-standard/base`, TypeScript.

## Global Constraints

- Svelte 5 runes only. **No `$effect`** — repo convention is explicit dataflow (use `onMount` + handlers).
- All wallet/browser code guarded with `browser` from `$app/environment` (SSR-safe).
- Wallet modules export plain functions + a state type. No stores, no classes.
- Keep Wallet Standard feature types local (cast) rather than adding `@wallet-standard/features` — mirrors how `evm/wallet.ts` keeps EIP-6963 types local.
- `pnpm check` (svelte-check) must pass. `pnpm lint` (prettier + eslint) must pass.
- Run the Svelte MCP `svelte-autofixer` on every `.svelte` file until clean (per project CLAUDE.md).
- Scope: Solana devnet only. USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals, domain 5 — already in `SOLANA` in `src/lib/config.ts`.

**Testing note:** This repo has no test runner and the spec defines verification as manual. Tasks 1–3 gate on `pnpm check` (typecheck). Task 4 is the real end-to-end verification: connect Phantom on devnet and confirm the displayed balance matches the Circle faucet. Do not scaffold a test framework for throwaway code.

---

### Task 1: Dependencies + Kit RPC client

**Files:**
- Modify: `package.json` (deps added by pnpm)
- Create: `src/lib/solana/client.ts`

**Interfaces:**
- Consumes: `SOLANA.rpcUrl` from `src/lib/config.ts`.
- Produces: `solanaRpc` — a Kit RPC client used by `solana/usdc.ts`.

- [ ] **Step 1: Install dependencies**

Run:
```bash
pnpm add @solana/kit @solana-program/token @wallet-standard/app @wallet-standard/base
```
Expected: four packages added to `dependencies` in `package.json`, lockfile updated. Peer-dep *warnings* (e.g. `@solana-program/token` wanting a specific `@solana/kit` range) are acceptable; only a hard resolution error should block.

- [ ] **Step 2: Create the RPC client**

Create `src/lib/solana/client.ts`:
```ts
import { createSolanaRpc } from '@solana/kit';
import { SOLANA } from '$lib/config';

// Devnet JSON-RPC client. Balance reads go through this, not through the
// wallet, so Phantom's own cluster selection can't cause a wrong-network read.
export const solanaRpc = createSolanaRpc(SOLANA.rpcUrl);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS, no errors referencing `solana/client.ts` or the new deps.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/solana/client.ts
git commit -m "feat: add Solana Kit deps + devnet RPC client"
```

---

### Task 2: USDC balance via ATA

**Files:**
- Create: `src/lib/solana/usdc.ts`

**Interfaces:**
- Consumes: `solanaRpc` from `solana/client.ts`; `SOLANA.usdc.mint` from config; `address`/`createSolanaRpc` types from `@solana/kit`; `findAssociatedTokenPda`, `TOKEN_PROGRAM_ADDRESS` from `@solana-program/token`.
- Produces: `getUsdcBalance(owner: string): Promise<string>` — returns a decimal UI string (e.g. `"12.5"`), `"0"` when the owner has no USDC token account yet.

- [ ] **Step 1: Implement `getUsdcBalance`**

Create `src/lib/solana/usdc.ts`:
```ts
import { address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { SOLANA } from '$lib/config';
import { solanaRpc } from './client';

// Devnet USDC uses the classic SPL Token program (not Token-2022), so
// TOKEN_PROGRAM_ADDRESS is the correct token-program seed for the ATA.
export async function getUsdcBalance(owner: string): Promise<string> {
    const [ata] = await findAssociatedTokenPda({
        owner: address(owner),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: address(SOLANA.usdc.mint),
    });

    // The ATA does not exist until the owner first receives USDC. Probe with
    // getAccountInfo (returns null for a missing account) instead of letting
    // getTokenAccountBalance throw, so a genuine RPC failure still surfaces.
    const info = await solanaRpc.getAccountInfo(ata, { encoding: 'base64' }).send();
    if (info.value === null) return '0';

    const bal = await solanaRpc.getTokenAccountBalance(ata).send();
    return bal.value.uiAmountString ?? '0';
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. The tuple destructure `const [ata] = await findAssociatedTokenPda(...)` is correct — `findAssociatedTokenPda` returns `Promise<ProgramDerivedAddress>` and `ProgramDerivedAddress` is `readonly [Address, bump]` (verified against `@solana-program/token` generated source). Do NOT "fix" it to `[0]`; some AI-generated docs wrongly claim it returns `Promise<Address>`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/solana/usdc.ts
git commit -m "feat: read Solana devnet USDC balance via ATA"
```

Note: real exercise of this function happens in Task 4 (needs a funded devnet address).

---

### Task 3: Wallet Standard discovery + connect

**Files:**
- Create: `src/lib/solana/wallet.ts`

**Interfaces:**
- Consumes: `getWallets` from `@wallet-standard/app`; `Wallet` type from `@wallet-standard/base`; `browser` from `$app/environment`; `sleep` from `$lib/utils`.
- Produces:
  - `type SolanaWalletInfo = { name: string; icon: string; wallet: Wallet }`
  - `type SolanaWallet = { name: string; icon: string; address: string }`
  - `discoverSolanaWallets(): SolanaWalletInfo[]`
  - `connectSolana(info: SolanaWalletInfo): Promise<SolanaWallet>`
  - `detectExistingSolana(): Promise<SolanaWallet | null>`

- [ ] **Step 1: Implement the wallet module**

Create `src/lib/solana/wallet.ts`:
```ts
import { browser } from '$app/environment';
import { getWallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';
import { sleep } from '$lib/utils';

const NAME_STORAGE_KEY = 'cctp-demo:solana-wallet';

export type SolanaWalletInfo = {
    name: string;
    icon: string;
    wallet: Wallet;
};

export type SolanaWallet = {
    name: string;
    icon: string;
    address: string;
};

// Minimal shape of the standard:connect feature. Kept local rather than
// pulling @wallet-standard/features just for the type — mirrors how
// evm/wallet.ts keeps its EIP-6963 types local.
type ConnectableAccount = { address: string };
type ConnectFeature = {
    connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly ConnectableAccount[] }>;
};

function isSolana(w: Wallet): boolean {
    return w.chains.some((c) => c.startsWith('solana:')) && 'standard:connect' in w.features;
}

function connectFeature(w: Wallet): ConnectFeature {
    return w.features['standard:connect'] as unknown as ConnectFeature;
}

function readStoredName(): string | null {
    if (!browser) return null;
    try {
        return window.localStorage.getItem(NAME_STORAGE_KEY);
    } catch {
        return null;
    }
}

function writeStoredName(name: string): void {
    if (!browser) return;
    try {
        window.localStorage.setItem(NAME_STORAGE_KEY, name);
    } catch {
        // private windows / sandboxed iframes can throw — non-fatal.
    }
}

export function discoverSolanaWallets(): SolanaWalletInfo[] {
    if (!browser) return [];
    return getWallets()
        .get()
        .filter(isSolana)
        .map((w) => ({ name: w.name, icon: w.icon, wallet: w }));
}

export async function connectSolana(info: SolanaWalletInfo): Promise<SolanaWallet> {
    const { accounts } = await connectFeature(info.wallet).connect();
    if (accounts.length === 0) throw new Error('Wallet returned no accounts.');
    writeStoredName(info.name);
    return { name: info.name, icon: info.icon, address: accounts[0].address };
}

// Silent reconnect: standard:connect with { silent: true } asks the wallet to
// return previously-authorized accounts without prompting. `silent` is a HINT
// per the Wallet Standard spec — a wallet MAY prompt anyway. Null if the user
// never connected, the wallet is gone, or it declines.
//
// Timing: this runs on page load, when the wallet extension may not have
// registered yet. Wallet Standard's app-ready/register handshake usually makes
// getWallets().get() synchronously complete, but a late-injecting extension can
// miss the first pass — so if our stored wallet isn't present, wait briefly and
// look again once (mirrors the EIP-6963 sleep in evm/wallet.ts) before giving up.
export async function detectExistingSolana(): Promise<SolanaWallet | null> {
    if (!browser) return null;
    const name = readStoredName();
    if (!name) return null;

    let info = discoverSolanaWallets().find((w) => w.name === name);
    if (!info) {
        await sleep(250);
        info = discoverSolanaWallets().find((w) => w.name === name);
    }
    if (!info) return null;

    try {
        const { accounts } = await connectFeature(info.wallet).connect({ silent: true });
        if (accounts.length === 0) return null;
        return { name: info.name, icon: info.icon, address: accounts[0].address };
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. `w.icon` is a `data:image/...` branded string and assigns to `string` cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/lib/solana/wallet.ts
git commit -m "feat: Solana wallet discovery + connect via Wallet Standard"
```

---

### Task 4: Spike panel + route + end-to-end verification

**Files:**
- Create: `src/lib/components/SolanaPanel.svelte`
- Create: `src/routes/solana-spike/+page.svelte`

**Interfaces:**
- Consumes: `connectSolana`, `detectExistingSolana`, `discoverSolanaWallets`, `SolanaWallet` from `solana/wallet.ts`; `getUsdcBalance` from `solana/usdc.ts`; `shortAddr(addr, head?, tail?)` from `$lib/utils`.
- Produces: a browsable `/solana-spike` page.

- [ ] **Step 1: Create the panel**

Create `src/lib/components/SolanaPanel.svelte`:
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
    import { shortAddr } from '$lib/utils';

    let { wallet = $bindable<SolanaWallet | null>(null) }: { wallet?: SolanaWallet | null } =
        $props();

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
        if (!wallet) return;
        error = null;
        try {
            balance = await getUsdcBalance(wallet.address);
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    async function connect() {
        error = null;
        connecting = true;
        try {
            const wallets = discoverSolanaWallets();
            if (wallets.length === 0) {
                throw new Error('No Solana wallet found. Install Phantom from phantom.app and reload.');
            }
            const pick = wallets.find((w) => w.name.toLowerCase().includes('phantom')) ?? wallets[0];
            wallet = await connectSolana(pick);
            await refreshBalance();
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        } finally {
            connecting = false;
        }
    }
</script>

<div class="panel">
    <h2>Solana (devnet)</h2>
    {#if !wallet}
        <button onclick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect Phantom'}
        </button>
    {:else}
        <p>Wallet: {wallet.name}</p>
        <p><code title={wallet.address}>{shortAddr(wallet.address, 6, 6)}</code></p>
        <p>USDC: {balance ?? '…'}</p>
        <button onclick={refreshBalance}>Refresh</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
    .panel {
        border: 1px solid currentColor;
        border-radius: 8px;
        padding: 1rem;
        max-width: 24rem;
    }
    .error {
        color: crimson;
    }
</style>
```

- [ ] **Step 2: Validate the component with Svelte MCP**

Run the `svelte-autofixer` MCP tool on `src/lib/components/SolanaPanel.svelte`. Apply fixes and re-run until it reports no issues.

- [ ] **Step 3: Create the route**

Create `src/routes/solana-spike/+page.svelte`:
```svelte
<script lang="ts">
    import SolanaPanel from '$lib/components/SolanaPanel.svelte';
    import type { SolanaWallet } from '$lib/solana/wallet';

    let wallet = $state<SolanaWallet | null>(null);
</script>

<h1>Solana balance spike</h1>
<SolanaPanel bind:wallet />
```

- [ ] **Step 4: Validate the route with Svelte MCP**

Run `svelte-autofixer` on `src/routes/solana-spike/+page.svelte`; apply fixes until clean.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm check && pnpm lint`
Expected: both PASS.

- [ ] **Step 6: End-to-end manual verification (the point of the spike)**

Precondition: Phantom installed and the connecting account funded with devnet USDC from https://faucet.circle.com (Solana Devnet). Phantom's own cluster setting does NOT matter — balance reads go through the app's pinned devnet RPC and the account address is cluster-independent (that's the design point).

1. Run: `pnpm dev`
2. Open `http://localhost:5173/solana-spike` (port 5173 is Vite's default; use whatever URL `pnpm dev` prints)
3. Click **Connect Phantom**, approve in the wallet.
4. Confirm the short address matches the Phantom account.
5. Confirm **USDC** shows the faucet amount (or `0` if that address holds none).

**Pass criterion:** step 5 balance matches the faucet. Green = RPC + Wallet Standard + ATA resolution all work end-to-end.

**Nice-to-have (not a pass gate):** reload the page and see the wallet + balance reappear without a prompt. `silent` reconnect is a Wallet Standard hint Phantom may ignore depending on version / trusted-app state — if it re-prompts or doesn't auto-restore, that's acceptable, not a bug in the stack.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/SolanaPanel.svelte src/routes/solana-spike/+page.svelte
git commit -m "feat: /solana-spike panel — connect Phantom + read USDC balance"
```

---

## Verification summary

- Task 1–3: `pnpm check` passes after each.
- Task 4: `/solana-spike` connects Phantom and displays a devnet USDC balance matching the Circle faucet; reload silently reconnects.

Once green, the spike has de-risked the stack and the CCTP burn/mint work can build on `solana/client.ts`, `solana/wallet.ts`, and `solana/usdc.ts`.
