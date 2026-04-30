import { erc20Abi, formatUnits, parseUnits } from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';
import { getPublicClient } from './client';
import type { EvmWallet } from './wallet';

export async function getEvmUsdcBalance(chainId: EvmChainId, addr: `0x${string}`): Promise<bigint> {
    const cfg = EVM_CHAINS[chainId];
    return getPublicClient(chainId).readContract({
        address: cfg.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr],
    });
}

export async function getEvmUsdcAllowance(
    chainId: EvmChainId,
    owner: `0x${string}`,
    spender: `0x${string}`,
): Promise<bigint> {
    const cfg = EVM_CHAINS[chainId];
    return getPublicClient(chainId).readContract({
        address: cfg.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [owner, spender],
    });
}

export async function approveEvmUsdc(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    spender: `0x${string}`;
    amount: bigint;
}): Promise<`0x${string}`> {
    const cfg = EVM_CHAINS[args.chainId];
    const hash = await args.wallet.walletClient.writeContract({
        account: args.wallet.address,
        chain: cfg.chain,
        address: cfg.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [args.spender, args.amount],
    });
    await getPublicClient(args.chainId).waitForTransactionReceipt({ hash });
    return hash;
}

export function formatEvmUsdc(chainId: EvmChainId, raw: bigint): string {
    return formatUnits(raw, EVM_CHAINS[chainId].usdcDecimals);
}

export function parseEvmUsdc(chainId: EvmChainId, value: string): bigint {
    return parseUnits(value, EVM_CHAINS[chainId].usdcDecimals);
}
