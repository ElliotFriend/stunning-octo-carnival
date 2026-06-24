# Fast Transfer (CCTP V2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Standard/Fast toggle to the CCTP demo that switches the burn between Standard (finalized, threshold 2000) and Fast (threshold 1000) transfers, computing `maxFee` from Circle's live fee API.

**Architecture:** Speed is `$state` in `+page.svelte`, passed down via props (toggle in `TransferForm`) and into `transfer.start()`. A new `circle/fees.ts` module quotes the route fee (bps) from Circle's fee API and derives `maxFee`. Burn functions stop importing the threshold/maxFee constants and accept them as arguments; the runner computes them per transfer. No `$effect` — previews use `$derived` + `{#await}`.

**Tech Stack:** SvelteKit 5 (Svelte 5 runes), TypeScript, viem, @stellar/stellar-sdk, Circle Iris/fee API.

## Global Constraints

- No `$effect` in Svelte components — explicit dataflow only (props down, `bind:` up, `$derived` for computed).
- Every `.svelte` / `.svelte.ts` edit must pass the Svelte MCP `svelte-autofixer` (run until no issues) before commit, per project CLAUDE.md.
- No new test toolchain (vitest etc.) — verification is `npm run check` + `npm run lint` + manual testnet runs.
- `maxFee = ceil(amount * bps / 10000) + floor`; floor = `STELLAR_MAX_FEE` (7-dp Stellar subunits) for a Stellar-source burn, `EVM_MAX_FEE` (6-dp) for an EVM-source burn.
- Thresholds: Standard = 2000, Fast = 1000. Fee API: `GET {IRIS_API}/v2/burn/USDC/fees/{srcDomain}/{dstDomain}` → `[{finalityThreshold, minimumFee}]`, `minimumFee` in basis points.
- Keep `npm run check` green after every task (temporary `FINALIZED_THRESHOLD` alias in config until Task 3 removes it).

---

### Task 1: Config speed types + fee module

**Files:**

- Modify: `src/lib/config.ts` (around lines 97–115)
- Create: `src/lib/circle/fees.ts`

**Interfaces:**

- Consumes: `IRIS_API` (existing, `config.ts:95`).
- Produces:
    - `config.ts`: `type TransferSpeed = 'standard' | 'fast'`, `DEFAULT_SPEED: TransferSpeed`, `FAST_THRESHOLD = 1000`, `STANDARD_THRESHOLD = 2000`, `FINALIZED_THRESHOLD` (temporary alias = `STANDARD_THRESHOLD`), unchanged `STELLAR_MAX_FEE: bigint`, `EVM_MAX_FEE: bigint`.
    - `fees.ts`: `type BurnFeeRow = { finalityThreshold: number; minimumFee: number }`, `fetchBurnFee(srcDomain: number, dstDomain: number): Promise<BurnFeeRow[]>`, `thresholdFor(speed: TransferSpeed): number`, `feeBpsFor(rows: BurnFeeRow[], speed: TransferSpeed): number`, `computeMaxFee(amount: bigint, bps: number, floor: bigint): bigint`.

- [ ] **Step 1: Edit `src/lib/config.ts`**

Replace the threshold block (lines ~97–101) with:

```ts
// CCTP V2 finality thresholds for the burn.
//   STANDARD (2000) = wait for source-chain finality (~13 min on L2s,
//                     seconds on Arc). minimumFee is 0.
//   FAST     (1000) = mint before finality; Circle charges a fast fee
//                     (basis points of the amount) bounded by max_fee.
export const STANDARD_THRESHOLD = 2000;
export const FAST_THRESHOLD = 1000;
// Temporary alias kept so existing importers compile until the UI task
// switches them to the speed-aware path. Removed in Task 3.
export const FINALIZED_THRESHOLD = STANDARD_THRESHOLD;

export type TransferSpeed = 'standard' | 'fast';
export const DEFAULT_SPEED: TransferSpeed = 'standard';
```

Leave the `STELLAR_MAX_FEE` / `EVM_MAX_FEE` block and its comment as-is (now the per-source floor/buffer added on top of the computed fee).

