# Fast Transfer (CCTP V2) — design

Date: 2026-06-24
Status: approved, pre-implementation

## Goal

Let the demo exercise CCTP V2 **Fast Transfer** alongside the existing Standard
(finalized) path, in both directions (Stellar↔EVM), via a user-facing
Standard/Fast toggle. Fast Transfer requires two things on the burn:

1. `minFinalityThreshold ≤ 1000` (today hardcoded to `2000` = Standard)
2. `maxFee ≥` Circle's minimum **fast fee** for the route — which is quoted in
   **basis points of the burn amount**, so `maxFee` must scale with amount.

Confirmed against Circle's sandbox fee API (`/v2/burn/USDC/fees/{src}/{dst}`)
on 2026-06-24:

| Route               | Fast (threshold 1000) | Standard (2000) |
| ------------------- | --------------------- | --------------- |
| Stellar→Base (27→6) | 0 bps                 | 0               |
| Stellar→Arc (27→26) | 0 bps                 | 0               |
| Base→Stellar (6→27) | **1.3 bps**           | 0               |
| Arc→Stellar (26→27) | 0 bps                 | 0               |

So Fast from Stellar is free on testnet; Base→Stellar Fast charges 1.3 bps —
the case that proves the hardcoded `EVM_MAX_FEE=500` (~$0.0005) would revert
with `InsufficientMaxFee` (#7105) above ~$3.85.

## Non-goals

- Relayer / automated destination mint (separate effort).
- Showing Standard and Fast previews simultaneously — it's a toggle, one at a time.
- Changing the existing flow toggles (wrapper / two-tx / send-calls).

## Architecture

Follows the codebase convention: state owned in `+page.svelte` as `$state`,
passed down via props, lifted via `bind:`. **No `$effect`** (explicit dataflow
only — see memory `feedback_no_effect`).

### 1. Config (`src/lib/config.ts`)

- `export type TransferSpeed = 'standard' | 'fast';`
- `export const DEFAULT_SPEED: TransferSpeed = 'standard';`
- Rename `FINALIZED_THRESHOLD` → `STANDARD_THRESHOLD = 2000`; add
  `FAST_THRESHOLD = 1000`.
- Keep `STELLAR_MAX_FEE` / `EVM_MAX_FEE` — repurposed as the per-chain
  **floor/buffer** added on top of the computed fee (and the whole maxFee for
  Standard, where bps = 0).

### 2. Fee quoting (new `src/lib/circle/fees.ts`)

- `fetchBurnFee(srcDomain, dstDomain): Promise<BurnFeeRow[]>` — GET
  `${IRIS_API}/v2/burn/USDC/fees/{src}/{dst}`. Returns both rows
  `[{ finalityThreshold, minimumFee }]`. Memoized by `"${src}-${dst}"` so the
  preview and the runner don't double-fetch and keystrokes don't refetch
  (route fee is amount-independent).
- `feeBpsFor(rows, speed): number` — picks the row matching the speed's
  threshold, returns `minimumFee` (bps). Standard → 0.
- `thresholdFor(speed): number` — `fast ? FAST_THRESHOLD : STANDARD_THRESHOLD`.
- `computeMaxFee(amount: bigint, bps: number, floor: bigint): bigint` —
  `ceil(amount * bps / 10000) + floor`. Pure function (the one unit-testable
  bit). Padding is safe: only `feeExecuted` (≤ maxFee) is charged on-chain, so
  headroom absorbs a quote tick between preview and submit. `bps` is fractional
  (e.g. 1.3); compute via `Math.ceil(Number(amount) * bps / 10000)` then
  `BigInt(...)`. Acceptable for demo-sized amounts; note the Number() precision
  caveat in a comment.

### 3. Burn functions take maxFee + threshold as args

Stop importing the threshold/maxFee constants inside the burn fns; accept them
from the caller (the runner computes them).

- `src/lib/stellar/cctp.ts`: `depositForBurnToEvm`, `bridgeUsdcToEvm` gain
  `maxFee: bigint`, `finalityThreshold: number`.
- `src/lib/evm/cctp.ts`: `depositForBurnWithHookToStellar`,
  `bridgeWithPermitToStellar`, `sendCallsBridgeToStellar` gain the same;
  `buildBurnToStellar` takes them and drops the constant imports.

### 4. Runner (`src/lib/stores/transfer.svelte.ts`)

- `start()` and both runners gain `speed: TransferSpeed`.
- Inside the burn step, before calling the burn fn: fetch the route fee rows
  (cached), `bps = feeBpsFor(rows, speed)`, `maxFee = computeMaxFee(amount, bps,
floor)`, `threshold = thresholdFor(speed)`. Floor = `STELLAR_MAX_FEE` for the
  Stellar source, `EVM_MAX_FEE` for the EVM source. Pass both into the burn fn.
- A fee-fetch failure surfaces through the existing `performStep` error funnel.
- `resume()` is unchanged — it skips the burn, so speed is irrelevant there.

### 5. UI

- **`TransferForm.svelte`**: add a segmented Standard/Fast control,
  `bind:speed`. Placed here (not the panels) because speed is source-agnostic
  and applies to both directions, unlike the per-panel flow toggles. Short ETA
  note: Fast ≈ seconds; Standard = chain finality.
- **`+page.svelte`**: `let speed = $state<TransferSpeed>(DEFAULT_SPEED)`; pass
  to `TransferForm`, both burn previews, and `transfer.start({ ..., speed })`.
- **`StellarBurnPreview.svelte` / `EvmBurnPreview.svelte`**: take `speed` prop.
  Fetch fee bps via `let feePromise = $derived(fetchBurnFee(src, dst))` +
  `{#await}` (re-runs only when the route changes, not per keystroke). Compute
  maxFee sync from amount. Display the selected `minFinalityThreshold`, the
  computed `maxFee`, and the quoted fee (e.g. "Fast fee: 1.3 bps ≈ $0.0013").

## Error handling

- Fee endpoint unreachable / non-200 → throw; runner reports via existing error
  state. Preview shows the `{:catch}` branch with a plain message and falls back
  to displaying the floor maxFee.
- `InsufficientMaxFee` (#7105) should not occur given the bps-derived maxFee +
  floor, but the existing burn error path still surfaces it if Circle bumps the
  rate mid-flight.

## Testing / verification

No JS test runner in the repo (only `svelte-check` + eslint). Verification:

1. `npm run check` — types (esp. the new `TransferSpeed` threading).
2. `npm run lint`.
3. Manual on testnet: Stellar→Base Fast (free), Base→Stellar Fast (1.3 bps,
   confirm maxFee covers it and the mint lands), and a Standard run to confirm
   no regression.

Optional follow-up: add vitest + a `computeMaxFee` unit test (rounding, floor,
fractional bps, zero bps). Out of scope for this change to avoid pulling in a
test toolchain.

## Files touched

- `src/lib/config.ts` (modify)
- `src/lib/circle/fees.ts` (new)
- `src/lib/stellar/cctp.ts` (modify)
- `src/lib/evm/cctp.ts` (modify)
- `src/lib/stores/transfer.svelte.ts` (modify)
- `src/lib/components/TransferForm.svelte` (modify)
- `src/routes/+page.svelte` (modify)
- `src/lib/components/StellarBurnPreview.svelte` (modify)
- `src/lib/components/EvmBurnPreview.svelte` (modify)
