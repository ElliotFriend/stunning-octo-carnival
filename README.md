# CCTP Demo · Stellar ↔ EVM (Arc · Base)

A small SvelteKit app that bridges USDC between **Stellar testnet** and a
CCTP-supported EVM chain — currently **Arc Testnet** (default) or **Base
Sepolia** — using Circle's
[Cross-Chain Transfer Protocol V2](https://developers.circle.com/cctp).

The point of the demo is to make every step of CCTP visible: the **burn** on
the source chain, Circle's **attestation**, and the **mint** on the
destination chain, all in one screen. Both directions are supported, and
each direction has multiple flows so you can see (and compare) the UX
tradeoffs CCTP V2 unlocks.

```bash
pnpm install
pnpm run dev
```

Open `http://localhost:5173`.

## Why Arc by default

Arc is Circle's own EVM-compatible L1, designed for stablecoin payments. Two
practical wins for this demo:

- **Fast finality** — Arc's settlement is much quicker than Base→Sepolia, so
  the attestation step takes seconds rather than ~15 minutes.
- **Gas in USDC** — no separate ETH balance to top up; the same USDC pays for
  gas and the burn.

You can flip to Base Sepolia at any time via the picker in the EVM panel.

## What you need

- **Freighter** browser extension, set to the Stellar **Testnet** network ([install](https://freighter.app)).
- **MetaMask** (or any injected EVM wallet) — Arc Testnet is added on first connect; for Base Sepolia your wallet probably already has it.
- Testnet USDC on each side; on Base Sepolia you also need a tiny bit of ETH for gas.

The two wrapper contracts (Soroban + EVM) are already deployed and wired
into `src/lib/config.ts` — you don't need to redeploy them to use the
"1 tx" flows. See `contracts/stellar/cctp-wrapper/` and
`contracts/evm/cctp-wrapper/` if you want to inspect or redeploy.

## Faucets

| You need                | Where                                                |
| ----------------------- | ---------------------------------------------------- |
| Testnet XLM             | <https://lab.stellar.org/account/fund>               |
| Testnet USDC on Stellar | <https://faucet.circle.com> (pick "Stellar Testnet") |
| Testnet USDC on Arc     | <https://faucet.circle.com> (pick "Arc Testnet")     |
| Testnet USDC on Base    | <https://faucet.circle.com> (pick "Base Sepolia")    |
| Base Sepolia ETH        | <https://www.alchemy.com/faucets/base-sepolia>       |

You'll also need a USDC trustline on your Stellar testnet account before
USDC can land. Freighter or LOBSTR will prompt you to add it on first
deposit.

## Network details

| Chain           | Chain ID | RPC                                   | Explorer                                  | CCTP domain |
| --------------- | -------- | ------------------------------------- | ----------------------------------------- | ----------- |
| Arc Testnet     | 5042002  | <https://rpc.testnet.arc.network>     | <https://testnet.arcscan.app>             | 26          |
| Base Sepolia    | 84532    | (your wallet's default)               | <https://sepolia.basescan.org>            | 6           |
| Stellar Testnet | —        | <https://soroban-testnet.stellar.org> | <https://stellar.expert/explorer/testnet> | 27          |

## How it works

CCTP burns USDC on the source chain and mints fresh USDC on the destination
— no liquidity pools, no wrapped tokens. Three contracts are involved on
Stellar:

| Contract                             | Purpose                                          |
| ------------------------------------ | ------------------------------------------------ |
| `TokenMessengerMinter` (`CDNG…RTHP`) | Burns USDC outbound, mints inbound               |
| `MessageTransmitter` (`CBJ6…VVJY`)   | Generic message bus + attestation verifier       |
| `CctpForwarder` (`CA66…4VSZ`)        | Routes inbound USDC to a regular Stellar account |

On every EVM chain, CCTP V2 deploys to the same addresses (deterministic
across the entire CCTP V2 testnet fleet):

- `TokenMessengerV2` = `0x8FE6…2DAA`
- `MessageTransmitterV2` = `0xE737…E275`

Only USDC and the chain ID/domain differ per chain.

### Stellar → EVM

This direction supports **two flows**, selectable from the Stellar panel:

1. **2 tx (direct)** — plain CCTP:
    1. `approve` USDC SAC for the `TokenMessengerMinter`.
    2. Call `deposit_for_burn` on `TokenMessengerMinter`.
    3. Poll Iris for the attestation.
    4. Call `receiveMessage` on the destination's `MessageTransmitterV2`.

2. **1 tx (wrapper)** — uses a user-deployed Soroban wrapper
   (`contracts/stellar/cctp-wrapper/`) whose `approve_and_deposit` method
   bundles the `approve` and `deposit_for_burn` into a single Soroban
   transaction. Soroban's auth tree authorizes both inner calls from one
   Freighter signature, so the user sees one prompt and pays one network
   fee. The destination side is identical (`receiveMessage`).

### EVM → Stellar

This direction needs the `CctpForwarder` because CCTP messages can't tell a
G-account from a C-contract — sending directly to a G-address would brick
the funds. The destination side always looks the same:

- Poll Iris (~seconds on Arc; ~15 min on Base for Standard transfers).
- Call `mint_and_forward` on the `CctpForwarder` — atomically mints to the
  forwarder and pays out to the G-address from hook data.

The hook data layout (24 zero bytes + `uint32` version + `uint32` length +
UTF-8 strkey) lives in `src/lib/evm/cctp.ts`. Get it wrong and funds are
lost, so it's the most important code in the repo.

The **burn side** has three flows, selectable from the EVM panel. They all
ultimately call `TokenMessengerV2.depositForBurnWithHook` with the same
payload — they differ only in who submits the tx and whether the `approve`
is bundled into the same on-chain action:

| Flow                | User prompts                 | On-chain txs                 | Total gas | Requires                             |
| ------------------- | ---------------------------- | ---------------------------- | --------- | ------------------------------------ |
| 2 tx (direct)       | 2 tx confirmations           | 2                            | ~2×       | nothing extra                        |
| 1 tx (permit)       | 1 signature + 1 confirmation | 1                            | ~1×       | `CctpWrapper` deployed on this chain |
| 1 click (sendCalls) | 1 confirmation               | 1 (atomic) or 2 (sequential) | 1–2×      | wallet support for EIP-5792          |

- **2 tx (direct)** is plain CCTP V2: `usdc.approve` + `depositForBurnWithHook`.
- **1 tx (permit)** uses the EVM CctpWrapper (`contracts/evm/cctp-wrapper/`)
  which bundles `permit + transferFrom + approve + depositForBurnWithHook`
  into one Solidity call. The user signs an EIP-712 `Permit` message
  off-chain (no gas), then submits one transaction. Half the gas of the
  2-tx flow.
- **1 click (sendCalls)** uses [EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)
  `wallet_sendCalls` — the **wallet** bundles `approve` + `depositForBurnWithHook`
  into one user confirmation. On EIP-7702 EOAs or smart wallets this runs
  atomically (one on-chain tx). On plain EOAs the wallet still presents
  one prompt but submits two txs sequentially. The chip auto-disables on
  chains/wallets that don't advertise the capability.

## Limitations

This is a demo, not a bridge UX:

- USDC only (EURC isn't confirmed on Stellar CCTP yet).
- Standard (finalized) transfers only — no Fast Burn.
- Testnet only.
- Transfer history is in-memory; refresh wipes it.
- No mobile wallet flow beyond what the injected wallet provides.

## Layout

```text
contracts/
  stellar/cctp-wrapper/        # Soroban wrapper (Rust) — approve_and_deposit
  evm/cctp-wrapper/            # EVM wrapper (Solidity) — bridgeWithPermit
src/lib/
  config.ts                    # EVM_CHAINS map, addresses, domains, RPC URLs, constants
  stellar/                     # Freighter, USDC SAC, deposit_for_burn, mint_and_forward
  evm/
    cctp.ts                    # depositForBurnWithHook + permit + sendCalls flows; receiveMessage
    usdc.ts                    # ERC-20 reads + EIP-2612 permit signing
    capabilities.ts            # EIP-5792 wallet capability detection
    wallet.ts                  # EIP-6963 discovery, connect/disconnect, chain switch
    client.ts                  # cached viem PublicClient per chain
  circle/iris.ts               # attestation polling
  stores/transfer.svelte.ts    # state machine (idle → approve → burn → attest → mint → done)
  components/                  # one .svelte file per UI piece
src/routes/+page.svelte        # composition
```
