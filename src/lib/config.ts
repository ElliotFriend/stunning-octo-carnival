import { Networks } from '@stellar/stellar-sdk';
import { defineChain } from 'viem';
import { baseSepolia, sepolia } from 'viem/chains';

export const STELLAR = {
    networkPassphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    domain: 27,
    explorer: 'https://stellar.expert/explorer/testnet',
    contracts: {
        tokenMessengerMinter: 'CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP',
        messageTransmitter: 'CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY',
        cctpForwarder: 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ',
        usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        // User-deployed wrapper that bundles approve + deposit_for_burn into
        // one atomic invocation, signed in a single Freighter prompt.
        bridgeWrapper: 'CDC4EGIJSQU4I7LBER3CRMSTBAVR6JMCQXKJHZZU7WB2R32WQJDGKTN6',
    },
    usdc: {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        decimals: 7,
    },
} as const;

// Solana CCTP V2. Program IDs are deterministic — identical on devnet and
// mainnet — so only the cluster + USDC mint differ. Domain 5. This demo only
// bridges Solana <-> Stellar, so Solana is both a burn source and a mint
// destination but never pairs with the EVM chains.
export const SOLANA = {
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    domain: 5,
    explorer: 'https://explorer.solana.com', // append ?cluster=devnet to links
    programs: {
        messageTransmitterV2: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
        tokenMessengerMinterV2: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
    },
    usdc: {
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        decimals: 6,
    },
} as const;

// CCTP V2 deploys to the same addresses on every supported EVM chain via
// deterministic deployment, so these are constants — only USDC and the
// chain/domain differ per chain.
export const EVM_CCTP_CONTRACTS = {
    tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
} as const;

// Arc is Circle's L1: EVM-compatible, ~2s blocks, gas paid in USDC, finality
// expected to be much faster than rollups (no L1 settlement dependency).
export const arcTestnet = defineChain({
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
    blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
    testnet: true,
});

export type EvmChainConfig = {
    id: 'arc' | 'base' | 'ethereum';
    label: string;
    chain: ReturnType<typeof defineChain> | typeof baseSepolia | typeof sepolia;
    domain: number;
    explorer: string;
    usdc: `0x${string}`;
    usdcDecimals: number;
    gasNote: string;
    /**
     * Approximate Circle attestation wait when this chain is the SOURCE of a
     * burn. Undefined means "fast enough that a wait UI isn't needed."
     */
    attestationEtaMs?: number;
    /**
     * User-deployed CctpWrapper contract. When present, the EVM→Stellar flow
     * can take the single-signature permit path instead of approve + burn.
     */
    bridgeWrapper?: `0x${string}`;
};

export const EVM_CHAINS: Record<'arc' | 'base' | 'ethereum', EvmChainConfig> = {
    arc: {
        id: 'arc',
        label: 'Arc Testnet',
        chain: arcTestnet,
        domain: 26,
        explorer: 'https://testnet.arcscan.app',
        usdc: '0x3600000000000000000000000000000000000000',
        usdcDecimals: 6,
        gasNote: 'Gas paid in USDC.',
        bridgeWrapper: '0xe87b2FCD2675f49785B46f5e84E1019961637eBd', // deployed from contracts/evm/cctp-wrapper
    },
    base: {
        id: 'base',
        label: 'Base Sepolia',
        chain: baseSepolia,
        domain: 6,
        explorer: 'https://sepolia.basescan.org',
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        usdcDecimals: 6,
        gasNote: 'Gas paid in ETH.',
        attestationEtaMs: 15 * 60_000,
        bridgeWrapper: '0xe87b2FCD2675f49785B46f5e84E1019961637eBd', // deployed from contracts/evm/cctp-wrapper
    },
    ethereum: {
        id: 'ethereum',
        label: 'Ethereum Sepolia',
        chain: sepolia,
        domain: 0,
        explorer: 'https://sepolia.etherscan.io',
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        usdcDecimals: 6,
        gasNote: 'Gas paid in ETH.',
        // Ethereum L1 finality is the slowest of the demo chains for a Standard
        // (finalized) transfer. No CctpWrapper deployed here, so the EVM→Stellar
        // permit / send-calls flows fall back to two-tx on this chain.
        attestationEtaMs: 19 * 60_000,
    },
};

