import { erc20Abi, formatUnits, hexToNumber, parseUnits, slice, type Hex } from 'viem';
import { EVM_CHAINS, type EvmChainId } from '$lib/config';
import { getPublicClient } from './client';
import type { EvmWallet } from './wallet';

// EIP-2612 permit-specific reads on USDC. Circle's FiatTokenV2_2 (and Arc's
// USDC proxy) expose `nonces`, `version`, and the standard `name` / `permit`.
// We query name + version dynamically so the EIP-712 domain matches whatever
// the chain actually deployed — guessing "USD Coin" vs "USDC" is a common
// source of "invalid signature" reverts.
const usdcPermitAbi = [
    { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    {
        type: 'function',
        name: 'nonces',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ type: 'uint256' }],
    },
] as const;

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

export type EvmUsdcPermitSignature = {
    deadline: bigint;
    v: number;
    r: Hex;
    s: Hex;
};

// Produces an EIP-2612 permit signature authorizing `spender` to pull `value`
// USDC from `wallet.address`. The signature is single-use (consumes a nonce)
// and expires at `deadline`. No on-chain tx is sent — the wrapper contract
// calls `usdc.permit(...)` with these values in the same tx as the burn.
export async function signEvmUsdcPermit(args: {
    chainId: EvmChainId;
    wallet: EvmWallet;
    spender: `0x${string}`;
    value: bigint;
    deadlineSeconds?: number; // default 30 min
}): Promise<EvmUsdcPermitSignature> {
    const cfg = EVM_CHAINS[args.chainId];
    const pub = getPublicClient(args.chainId);

    const [name, version, nonce] = await Promise.all([
        pub.readContract({ address: cfg.usdc, abi: usdcPermitAbi, functionName: 'name' }),
        pub.readContract({ address: cfg.usdc, abi: usdcPermitAbi, functionName: 'version' }),
        pub.readContract({
            address: cfg.usdc,
            abi: usdcPermitAbi,
            functionName: 'nonces',
            args: [args.wallet.address],
        }),
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 30 * 60));

    const signature = (await args.wallet.walletClient.signTypedData({
        account: args.wallet.address,
        domain: {
            name,
            version,
            chainId: cfg.chain.id,
            verifyingContract: cfg.usdc,
        },
        types: {
            Permit: [
                { name: 'owner', type: 'address' },
                { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ],
        },
        primaryType: 'Permit',
        message: {
            owner: args.wallet.address,
            spender: args.spender,
            value: args.value,
            nonce,
            deadline,
        },
    })) as Hex;

    // Split 65-byte sig into r (32) | s (32) | v (1). viem's signature is the
    // canonical ecrecover layout, so v is the last byte and already 27/28.
    const r = slice(signature, 0, 32);
    const s = slice(signature, 32, 64);
    const v = hexToNumber(slice(signature, 64, 65));
    return { deadline, v, r, s };
}

export function formatEvmUsdc(chainId: EvmChainId, raw: bigint): string {
    return formatUnits(raw, EVM_CHAINS[chainId].usdcDecimals);
}

export function parseEvmUsdc(chainId: EvmChainId, value: string): bigint {
    return parseUnits(value, EVM_CHAINS[chainId].usdcDecimals);
}
