import {
    address,
    createNoopSigner,
    generateKeyPairSigner,
    getAddressDecoder,
    getProgramDerivedAddress,
    type Address,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { hexToBytes, type Hex } from 'viem';
import {
    getDepositForBurnWithHookInstructionAsync,
    TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS,
} from './generated/token-messenger-minter';
import { encodeStellarForwarderHookData, strkeyToBytes32 } from '$lib/stellar/recipient';
import { signAndSendSolanaTx } from './signer';
import { SOLANA, STELLAR } from '$lib/config';
import type { SolanaWallet } from './wallet';

const TMM = TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS;

// The generated Async builder auto-resolves senderAuthorityPda, denylistAccount
// and localToken, but requires us to supply these program-config PDAs. Seeds
// are the canonical CCTP V2 ones (Circle solana-cctp-contracts).
async function derivePdas(destinationDomain: number) {
    const [tokenMessenger] = await getProgramDerivedAddress({
        programAddress: TMM,
        seeds: ['token_messenger'],
    });
    const [tokenMinter] = await getProgramDerivedAddress({
        programAddress: TMM,
        seeds: ['token_minter'],
    });
    const [remoteTokenMessenger] = await getProgramDerivedAddress({
        programAddress: TMM,
        seeds: ['remote_token_messenger', String(destinationDomain)],
    });
    const [messageTransmitter] = await getProgramDerivedAddress({
        programAddress: address(SOLANA.programs.messageTransmitterV2),
        seeds: ['message_transmitter'],
    });
    return { tokenMessenger, tokenMinter, remoteTokenMessenger, messageTransmitter };
}

// The forwarder's raw 32 bytes as a Solana Address. CCTP addresses mintRecipient
// / destinationCaller as 32-byte slots; on Solana the generated encoder wants an
// Address, so decode the forwarder contract id's bytes into one.
function forwarderAddress(): Address {
    const raw = hexToBytes(strkeyToBytes32(STELLAR.contracts.cctpForwarder) as Hex);
    if (raw.length !== 32) throw new Error('Forwarder did not decode to 32 bytes');
    return getAddressDecoder().decode(raw);
}

// Burn USDC on Solana with the Stellar-forwarder hook. mintRecipient AND
// destinationCaller are the forwarder (the fund-bricking invariant); the real
// G-recipient rides in hookData. Returns the burn signature for Iris polling.
export async function burnUsdcToStellar(args: {
    wallet: SolanaWallet;
    amount: bigint;
    stellarRecipient: string;
    maxFee: bigint;
    minFinalityThreshold: number;
}): Promise<{ signature: string }> {
    const owner = address(args.wallet.address);
    const mint = address(SOLANA.usdc.mint);

    const [burnTokenAccount] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    const recipient = forwarderAddress(); // mintRecipient === destinationCaller
    const hookData = new Uint8Array(
        hexToBytes(encodeStellarForwarderHookData(args.stellarRecipient) as Hex),
    );

    const pdas = await derivePdas(STELLAR.domain);
    const ownerSigner = createNoopSigner(owner); // Phantom fills this slot later
    const messageSentEventData = await generateKeyPairSigner();

    const instruction = await getDepositForBurnWithHookInstructionAsync({
        owner: ownerSigner,
        eventRentPayer: ownerSigner,
        burnTokenAccount,
        burnTokenMint: mint,
        messageSentEventData,
        messageTransmitter: pdas.messageTransmitter,
        tokenMessenger: pdas.tokenMessenger,
        remoteTokenMessenger: pdas.remoteTokenMessenger,
        tokenMinter: pdas.tokenMinter,
        messageTransmitterProgram: address(SOLANA.programs.messageTransmitterV2),
        program: TMM,
        amount: args.amount,
        destinationDomain: STELLAR.domain,
        mintRecipient: recipient,
        destinationCaller: recipient,
        maxFee: args.maxFee,
        minFinalityThreshold: args.minFinalityThreshold,
        hookData,
    });

    const signature = await signAndSendSolanaTx({
        wallet: args.wallet,
        instructions: [instruction],
        feePayerSigner: ownerSigner,
    });
    return { signature };
}