- [ ] **Step 2: Create `src/lib/circle/fees.ts`**

```ts
import { IRIS_API, FAST_THRESHOLD, STANDARD_THRESHOLD, type TransferSpeed } from '$lib/config';

export type BurnFeeRow = { finalityThreshold: number; minimumFee: number };

// Route fee is amount-independent, so cache by route. Failures are not
// cached (the entry is dropped) so a transient API blip can be retried.
const cache = new Map<string, Promise<BurnFeeRow[]>>();

export function fetchBurnFee(srcDomain: number, dstDomain: number): Promise<BurnFeeRow[]> {
    const key = `${srcDomain}-${dstDomain}`;
    let p = cache.get(key);
    if (!p) {
        p = (async () => {
            const res = await fetch(`${IRIS_API}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`);
            if (!res.ok) throw new Error(`Fee API ${res.status}: ${await res.text()}`);
            return (await res.json()) as BurnFeeRow[];
        })().catch((err) => {
            cache.delete(key);
            throw err;
        });
        cache.set(key, p);
    }
    return p;
}

export function thresholdFor(speed: TransferSpeed): number {
    return speed === 'fast' ? FAST_THRESHOLD : STANDARD_THRESHOLD;
}

// minimumFee for the row matching the speed's threshold; 0 if absent.
export function feeBpsFor(rows: BurnFeeRow[], speed: TransferSpeed): number {
    const threshold = thresholdFor(speed);
    return rows.find((r) => r.finalityThreshold === threshold)?.minimumFee ?? 0;
}

// maxFee in burn-token subunits. `bps` is basis points of the amount
// (e.g. 1.3). Only feeExecuted (<= maxFee) is charged on-chain, so adding
// `floor` is safe headroom against a quote tick between preview and submit.
// Number() is fine for demo-sized amounts; revisit if amounts approach 2^53.
export function computeMaxFee(amount: bigint, bps: number, floor: bigint): bigint {
    const fee = BigInt(Math.ceil((Number(amount) * bps) / 10000));
    return fee + floor;
}
```

- [ ] **Step 3: Type-check**

Run: `npm run check`
Expected: PASS (no errors). The temporary `FINALIZED_THRESHOLD` alias keeps `stellar/cctp.ts`, `evm/cctp.ts`, and both preview components compiling unchanged.

- [ ] **Step 4: Acceptance check for `computeMaxFee` (concrete values)**

No unit runner; verify the arithmetic against these cases by inspection of the implementation (they are also exercised by the Task 3 manual runs):

- `computeMaxFee(10_000_000n, 1.3, 500n)` → `ceil(10_000_000 * 1.3 / 10000) = 1300`, `+500` → `1800n` (Base→Stellar Fast, $10, 6-dp).
- `computeMaxFee(10_000_000n, 0, 500n)` → `0 + 500` → `500n` (Standard / zero-bps Fast).
- `computeMaxFee(100_000_000n, 1.3, 500n)` → `ceil(13_000) + 500` → `13_500n`.

Confirm the code yields these. Fix the formula if not.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/circle/fees.ts
git commit -m "feat: add transfer-speed config + Circle fee-quote module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Thread maxFee + threshold through burn fns and runner

**Files:**

- Modify: `src/lib/stellar/cctp.ts` (lines 10, 21–95)
- Modify: `src/lib/evm/cctp.ts` (lines 3–10, 138–297)
- Modify: `src/lib/stores/transfer.svelte.ts` (imports + runners + `start`)
- Modify: `src/routes/+page.svelte` (add `speed` state + pass into `start`)

**Interfaces:**

