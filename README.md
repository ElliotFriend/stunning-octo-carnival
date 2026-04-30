# CCTP Demo · Stellar ↔ Base

A small SvelteKit app that bridges USDC between **Stellar testnet** and **Base Sepolia**
using Circle's [Cross-Chain Transfer Protocol V2](https://developers.circle.com/cctp).

The point of the demo is to make every step of CCTP visible: the **burn** on the
source chain, Circle's **attestation**, and the **mint** on the destination chain,
all in one screen.

```
npm install
npm run dev
```

Open `http://localhost:5173`.

## What you need

- **Freighter** browser extension, set to the Stellar **Testnet** network ([install](https://freighter.app))
- **MetaMask** (or any injected EVM wallet), set to the **Base Sepolia** network
- A bit of testnet USDC and gas on each side

## Faucets

| You need | Where |
|---|---|
| Testnet XLM | https://faucet.stellar.org |
| Testnet USDC on Stellar | https://faucet.circle.com (pick "Stellar Testnet") |
| Base Sepolia ETH | https://www.alchemy.com/faucets/base-sepolia |
| Testnet USDC on Base | https://faucet.circle.com (pick "Base Sepolia") |

You'll also need a USDC trustline on your Stellar testnet account before USDC
can land. Freighter or LOBSTR will prompt you to add it on first deposit.

## How it works

CCTP burns USDC on the source chain and mints fresh USDC on the destination —
no liquidity pools, no wrapped tokens. Three contracts are involved on Stellar:

| Contract | Purpose |
|---|---|
| `TokenMessengerMinter` (`CDNG…RTHP`) | Burns USDC outbound, mints inbound |
| `MessageTransmitter` (`CBJ6…VVJY`) | Generic message bus + attestation verifier |
| `CctpForwarder` (`CA66…4VSZ`) | Routes inbound USDC to a regular Stellar account |

### Stellar → Base
1. Sign a Soroban tx calling `deposit_for_burn` on `TokenMessengerMinter`.
2. Poll Circle's Iris API for the signed attestation.
3. Sign an EVM tx calling `receiveMessage` on Base's `MessageTransmitterV2`.

### Base → Stellar
This direction needs the `CctpForwarder` because CCTP messages can't tell a
G-account from a C-contract — sending directly to a G-address would brick the funds.

1. ERC-20 `approve` the `TokenMessengerV2` on Base.
2. Call `depositForBurnWithHook` with `mintRecipient` = `destinationCaller` =
   `CctpForwarder`, and the recipient G-address packed into `hookData`.
3. Poll Iris (Base finality is ~15 min for Standard transfers).
4. Call `mint_and_forward` on the `CctpForwarder` — atomically mints to the
   forwarder and pays out to the G-address from hook data.

The hook data layout (24 zero bytes + `uint32` version + `uint32` length +
UTF-8 strkey) lives in `src/lib/evm/cctp.ts`. Get it wrong and funds are lost,
so it's the most important code in the repo.

## Limitations

This is a demo, not a bridge UX:

- USDC only (EURC isn't confirmed on Stellar CCTP yet)
- Standard (finalized) transfers only — no Fast Burn
- Testnet only
- Transfer history is in-memory; refresh wipes it
- No mobile wallet flow beyond what the injected wallet provides

## Layout

```
src/lib/
  config.ts          # all addresses, domains, RPC URLs
  stellar/           # Freighter, USDC SAC, deposit_for_burn, mint_and_forward
  evm/               # viem + web3-onboard, USDC ERC-20, depositForBurnWithHook, receiveMessage
  circle/iris.ts     # attestation polling
  stores/transfer.ts # state machine (idle → burn → attest → mint → done)
  components/        # one .svelte file per UI piece
src/routes/+page.svelte  # composition
```
