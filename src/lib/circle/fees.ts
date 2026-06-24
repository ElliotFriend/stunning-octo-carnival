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

// ─────────────────────────────────────────────────────────────────────
//  EXPERIMENTAL — Circle Crosschain Forwarding Service fee quote
// ─────────────────────────────────────────────────────────────────────
// `?forward=true` augments each row with a `forwardFee` (absolute, in canonical
// 6-dp CCTP units, ~$0.20). The service fee covers destination gas + Circle's
// cut, deducted from the minted USDC. Stellar is not a documented forwarder
// source, but the endpoint returns a forwardFee for it anyway — which is part of
// what this experiment is testing.
export type ForwardFee = { low: number; med: number; high: number };
export type ForwardFeeRow = BurnFeeRow & { forwardFee?: ForwardFee };

const forwardCache = new Map<string, Promise<ForwardFeeRow[]>>();

export function fetchForwardFee(srcDomain: number, dstDomain: number): Promise<ForwardFeeRow[]> {
    const key = `${srcDomain}-${dstDomain}`;
    let p = forwardCache.get(key);
    if (!p) {
        p = (async () => {
            const res = await fetch(
                `${IRIS_API}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}?forward=true`,
            );
            if (!res.ok) throw new Error(`Forward fee API ${res.status}: ${await res.text()}`);
            return (await res.json()) as ForwardFeeRow[];
        })().catch((err) => {
            forwardCache.delete(key);
            throw err;
        });
        forwardCache.set(key, p);
    }
    return p;
}

// maxFee bound for a forwarder-triggered Stellar burn. `forwardFee.high` is in
// 6-dp CCTP units; the Stellar burn-token max_fee is 7-dp, so scale by 10 and
// pad with `floor`. maxFee is a CAP (only feeExecuted <= maxFee is charged), so
// deliberately over-provisioning is safe — we do, because the source-token
// denomination of forwardFee for a Stellar origin is unverified.
export function forwardedMaxFeeStellar(
    rows: ForwardFeeRow[],
    speed: TransferSpeed,
    floor: bigint,
): bigint {
    const threshold = thresholdFor(speed);
    const row = rows.find((r) => r.finalityThreshold === threshold) ?? rows[0];
    const high = row?.forwardFee?.high ?? 0;
    return BigInt(Math.ceil(high)) * 10n + floor;
}
