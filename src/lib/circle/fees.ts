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
