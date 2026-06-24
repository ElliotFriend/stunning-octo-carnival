# Experiment: Circle Forwarding Service for a Stellar-origin burn

Date: 2026-06-24
Branch: `experiment/forwarder-stellar-source`
Status: **blocked on Circle** — our implementation is verified correct.

## Goal

Probe whether Circle's Crosschain Forwarding Service (hosted relayer that
auto-completes the destination mint and deducts its fee from the minted USDC)
will service a **Stellar-origin** CCTP burn, even though Stellar is not listed as
a supported forwarder chain.

## How the forwarder is triggered

- Burn with `hookData` = the 32-byte `cctp-forward` magic
  (`0x636374702d666f72776172640000000000000000000000000000000000000000`
  = ascii "cctp-forward" in bytes 0–23, u32 version 0 in 24–27, u32 length 0 in
  28–31).
- `maxFee` must cover protocol fee (bps of amount) + the forwarding fee.
- `destinationCaller` **must be zero** — setting it _disables_ forwarding
  (Circle docs: "Forwarding Service doesn't support forwarding ... when
  `destinationCaller` is set").
- No API registration; the relayer watches source chains for the magic and
  completes the mint on supported routes.
- Fee quote: `GET {IRIS}/v2/burn/USDC/fees/{src}/{dst}?forward=true` →
  `forwardFee:{low,med,high}` (canonical 6-dp units).

## Result: Stellar→Base did NOT forward

Burn succeeded, Iris attested, but no relayer mint. Decoded BurnMessage from the
Fast attempt confirmed everything on our side was correct:

- `hookData` = `cctp-forward` magic — present and correct.
- `destinationCaller` = zero — correct for forwarding.
- `maxFee` = 212769 (6-dp, ~$0.21) — ample for the ~$0.20 forward fee.
- `feeExecuted` = **0** — the relayer never processed it (no forwarding fee
  taken).
- `finalityThresholdExecuted` = 2000 despite `minFinalityThreshold` = 1000 —
  Stellar-as-source did not honor Fast either.

Key correction to an early assumption: **Iris attestation ≠ the forwarding
relayer.** Iris attests every burn; the forwarding relayer is a separate service
that only acts on routes it watches. An attestation tells the relayer nothing.

## Control: EVM↔EVM forwarding works (proves our code is correct)

Throwaway route `src/routes/forward-test/+page.svelte` ran the same code path
between two forwarding-supported chains, both directions, both succeeded with no
mint tx from the user:

- **Ethereum Sepolia → Base Sepolia**: burned 2 USDC → received 1.796027.
  fee = 0.203973 (forwardFee 0.202773 + 1bps + buffer).
- **Base Sepolia → Ethereum Sepolia**: burned 3 USDC → received 1.49901.
  fee = 1.50099. (Ethereum-L1 destination gas is ~7× a Base destination.)

So the `cctp-forward` hookData, zero `destinationCaller`, `maxFee` logic, and
`depositForBurnWithHook` call are all correct. The Stellar→Base failure is
entirely Circle-side: the relayer does not (yet) watch **Stellar as a source**
on sandbox, even though the fee API quotes the route and the docs only gate
forwarding by _destination_.

## Findings worth keeping

1. **The forwarder consumes ~the full `maxFee`** (feeExecuted ≈ maxFee on both
   EVM runs, including our arbitrary buffer). Unlike standard CCTP (feeExecuted
   usually < maxFee), so size `maxFee` tightly to the quote — padding is paid.
   `forwardedMaxFeeStellar` was tightened accordingly: protocol-bps + forwardFee
   ×10 (6-dp→7-dp unit conversion) + a tiny fixed margin, no large floor.
2. **forwardFee ≈ destination gas**, and it varies a lot by destination chain
   (~$0.20 to Base, ~$1.50 to Ethereum Sepolia).
3. **Stellar→EVM forwarder support is the only viable direction** to retry:
   EVM→Stellar is hard-blocked ("destination does not support forwarding").

## Second trial: Stellar→Ethereum Sepolia — also NOT forwarded

Added Ethereum Sepolia (domain 0) as a destination and re-ran the forwarder
flow. Same outcome, decoded from the burn message (Stellar 27 → Ethereum 0):

- `hookData` = `cctp-forward`, `destinationCaller` = 0, recipient =
  TokenMessengerV2 — all correct.
- amount = 2,000,000 ($2.00); `maxFee` = 1,445,108 (6-dp norm, ~$1.445) —
  ample for the ~$1.45 Ethereum forward fee.
- `feeExecuted` = **0** — relayer did not process it.
- `finalityThresholdExecuted` = 2000 despite `minFinalityThreshold` = 1000 —
  Stellar source attested as finalized, not Fast (consistent with the Base run).
- Raw attestation = two concatenated 65-byte attester signatures (valid), so the
  message is mintable; the burn is recoverable via manual `receiveMessage`
  (resume flow with Ethereum selected).

So Stellar-source forwarding fails identically against **both** supported
destinations (Base and Ethereum Sepolia). Combined with the EVM↔EVM control
succeeding, this isolates the cause to Circle's relayer not watching a **Stellar
source** — not a destination, fee, threshold, caller, or encoding issue on our
side.

## Conclusion

- Our forwarding implementation is correct (proven by the EVM↔EVM control).
- Stellar-origin forwarding is unsupported by Circle's relayer on sandbox as of
  2026-06-24, across all tested destinations. The fee API quoting the route and
  the docs gating only by destination are both misleading — the relayer simply
  doesn't act on a Stellar source.
- Also observed: Stellar-source burns do not honor Fast (always attest at
  finalized / threshold 2000), independent of forwarding.
- Forwarder economics: `feeExecuted` ≈ full `maxFee`; forward fee tracks
  destination gas (~$0.20 Base, ~$1.45 Ethereum) — size `maxFee` tightly.

Worth reporting to Circle: confirm whether/when Stellar-source forwarding (and
Stellar-source Fast) will be enabled. Parked until then. The Ethereum Sepolia
chain addition is a separate, general-purpose commit (cherry-pickable onto
`main`).
