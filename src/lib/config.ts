import { Networks } from '@stellar/stellar-sdk';
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

export const BASE = {
	chain: baseSepolia,
	domain: 6,
	explorer: 'https://sepolia.basescan.org',
	contracts: {
		tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const,
		messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const,
		usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
	},
	usdc: {
		decimals: 6
	}
} as const;

export const IRIS_API = 'https://iris-api-sandbox.circle.com';

// CCTP message uses 6 decimals canonically; Stellar's USDC uses 7.
export const CCTP_CANONICAL_DECIMALS = 6;

// Standard (finalized) burn — opt out of Fast Burn fee path.
export const FINALIZED_THRESHOLD = 2000;

// Defensive max_fee buffers. The contract reverts with InsufficientMaxFee
// (#7105) if the configured min_fee for the burn token ever exceeds this.
// Today USDC's min_fee is 0 on both sides, so 0 would still work — these
// non-zero values match Circle's quickstart and inoculate against a future
// `set_min_fee` call. The buffer is only deducted if actually charged.
export const STELLAR_MAX_FEE = 100_000n; // 0.01 USDC in 7-decimal subunits
export const EVM_MAX_FEE = 500n; // 0.0005 USDC in 6-decimal subunits

export type Direction = 'stellar-to-base' | 'base-to-stellar';
