# CCTP Demo · Stellar ↔ EVM (Arc · Base)

A small SvelteKit app that bridges USDC between **Stellar testnet** and a
CCTP-supported EVM chain — currently **Arc Testnet** (default) or **Base
Sepolia** — using Circle's
[Cross-Chain Transfer Protocol V2](https://developers.circle.com/cctp).

The point of the demo is to make every step of CCTP visible: the **burn** on
the source chain, Circle's **attestation**, and the **mint** on the
destination chain, all in one screen.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Why Arc by default

Arc is Circle's own EVM-compatible L1, designed for stablecoin payments. Two
practical wins for this demo:

- **Fast finality** — Arc's settlement is much quicker than Base→Sepolia, so
  the attestation step takes seconds rather than ~15 minutes
- **Gas in USDC** — no separate ETH balance to top up; the same USDC pays for
  gas and the burn

You can flip to Base Sepolia at any time via the picker in the EVM panel.

## What you need

- **Freighter** browser extension, set to the Stellar **Testnet** network ([install](https://freighter.app))
- **MetaMask** (or any injected EVM wallet) — Arc Testnet is added on first connect; for Base Sepolia your wallet probably already has it
- Testnet USDC on each side; on Base Sepolia you also need a tiny bit of ETH for gas

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

On every EVM chain, CCTP V2 deploys to the same addresses:

- `TokenMessengerV2` = `0x8FE6…2DAA`
- `MessageTransmitterV2` = `0xE737…E275`

Only USDC and the chain ID/domain differ per chain.

### Stellar → EVM

1. `approve` USDC SAC for the `TokenMessengerMinter` (Soroban).
2. Sign a Soroban tx calling `deposit_for_burn` on `TokenMessengerMinter`.
3. Poll Circle's Iris API for the signed attestation.
4. Sign an EVM tx calling `receiveMessage` on the destination's `MessageTransmitterV2`.

### EVM → Stellar

This direction needs the `CctpForwarder` because CCTP messages can't tell a
G-account from a C-contract — sending directly to a G-address would brick the funds.

1. ERC-20 `approve` the `TokenMessengerV2` on the source EVM chain.
2. Call `depositForBurnWithHook` with `mintRecipient` = `destinationCaller` =
   `CctpForwarder`, and the recipient G-address packed into `hookData`.
3. Poll Iris (~seconds on Arc; ~15 min on Base for Standard transfers).
4. Call `mint_and_forward` on the `CctpForwarder` — atomically mints to the
   forwarder and pays out to the G-address from hook data.

The hook data layout (24 zero bytes + `uint32` version + `uint32` length +
UTF-8 strkey) lives in `src/lib/evm/cctp.ts`. Get it wrong and funds are
lost, so it's the most important code in the repo.

## Limitations

This is a demo, not a bridge UX:

- USDC only (EURC isn't confirmed on Stellar CCTP yet)
- Standard (finalized) transfers only — no Fast Burn
- Testnet only
- Transfer history is in-memory; refresh wipes it
- No mobile wallet flow beyond what the injected wallet provides

## Layout

```text
src/lib/
  config.ts                  # EVM_CHAINS map, addresses, domains, RPC URLs
  stellar/                   # Freighter, USDC SAC, deposit_for_burn, mint_and_forward
  evm/                       # viem + web3-onboard, USDC ERC-20, depositForBurnWithHook, receiveMessage
  circle/iris.ts             # attestation polling
  stores/transfer.svelte.ts  # state machine (idle → approve → burn → attest → mint → done)
  components/                # one .svelte file per UI piece
src/routes/+page.svelte      # composition
```
