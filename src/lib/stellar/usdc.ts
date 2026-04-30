import {
    Account,
    Address,
    BASE_FEE,
    Contract,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
} from '@stellar/stellar-sdk';
import { STELLAR } from '$lib/config';
import { stellarRpc } from './client';
import { simulateSignAndSubmit } from './tx';

const usdc = new Contract(STELLAR.contracts.usdc);

export async function getUsdcBalance(stellarAddress: string): Promise<bigint> {
    const sim = await stellarRpc.simulateTransaction(await buildBalanceProbe(stellarAddress));
    if ('error' in sim && sim.error) {
        throw new Error(`balance simulation failed: ${sim.error}`);
    }
    const result = (sim as { result?: { retval: unknown } }).result;
    if (!result) return 0n;
    const native = scValToNative(result.retval as never);
    return typeof native === 'bigint' ? native : BigInt(native ?? 0);
}

async function buildBalanceProbe(stellarAddress: string) {
    const acct = new Account(stellarAddress, '0');
    return new TransactionBuilder(acct, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(usdc.call('balance', Address.fromString(stellarAddress).toScVal()))
        .setTimeout(30)
        .build();
}

export async function getUsdcAllowance(args: { from: string; spender: string }): Promise<bigint> {
    const acct = await stellarRpc.getAccount(args.from).catch(() => new Account(args.from, '0'));
    const tx = new TransactionBuilder(acct, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            usdc.call(
                'allowance',
                Address.fromString(args.from).toScVal(),
                Address.fromString(args.spender).toScVal(),
            ),
        )
        .setTimeout(30)
        .build();
    const sim = await stellarRpc.simulateTransaction(tx);
    if ('error' in sim && sim.error) return 0n;
    const result = (sim as { result?: { retval: unknown } }).result;
    if (!result) return 0n;
    const native = scValToNative(result.retval as never);
    return typeof native === 'bigint' ? native : BigInt(native ?? 0);
}

// SEP-41 `approve(from, spender, amount, expiration_ledger)`. The TMM contract
// pulls USDC via `transfer_from`, which checks the allowance — Soroban auth on
// the burn tx alone is not enough. Set expiration ~1000 ledgers (~85 min) into
// the future, plenty of room to land the burn that follows.
export async function approveUsdc(args: {
    from: string;
    spender: string;
    amount: bigint;
}): Promise<string> {
    const account = await stellarRpc.getAccount(args.from);
    const latest = await stellarRpc.getLatestLedger();
    const expiration = latest.sequence + 1000;

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: STELLAR.networkPassphrase,
    })
        .addOperation(
            usdc.call(
                'approve',
                Address.fromString(args.from).toScVal(),
                Address.fromString(args.spender).toScVal(),
                nativeToScVal(args.amount, { type: 'i128' }),
                nativeToScVal(expiration, { type: 'u32' }),
            ),
        )
        .setTimeout(60)
        .build();

    return simulateSignAndSubmit(tx);
}

export function formatUsdc(raw: bigint): string {
    const negative = raw < 0n;
    const abs = negative ? -raw : raw;
    const divisor = 10n ** BigInt(STELLAR.usdc.decimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    const fracStr = frac.toString().padStart(STELLAR.usdc.decimals, '0').replace(/0+$/, '');
    const sign = negative ? '-' : '';
    return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

export function parseUsdcStellar(value: string): bigint {
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Invalid amount');
    const [whole, frac = ''] = value.split('.');
    if (frac.length > STELLAR.usdc.decimals) {
        throw new Error(`USDC on Stellar supports up to ${STELLAR.usdc.decimals} decimals`);
    }
    const padded = frac.padEnd(STELLAR.usdc.decimals, '0');
    return BigInt(whole) * 10n ** BigInt(STELLAR.usdc.decimals) + BigInt(padded || '0');
}

export function i128(value: bigint) {
    return nativeToScVal(value, { type: 'i128' });
}