- Consumes: `computeMaxFee`, `feeBpsFor`, `thresholdFor`, `fetchBurnFee` (Task 1); `STELLAR_MAX_FEE`, `EVM_MAX_FEE`, `DEFAULT_SPEED`, `TransferSpeed`.
- Produces:
    - `stellar/cctp.ts`: `depositForBurnToEvm` and `bridgeUsdcToEvm` arg objects gain `maxFee: bigint` and `finalityThreshold: number`.
    - `evm/cctp.ts`: `buildBurnToStellar(chainId, amount, stellarRecipient, maxFee, finalityThreshold)`; `depositForBurnWithHookToStellar`, `bridgeWithPermitToStellar`, `sendCallsBridgeToStellar` arg objects gain `maxFee: bigint`, `finalityThreshold: number`.
    - `transfer.svelte.ts`: `start(args)` and `runStellarToEvm`/`runEvmToStellar` args gain `speed: TransferSpeed`.

- [ ] **Step 1: `src/lib/stellar/cctp.ts` — drop constant imports, take args**

Change the import on line 10 from:

```ts
import { STELLAR, FINALIZED_THRESHOLD, STELLAR_MAX_FEE } from '$lib/config';
```

to:

```ts
import { STELLAR } from '$lib/config';
```

In `depositForBurnToEvm`, extend the args type and use them:

```ts
export async function depositForBurnToEvm(args: {
    caller: string;
    amount: bigint; // Stellar 7-decimal subunits
    destinationDomain: number;
    evmRecipient: `0x${string}`;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<{ hash: string; sourceDomain: number }> {
```

and replace lines 45–46 (`nativeToScVal(STELLAR_MAX_FEE, ...)` / `nativeToScVal(FINALIZED_THRESHOLD, ...)`) with:

```ts
                nativeToScVal(args.maxFee, { type: 'i128' }),
                nativeToScVal(args.finalityThreshold, { type: 'u32' }),
```

Do the same for `bridgeUsdcToEvm`: add `maxFee: bigint; finalityThreshold: number;` to its args type, and replace lines 86–87 with the same two `args.maxFee` / `args.finalityThreshold` lines.

