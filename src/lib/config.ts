import { Networks } from '@stellar/stellar-sdk';
import { defineChain } from 'viem';
import { baseSepolia } from 'viem/chains';

export const STELLAR = {
	networkPassphrase: Networks.TESTNET,
	rpcUrl: 'https://soroban-testnet.stellar.org',
	horizonUrl: 'https://horizon-testnet.stellar.org',
	domain: 27,
	explorer: 'https://stellar.expert/explorer/testnet',
	contracts: {
		tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
		messageTransmitter: 'CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY',
		cctpForwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
		usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
	},
	usdc: {
		code: 'USDC',
		issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
		decimals: 7
	}
} as const;

// CCTP V2 deploys to the same addresses on every supported EVM chain via
// deterministic deployment, so these are constants — only USDC and the
// chain/domain differ per chain.
export const EVM_CCTP_CONTRACTS = {
	tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
	messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
} as const;

// Arc is Circle's L1: EVM-compatible, ~2s blocks, gas paid in USDC, finality
// expected to be much faster than rollups (no L1 settlement dependency).
//
// Circle's public Arc Testnet RPC has a tight rate limit. If 429s are a
// problem during local dev, set PUBLIC_ARC_RPC_URL in `.env` to a dedicated
// endpoint (dRPC, Alchemy, etc.) — the Vite-style PUBLIC_ prefix makes it
// available client-side at build time.
const ARC_RPC_URL =
	import.meta.env.PUBLIC_ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

export const arcTestnet = defineChain({
	id: 5042002,
	name: 'Arc Testnet',
	nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
	rpcUrls: { default: { http: [ARC_RPC_URL] } },
	blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
	testnet: true
});

export type EvmChainConfig = {
	id: 'arc' | 'base';
	label: string;
	chain: ReturnType<typeof defineChain> | typeof baseSepolia;
	domain: number;
	explorer: string;
	usdc: `0x${string}`;
	usdcDecimals: number;
	gasNote: string;
};

export const EVM_CHAINS: Record<'arc' | 'base', EvmChainConfig> = {
	arc: {
		id: 'arc',
		label: 'Arc Testnet',
		chain: arcTestnet,
		domain: 26,
		explorer: 'https://testnet.arcscan.app',
		usdc: '0x3600000000000000000000000000000000000000',
		usdcDecimals: 6,
		gasNote: 'Gas paid in USDC.'
	},
	base: {
		id: 'base',
		label: 'Base Sepolia',
		chain: baseSepolia,
		domain: 6,
		explorer: 'https://sepolia.basescan.org',
		usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
		usdcDecimals: 6,
		gasNote: 'Gas paid in ETH.'
	}
};

export type EvmChainId = keyof typeof EVM_CHAINS;
export const DEFAULT_EVM_CHAIN: EvmChainId = 'arc';

export const IRIS_API = 'https://iris-api-sandbox.circle.com';

// CCTP message uses 6 decimals canonically; Stellar's USDC uses 7.
export const CCTP_CANONICAL_DECIMALS = 6;

export const FINALIZED_THRESHOLD = 2000;

// Defensive max_fee buffers. Reverts with InsufficientMaxFee (#7105) if the
// configured min_fee for the burn token exceeds this. Today min_fee is 0;
// non-zero buffers match Circle's quickstart.
export const STELLAR_MAX_FEE = 100_000n;
export const EVM_MAX_FEE = 500n;

export type Direction = 'stellar-to-evm' | 'evm-to-stellar';
