import { concatHex, pad, stringToHex, toHex, type Hex } from 'viem';
import { StrKey } from '@stellar/stellar-sdk';

// Hook data layout for routing CCTP funds to a Stellar G-address via
// CctpForwarder. From Circle's Stellar CCTP docs:
//
//   bytes 0–23   : 24 magic bytes (zeros, Circle-reserved)
//   bytes 24–27  : version (uint32, currently 0)
//   bytes 28–31  : length of forwardRecipient in bytes (uint32)
//   bytes 32+    : forwardRecipient as UTF-8 encoded strkey (the G-address)
//
// Getting any byte of this wrong will permanently lose funds. Validate
// the strkey first.
export function encodeStellarForwarderHookData(stellarStrkey: string): Hex {
    if (!StrKey.isValidEd25519PublicKey(stellarStrkey)) {
        throw new Error(`Invalid Stellar account: ${stellarStrkey}`);
    }
    const magic = pad('0x', { size: 24 });
    const version = pad(toHex(0), { size: 4 });
    const recipientHex = stringToHex(stellarStrkey);
    const recipientLen = (recipientHex.length - 2) / 2;
    const lengthField = pad(toHex(recipientLen), { size: 4 });
    return concatHex([magic, version, lengthField, recipientHex]);
}

// Convert a Stellar strkey contract or account into a 32-byte bytes32 for
// CCTP message fields. Both `mintRecipient` and `destinationCaller` need
// to be the *raw 32-byte Ed25519 pubkey*, NOT the strkey string itself.
export function strkeyToBytes32(strkey: string): Hex {
    const isContract = StrKey.isValidContract(strkey);
    const raw = isContract ? StrKey.decodeContract(strkey) : StrKey.decodeEd25519PublicKey(strkey);
    return toHex(raw);
}
