import { erc20Abi, formatUnits, parseUnits } from 'viem';
import { BASE } from '$lib/config';
import { publicClient } from './client';
import type { EvmWallet } from './wallet';

export async function getEvmUsdcBalance(addr: `0x${string}`): Promise<bigint> {
	return publicClient.readContract({
		address: BASE.contracts.usdc,
		abi: erc20Abi,
		functionName: 'balanceOf',
		args: [addr]
	});
}

export async function getEvmUsdcAllowance(
	owner: `0x${string}`,
	spender: `0x${string}`
): Promise<bigint> {
	return publicClient.readContract({
		address: BASE.contracts.usdc,
		abi: erc20Abi,
		functionName: 'allowance',
		args: [owner, spender]
	});
}

export async function approveEvmUsdc(
	wallet: EvmWallet,
	spender: `0x${string}`,
	amount: bigint
): Promise<`0x${string}`> {
	const hash = await wallet.walletClient.writeContract({
		account: wallet.address,
		chain: BASE.chain,
		address: BASE.contracts.usdc,
		abi: erc20Abi,
		functionName: 'approve',
		args: [spender, amount]
	});
	await publicClient.waitForTransactionReceipt({ hash });
	return hash;
}

export function formatEvmUsdc(raw: bigint): string {
	return formatUnits(raw, BASE.usdc.decimals);
}

export function parseEvmUsdc(value: string): bigint {
	return parseUnits(value, BASE.usdc.decimals);
}