(`mintAndForward` is unchanged — it's the destination mint, no burn params.)

- [ ] **Step 2: `src/lib/evm/cctp.ts` — drop constant imports, take args**

Change the import (lines 3–10) to remove `FINALIZED_THRESHOLD` and `EVM_MAX_FEE`:

```ts
import { EVM_CCTP_CONTRACTS, EVM_CHAINS, STELLAR, type EvmChainId } from '$lib/config';
```

Update `buildBurnToStellar` (lines 138–153):

```ts
function buildBurnToStellar(
    chainId: EvmChainId,
    amount: bigint,
    stellarRecipient: string,
    maxFee: bigint,
    finalityThreshold: number,
) {
    const cfg = EVM_CHAINS[chainId];
    const forwarderBytes32 = strkeyToBytes32(STELLAR.contracts.cctpForwarder);
    const hookData = encodeStellarForwarderHookData(stellarRecipient);
    const burnArgs = [
        amount, //                  amount
        STELLAR.domain, //          destinationDomain (Stellar's CCTP domain)
        forwarderBytes32, //        mintRecipient (the forwarder — see invariant)
        cfg.usdc, //                burnToken (per-chain USDC address)
        forwarderBytes32, //        destinationCaller (MUST equal mintRecipient)
        maxFee, //                  maxFee
        finalityThreshold, //       minFinalityThreshold
        hookData, //                hookData (G-address routing payload)
    ] as const;
    return { cfg, forwarderBytes32, hookData, burnArgs };
}
```

For each of the three burn flows, add `maxFee: bigint; finalityThreshold: number;` to the args object and forward them into `buildBurnToStellar`:

`depositForBurnWithHookToStellar` (line 162) args + call:

```ts
export async function depositForBurnWithHookToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, burnArgs } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );
```

`bridgeWithPermitToStellar` (line 196) args + the `buildBurnToStellar` call at line 202:

```ts
export async function bridgeWithPermitToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, forwarderBytes32, hookData } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );
```

and in its `args: [...]` array (lines 226–238) replace `EVM_MAX_FEE` with `args.maxFee` and `FINALIZED_THRESHOLD` with `args.finalityThreshold`.

`sendCallsBridgeToStellar` (line 257) args + the `buildBurnToStellar` call at line 263:

```ts
export async function sendCallsBridgeToStellar(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    finalityThreshold: number;
}): Promise<`0x${string}`> {
    const { cfg, burnArgs } = buildBurnToStellar(
        args.chainId,
        args.amount,
        args.stellarRecipient,
        args.maxFee,
        args.finalityThreshold,
    );
```

- [ ] **Step 3: `src/lib/stores/transfer.svelte.ts` — compute and pass**

Add imports near the top (after the existing `$lib/config` import block, lines 2–10) — extend the config import with the floor constants + speed type, and add the fees import:

```ts
import {
    EVM_CCTP_CONTRACTS,
    EVM_CHAINS,
    STELLAR,
    STELLAR_MAX_FEE,
    EVM_MAX_FEE,
    type Direction,
    type EvmChainId,
    type InboundFlow,
    type OutboundFlow,
    type TransferSpeed,
} from '$lib/config';
import { fetchBurnFee, feeBpsFor, thresholdFor, computeMaxFee } from '$lib/circle/fees';
```

In `runStellarToEvm`, add `speed: TransferSpeed;` to the args type, and after `const evmCfg = EVM_CHAINS[args.evmChainId];` (line 188) compute the burn params:

```ts
const feeRows = await fetchBurnFee(STELLAR.domain, evmCfg.domain);
const maxFee = computeMaxFee(stellarAmount, feeBpsFor(feeRows, args.speed), STELLAR_MAX_FEE);
const finalityThreshold = thresholdFor(args.speed);
```

Then pass `maxFee, finalityThreshold` into both `bridgeUsdcToEvm({...})` (line 196) and `depositForBurnToEvm({...})` (line 236) calls — add the two fields to each call's object:

```ts
                    maxFee,
                    finalityThreshold,
```

In `runEvmToStellar`, add `speed: TransferSpeed;` to the args type, and after `const evmCfg = EVM_CHAINS[args.evmChainId];` (line 290) compute:

```ts
const feeRows = await fetchBurnFee(evmCfg.domain, STELLAR.domain);
const maxFee = computeMaxFee(evmAmount, feeBpsFor(feeRows, args.speed), EVM_MAX_FEE);
const finalityThreshold = thresholdFor(args.speed);
```

Then add `maxFee, finalityThreshold` to all three burn calls: `bridgeWithPermitToStellar({...})` (line 298), `sendCallsBridgeToStellar({...})` (line 317), and `depositForBurnWithHookToStellar({...})` (line 361).

In `start(args)` (line 407), add `speed: TransferSpeed;` to the args type. The runners receive `args` directly (`runStellarToEvm(args)` / `runEvmToStellar(args)` at lines 430/432), so `speed` flows through automatically.

`resume()` is unchanged (no burn).

- [ ] **Step 4: `src/routes/+page.svelte` — add speed state, pass into start**

Add `DEFAULT_SPEED` and `TransferSpeed` to the config import (lines 15–24):

```ts
        DEFAULT_SPEED,
```

and in the type list:

```ts
        type TransferSpeed,
```

Add state after `let amount = $state('');` (line 37):

```ts
let speed = $state<TransferSpeed>(DEFAULT_SPEED);
```

In `send()` (line 63), add `speed` to the `transfer.start({...})` call:

```ts
            speed,
```

(The `TransferForm` toggle and preview wiring come in Task 3; this step only keeps the data path type-correct.)

- [ ] **Step 5: Type-check and lint**

Run: `npm run check`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stellar/cctp.ts src/lib/evm/cctp.ts src/lib/stores/transfer.svelte.ts src/routes/+page.svelte
git commit -m "feat: derive maxFee + finality threshold per transfer from fee API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Speed toggle UI + live-fee previews

**Files:**

- Modify: `src/lib/components/TransferForm.svelte` (add toggle + `bind:speed`)
- Modify: `src/routes/+page.svelte` (pass `speed` to `TransferForm` + both previews)
- Modify: `src/lib/components/StellarBurnPreview.svelte` (lines 5–7, 18–24, 188–197, 304–311)
- Modify: `src/lib/components/EvmBurnPreview.svelte` (lines 5–6, 25–32, 368–377)
- Modify: `src/lib/config.ts` (remove the temporary `FINALIZED_THRESHOLD` alias)

**Interfaces:**

- Consumes: `speed` state (Task 2), `fetchBurnFee`, `feeBpsFor`, `thresholdFor`, `computeMaxFee` (Task 1), `STELLAR_MAX_FEE`/`EVM_MAX_FEE`, `STELLAR.domain`/`EVM_CHAINS[id].domain`.
- Produces: `TransferForm` prop `speed` (bindable); both previews accept a `speed: TransferSpeed` prop.

- [ ] **Step 1: Read `TransferForm.svelte` to match its existing props pattern**

Run: `Read src/lib/components/TransferForm.svelte`
Confirm the `$props()` shape and styling conventions before editing.

- [ ] **Step 2: Add the Standard/Fast toggle to `TransferForm.svelte`**

Add `speed = $bindable()` to the component's `$props()` destructure with type `TransferSpeed` (import the type from `$lib/config`). Render a two-button segmented control bound to `speed` (mirror the existing flow-toggle markup style used in `StellarPanel`/`EvmPanel`), with values `'standard'` and `'fast'`, and a one-line ETA caption: Fast ≈ seconds, Standard = source-chain finality. Disable the control when `disabled` is true.

Run the Svelte autofixer on the file until clean:

- Use `mcp__plugin_svelte_svelte__svelte-autofixer` (or the `svelte-file-editor` agent) and re-run until no issues/suggestions.

- [ ] **Step 3: Pass `speed` from `+page.svelte` into `TransferForm` and the previews**

In the `<TransferForm ... />` usage (lines 129–137) add:

```svelte
bind:speed
```

In `<EvmBurnPreview ... />` (lines 145–152) add:

```svelte
{speed}
```

In `<StellarBurnPreview ... />` (lines 156–162) add:

```svelte
{speed}
```

- [ ] **Step 4: Make `StellarBurnPreview.svelte` speed-aware**

Replace the `FINALIZED_THRESHOLD` / `STELLAR_MAX_FEE` config imports (lines 5–7) with the fee helpers + floor + speed type:

```ts
        STELLAR,
        STELLAR_MAX_FEE,
        type TransferSpeed,
    } from '$lib/config';
    import { fetchBurnFee, feeBpsFor, thresholdFor, computeMaxFee } from '$lib/circle/fees';
```

(keep whatever else the component already imports from `$lib/config`, e.g. `EVM_CHAINS`).

Add `speed` to `$props()` with type `TransferSpeed` and the existing props. Add a route-keyed fee promise (no `$effect`):

```ts
let destDomain = $derived(EVM_CHAINS[evmChainId].domain);
let feePromise = $derived(fetchBurnFee(STELLAR.domain, destDomain));
let threshold = $derived(thresholdFor(speed));
```

Where the burn amount is parsed in this component (the existing `amount`-parsing `$derived` near line 35), expose the parsed bigint (e.g. `parsedAmount`). Then render the `max_fee` and `minFinalityThreshold` rows (lines ~188–197 and ~304–311) inside an `{#await feePromise}` block:

```svelte
{#await feePromise then rows}
    {@const bps = feeBpsFor(rows, speed)}
    <code class="arg-value">{computeMaxFee(parsedAmount, bps, STELLAR_MAX_FEE).toString()}</code>
    <!-- ... and for the threshold row: -->
    <code class="arg-value">{threshold}</code>
    <!-- optional caption: Fast fee {bps} bps -->
{:catch}
    <code class="arg-value">{STELLAR_MAX_FEE.toString()}</code>
{/await}
```

Apply the same to both `max_fee`/threshold display sites in this file (the two-tx and wrapper variants). Use `threshold` for every `minFinalityThreshold` display.

Run the Svelte autofixer until clean.

- [ ] **Step 5: Make `EvmBurnPreview.svelte` speed-aware**

Replace the `EVM_MAX_FEE` / `FINALIZED_THRESHOLD` imports (lines 5–6) with:

```ts
        EVM_MAX_FEE,
        STELLAR,
        type TransferSpeed,
    } from '$lib/config';
    import { fetchBurnFee, feeBpsFor, thresholdFor, computeMaxFee } from '$lib/circle/fees';
```

(keep existing `EVM_CHAINS` import). Add `speed: TransferSpeed` to `$props()`. Add:

```ts
let srcDomain = $derived(EVM_CHAINS[evmChainId].domain);
let feePromise = $derived(fetchBurnFee(srcDomain, STELLAR.domain));
let threshold = $derived(thresholdFor(speed));
```

Expose the parsed amount bigint (`parsedAmount`) from the existing amount `$derived` (line ~46). Render the `maxFee` (line ~370) and `minFinalityThreshold` (line ~377) rows inside an `{#await feePromise}` block, same pattern as Step 4 but with `EVM_MAX_FEE` as the floor and `srcDomain → STELLAR.domain` route.

Run the Svelte autofixer until clean.

- [ ] **Step 6: Remove the temporary alias from `config.ts`**

Delete the `FINALIZED_THRESHOLD` export added in Task 1 (the alias line + its comment). Nothing should import it anymore.

- [ ] **Step 7: Type-check and lint**

Run: `npm run check`
Expected: PASS, and no remaining references to `FINALIZED_THRESHOLD` (a leftover import would fail here).
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 8: Manual verification on testnet**

Run: `npm run dev`, connect Freighter + an EVM wallet, then:

1. **Stellar→Base, Fast** — preview shows `minFinalityThreshold 1000`, fee 0 bps, `maxFee` = floor (`100000`). Run it; attestation returns quickly; mint lands on Base.
2. **Base→Stellar, Fast, $10** — preview shows `1000`, fee 1.3 bps, `maxFee` = `1800` (`ceil(10_000_000*1.3/10000)=1300 + 500`). Run it; burn does NOT revert with `InsufficientMaxFee`; `mint_and_forward` lands on Stellar.
3. **Stellar→Base, Standard** — preview shows `2000`, `maxFee` = floor; confirms no regression of the original path.

- [ ] **Step 9: Commit**

```bash
git add src/lib/components/TransferForm.svelte src/routes/+page.svelte src/lib/components/StellarBurnPreview.svelte src/lib/components/EvmBurnPreview.svelte src/lib/config.ts
git commit -m "feat: Standard/Fast transfer toggle with live fee-quoted previews

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

- Speed state in `+page.svelte`, toggle in `TransferForm` → Task 2 Step 4, Task 3 Steps 2–3. ✓
- `config.ts` types/thresholds → Task 1 Step 1. ✓
- `circle/fees.ts` (fetch/memo/feeBps/threshold/computeMaxFee) → Task 1 Step 2. ✓
- Burn fns take maxFee+threshold → Task 2 Steps 1–2. ✓
- Runner computes + threads, resume untouched → Task 2 Step 3. ✓
- Previews live fee via `$derived` + `{#await}`, no `$effect` → Task 3 Steps 4–5. ✓
- ETA copy → Task 3 Step 2. ✓
- Floor = per-source constant → Task 2 Step 3 (STELLAR_MAX_FEE / EVM_MAX_FEE). ✓
- Verification (check/lint/manual, incl. 1.3 bps Base→Stellar) → Task 3 Steps 7–8. ✓

**Placeholder scan:** Component-internal markup (toggle, preview rows) is described against exact line anchors with the runes/`{#await}` code shown; `parsedAmount` exposure is specified. No TBD/TODO. ✓

**Type consistency:** `TransferSpeed`, `BurnFeeRow`, `fetchBurnFee`/`feeBpsFor`/`thresholdFor`/`computeMaxFee` signatures, and the `maxFee: bigint` / `finalityThreshold: number` burn-fn fields are used identically across Tasks 1–3. `FINALIZED_THRESHOLD` alias is introduced (Task 1) and removed (Task 3) — green check held in between. ✓