export type EvmChainId = keyof typeof EVM_CHAINS;
export const DEFAULT_EVM_CHAIN: EvmChainId = 'arc';

export const IRIS_API = 'https://iris-api-sandbox.circle.com';

// CCTP V2 finality thresholds for the burn.
//   STANDARD (2000) = wait for source-chain finality (~13 min on L2s,
//                     seconds on Arc). minimumFee is 0.
//   FAST     (1000) = mint before finality; Circle charges a fast fee
//                     (basis points of the amount) bounded by max_fee.
export const STANDARD_THRESHOLD = 2000;
export const FAST_THRESHOLD = 1000;

export type TransferSpeed = 'standard' | 'fast';
export const DEFAULT_SPEED: TransferSpeed = 'standard';

// Defensive max_fee buffers. The burn reverts with InsufficientMaxFee
// (#7105) if Circle's configured min_fee for the burn token exceeds this.
// Today min_fee is 0 on all CCTP V2 deployments; non-zero buffers match
// Circle's quickstart and leave headroom if Circle starts charging.
//
// Units differ by chain:
//   - STELLAR_MAX_FEE is in 7-decimal Stellar USDC subunits.
//       100_000  =  $0.01
//   - EVM_MAX_FEE is in the canonical 6-decimal CCTP unit (same as USDC
//     on every EVM chain).
//       500      =  $0.0005
export const STELLAR_MAX_FEE = 100_000n;
export const EVM_MAX_FEE = 500n;
// Solana USDC is 6-dp like EVM, so the same 500n (≈ $0.0005) buffer applies.
export const SOLANA_MAX_FEE = 500n;

export type Direction =
    'stellar-to-evm' | 'evm-to-stellar' | 'solana-to-stellar' | 'stellar-to-solana';

// On the Stellar→EVM side the user picks a transaction shape:
//  - 'wrapper'  : one Soroban tx via the bridge wrapper contract (combined
//                 approve + deposit_for_burn under one Freighter prompt)
//  - 'two-tx'   : separate `approve` and `deposit_for_burn` invocations,
//                 same as plain CCTP without the wrapper
// Mostly here so the demo can show the flows side-by-side.
export type OutboundFlow = 'wrapper' | 'two-tx';
// Default to the plain CCTP path so the demo opens on the typical
// `approve` → `deposit_for_burn` experience. Users can flip to the
// wrapper-contract flow from the StellarPanel toggle.
export const DEFAULT_OUTBOUND_FLOW: OutboundFlow = 'two-tx';

// Orthogonal to OutboundFlow: whether to tag the burn with the Circle
// Crosschain Forwarding Service magic hookData. When on, both the wrapper and
// two-tx shapes route through the *_with_hook variant so Circle's hosted relayer
// auto-mints on the EVM destination (Stellar is not a documented forwarding
// source; destination_caller stays zero so a manual mint can still recover the
// funds if the relayer ignores it). EXPERIMENTAL.
export const DEFAULT_FORWARDING = false;

// EVM→Stellar mirror of OutboundFlow. Values:
//   'two-tx'     plain CCTP — approve, then depositForBurnWithHook.
//   'wrapper'    CctpWrapper — EIP-2612 permit + bundled depositForBurnWithHook
//                in one user-submitted tx.
//   'send-calls' EIP-5792 wallet_sendCalls — the WALLET bundles approve +
//                depositForBurnWithHook into a single user confirmation. May
//                run atomically (smart wallets, EIP-7702) or sequentially.
export type InboundFlow = 'wrapper' | 'two-tx' | 'send-calls';
export const DEFAULT_INBOUND_FLOW: InboundFlow = 'two-tx';
