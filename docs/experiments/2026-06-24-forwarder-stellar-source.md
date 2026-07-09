# Experiment: Circle Forwarding Service for a Stellar-origin burn

Date: 2026-06-24 (resolved 2026-07-09)
Branch: `experiment/forwarder-stellar-source`
Status: **RESOLVED** — Circle enabled Stellar-source forwarding; verified working
end-to-end on 2026-07-09. See [Resolution](#resolution-2026-07-09). Our
implementation was correct throughout; the gap was entirely Circle-side.

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
  Stellar attests at finalized regardless. This is expected, not a limitation:
  Stellar finalizes in seconds, so Fast Transfer (mint-before-finality for a fee)
  is moot and the chain only offers Standard (same as Arc, Avalanche, and other
  fast-finality chains). Standard *is* the fast path here. Not a forwarding clue.

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
  Stellar attests at finalized (consistent with the Base run); expected for a
  fast-finality chain where Fast Transfer is moot, not a deficiency.
- Raw attestation = two concatenated 65-byte attester signatures (valid), so the
  message is mintable; the burn is recoverable via manual `receiveMessage`
  (resume flow with Ethereum selected).

So Stellar-source forwarding fails identically against **both** supported
destinations (Base and Ethereum Sepolia). Combined with the EVM↔EVM control
succeeding, this isolates the cause to Circle's relayer not watching a **Stellar
source** — not a destination, fee, threshold, caller, or encoding issue on our
side.

## Third trial: flat $0.20 service fee added to maxFee — still NOT forwarded

Hypothesis: the quoted `forwardFee` is destination gas only, and Circle's docs
cite a flat ~$0.20 forwarding *service* fee on all chains that the quote might
omit — leaving the relayer silently underpaid. Folded a flat $0.20
(`2_000_000` in 7-dp Stellar subunits) into `forwardedMaxFeeStellar` and re-ran.

Two burns, Stellar→Arc (26) and Stellar→Base (6). The add landed correctly —
maxFee in the burn message normalizes 7-dp→6-dp (÷10), so e.g. the Base burn
carried maxFee = 403,716 (~$0.40 = ~$0.20 forwardFee + $0.20 service + margin).
Decimals verified sound: `amount` and `maxFee` are both 6-dp-normalized in the
message and self-consistent. **`feeExecuted` = 0 on both.** No change.

The decisive evidence is in Iris's own response shape, comparing the
Stellar-source message to a working EVM↔EVM forward (Base→Eth, control):

| field                | EVM control (worked)   | Stellar source (ignored) |
| -------------------- | ---------------------- | ------------------------ |
| `forwardState`       | `"CONFIRMED"`          | **field absent**         |
| `forwardTxHash`      | present (`0x1897…`)    | **absent**               |
| `decodedMessageBody` | fully decoded          | **`null`**               |
| `sender`             | `0x8fe6…`              | **`null`**               |
| `feeExecuted`        | = maxFee (full)        | **0**                    |
| finality min/exec    | 1000 / 1000 (Fast)     | 2000 / 2000 (N/A)        |

Two structural tells beyond `feeExecuted`:

1. **`forwardState` is entirely absent** on the Stellar message — the EVM burn
   has it because the message entered the forwarding pipeline. Absent = never
   enrolled. Circle's API surfaces no forward lifecycle for a Stellar source.
2. **`decodedMessageBody` = `null` and `sender` = `null`** — Iris's own decoder
   choked on the Stellar-source burn body (decoded the EVM one fully). Stellar
   source is second-class even in the parsing layer, not just the relayer.

Source messages for the record:
- `GET /v2/messages/27?transactionHash=a321fc65…258c123` (Stellar→Base, $0.20 add)
- `GET /v2/messages/6?transactionHash=0xdaeb3c49…f2334` (Base→Eth control, CONFIRMED)

Aside (not a forwarding signal): Circle's supported-chains table lists Fast
Transfer as **N/A for Stellar**, which explains every Stellar-source burn
attesting at threshold 2000 regardless of `minFinalityThreshold`. This is
expected — Stellar finalizes in seconds, so Fast Transfer (mint-before-finality
for a fee) is moot; the chain only offers Standard, same as Arc, Avalanche, and
other fast-finality chains. Standard *is* the fast path. It is orthogonal to the
forwarding gap, not corroboration of it.

The $0.20 add was reverted — `forwardedMaxFeeStellar` is back to
`protocol + forwardFee×10 + margin`. maxFee was moved twice (tightened, then
+$0.20) with zero change in `feeExecuted`/`forwardState`, proving maxFee was
never the lever.

## What the Iris OpenAPI spec confirms

Cross-checked the on-chain findings against Circle's published spec
(`https://developers.circle.com/openapi/cctp.yaml`). It corroborates the
wrap-up from a different angle — Circle's own contract says the fee was fine and
no forward was ever created:

1. **The $0.20 service-fee add was double-counting.** `forwardFee` is documented
   as *"Gas **and forwarding fees** for using the Circle Forwarder in USDC minor
   units"*, with `high` = *"the high gas estimate **plus forwarding fee**"*. The
   quoted fee already includes the service fee — our flat $0.20 add sat on top of
   a number that already had it. (Harmless, since the relayer never ran; reverted
   regardless.)
2. **maxFee semantics confirm folding `forwardFee` in is correct.** `maxFee` =
   *"Maximum fee to pay on the **destination domain**, in units of `burnToken`"*;
   `feeExecuted` = the actual destination-domain fee charged. maxFee bounds the
   destination-side fee the forwarder takes — exactly what `forwardedMaxFeeStellar`
   sizes it to.
3. **`delayReason` proves maxFee was never the blocker.** The spec defines a
   `DelayReason` enum whose `insufficient_fee` value means *"The max fee specified
   is insufficient for fast processing."* Our Stellar message returned
   `delayReason: null` — Circle did not flag the fee as low. If maxFee were the
   problem, this field would say `insufficient_fee`.
4. **`forwardState` absent = never enrolled.** `forwardState` is an optional
   free-form string (example `PENDING`); the example response pairs it with
   `forwardTxHash`. Iris attaches both only when a forward record exists. Our
   Stellar message has neither field — no record was ever created.
5. **The API surface is EVM-shaped by construction.** `transactionHash` /
   `sourceTxHash` are pattern-locked to `^0x[a-fA-F0-9]{64}$` (Stellar hashes are
   64 hex *without* `0x` — ours didn't match, though the endpoint accepted them);
   the `Address` schema and message decoder assume EVM-style addresses, which is
   why `decodedMessageBody` / `sender` came back `null` for the Stellar-source
   burn. Nothing in the spec enumerates supported forwarder sources or models a
   Stellar source.

## Conclusion

- Our forwarding implementation is correct (proven by the EVM↔EVM control).
- Stellar-origin forwarding is unsupported by Circle's relayer on sandbox as of
  2026-06-24, across all tested destinations. The fee API quoting the route and
  the docs gating only by destination are both misleading — the relayer simply
  doesn't act on a Stellar source.
- Aside, not a forwarding signal: Stellar-source burns always attest at
  finalized / threshold 2000, and Circle's table lists Fast Transfer as **N/A for
  Stellar**. Expected — Stellar finalizes in seconds, so Fast Transfer is moot;
  Standard is the only (and effectively the fast) path, same as Arc/Avalanche.
  Orthogonal to the forwarding gap.
- Cleanest proof the relayer never enrolls a Stellar source: Iris omits the
  `forwardState`/`forwardTxHash` fields entirely (present + `CONFIRMED` on a
  working EVM forward) and returns `decodedMessageBody`/`sender` = `null` for the
  Stellar-source message. maxFee is not the lever — moved twice with no effect on
  `feeExecuted` (stayed 0) or `forwardState` (stayed absent).
- Forwarder economics: `feeExecuted` ≈ full `maxFee`; forward fee tracks
  destination gas (~$0.20 Base, ~$1.45 Ethereum) — size `maxFee` tightly.

Worth reporting to Circle: confirm whether/when Stellar-source forwarding will be
enabled (the relayer watching a Stellar source). Stellar-source Fast is *not* a
gap to chase — Fast Transfer is moot on a fast-finality chain. Parked until then.
The Ethereum Sepolia chain addition is a separate, general-purpose commit
(cherry-pickable onto `main`).

## Resolution (2026-07-09)

Circle stated the forwarder issue "has been fixed." Re-ran the exact same flow
from the same source account (`GA4XQJFT…`, Stellar domain 27) — two burns,
Stellar→Arc (26) and Stellar→Base (6), unchanged code. **Both forwarded and
minted with no manual `receiveMessage`.** Confirmed on-chain on both destinations.

| leg           | burn (source tx)     | amount | nonce        | forwardState | forwardTxHash (dest) | minted → recipient | fee → collector |
| ------------- | -------------------- | ------ | ------------ | ------------ | -------------------- | ------------------ | --------------- |
| Stellar→Arc   | `245956ca…5ccd42`    | 5.0    | `0xfed47d…`  | **COMPLETE** | `0x76fbf7d4…215bfd`  | 4.969225           | 0.030775        |
| Stellar→Base  | `9f6b909c…09e2bf0`   | 5.1    | `0xf7f53f…`  | **COMPLETE** | `0x1d979cfc…909907c` | 4.896013           | 0.203987        |

- recipient (both): `0xb636ce5b2f8959978568a2c9865da750811e273c`
- fee collector (both): `0xc17d06b66fb2f308bb3af99231a45380a28563a2`
- Arc mint tx status 1 (USDC `0x3600…0000`, native gas token); Base mint tx
  status 1 (USDC `0x036CbD…CF7e` on Base Sepolia). Fee math checks out both legs
  (amount − feeExecuted = minted).

Every structural tell from the third trial has flipped for the Stellar-source
message — the mirror image of the table in that section:

| field                | 2026-06-24 (ignored) | 2026-07-09 (forwarded) |
| -------------------- | -------------------- | ---------------------- |
| `forwardState`       | field absent         | **`COMPLETE`**         |
| `forwardTxHash`      | absent               | **present** (both legs)|
| `decodedMessageBody` | `null`               | **fully decoded**      |
| `feeExecuted`        | 0                    | **= maxFee** (full)    |

Iris now enrolls the Stellar-source burn into the forwarding pipeline and its
decoder parses the Stellar-source body — both the relayer and parsing layers were
fixed. `feeExecuted` = full `maxFee` on both legs, consistent with the earlier
EVM-control finding (the forwarder consumes ~the full cap; size `maxFee` tightly).

One thing to keep an eye on, not a bug: the Base leg's `maxFee` (203987, ~$0.20,
~4% of a $5.1 transfer) was ~6.6× the Arc leg's (30775, ~0.6%), and `feeExecuted`
= `maxFee` on both — so any slack in the cap is paid, not refunded. Confirm the
Base cap is intentionally that much looser than Arc's.

`finalityThresholdExecuted` = 2000 on both, unchanged and expected — Stellar
attests at finalized (Fast Transfer is N/A on a fast-finality chain).

Follow-up: report the confirmed fix back to Circle in Discord (pending).
