import {
    AccountRole,
    address,
    createNoopSigner,
    fetchEncodedAccount,
    getAddressEncoder,
    getProgramDerivedAddress,
    type Address,
    type Instruction,
} from '@solana/kit';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { hexToBytes, type Hex } from 'viem';
import {
    getReceiveMessageInstructionAsync,
    MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS,
} from './generated/message-transmitter';
import {
    fetchTokenMessenger,
    TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS,
} from './generated/token-messenger-minter';
import { signAndSendSolanaTx } from './signer';
import { solanaRpc } from './client';
import { SOLANA, STELLAR } from '$lib/config';
import type { SolanaWallet } from './wallet';

const MT = MESSAGE_TRANSMITTER_V2_PROGRAM_ADDRESS;
const TMM = TOKEN_MESSENGER_MINTER_V2_PROGRAM_ADDRESS;
const enc = getAddressEncoder();
const mintBytes = (a: Address) => new Uint8Array(enc.encode(a));

const pda = (programAddress: Address, seeds: (string | Uint8Array)[]) =>
    getProgramDerivedAddress({ programAddress, seeds }).then(([a]) => a);

// Complete a Stellar→Solana transfer by receiving the attested CCTP message on
// Solana. receiveMessage (MessageTransmitterV2) verifies the attestation, then
// CPIs into TokenMessengerMinterV2, which TRANSFERS USDC out of the custody
// account to the recipient ATA. The Anchor IDL doesn't describe the CPI
// accounts, so we hand-append them (order/roles per Circle's test_client.ts).
// mintRecipient in the burn was the recipient's ATA, so we bundle an idempotent
// ATA create to guarantee it exists before the mint.
export async function receiveMessageOnSolana(args: {
    wallet: SolanaWallet;
    recipientOwner: string;
    message: Hex;
    attestation: Hex;
}): Promise<{ signature: string }> {
    const message = new Uint8Array(hexToBytes(args.message));
    const attestation = new Uint8Array(hexToBytes(args.attestation));

    // CCTP V2 message fields by byte offset.
    const nonce = message.slice(12, 44); //          used_nonce seed
    const remoteDomain = String(STELLAR.domain); //  source = Stellar (27), ASCII seed
    const burnToken = message.slice(152, 184); //    token_pair remote-token seed

    const mint = address(SOLANA.usdc.mint);
    const owner = address(args.recipientOwner);
    const ownerSigner = createNoopSigner(owner); // Phantom pays + is caller

    const [recipientAta] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    // MessageTransmitter direct PDA (authorityPda + eventAuthority auto-resolve).
    const messageTransmitter = await pda(MT, ['message_transmitter']);
    const usedNonce = await pda(MT, ['used_nonce', nonce]);

    // TMM CPI PDAs.
    const tokenMessenger = await pda(TMM, ['token_messenger']);
    const tokenMinter = await pda(TMM, ['token_minter']);
    const remoteTokenMessenger = await pda(TMM, ['remote_token_messenger', remoteDomain]);
    const localToken = await pda(TMM, ['local_token', mintBytes(mint)]);
    const tokenPair = await pda(TMM, ['token_pair', remoteDomain, burnToken]);
    const custody = await pda(TMM, ['custody', mintBytes(mint)]);
    const tmmEventAuthority = await pda(TMM, ['__event_authority']);

    // fee_recipient ATA — read TokenMessenger.feeRecipient from chain, derive ATA.
    const tm = await fetchTokenMessenger(solanaRpc, tokenMessenger);
    const [feeRecipientAta] = await findAssociatedTokenPda({
        owner: tm.data.feeRecipient,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint,
    });

    // Ensure the recipient ATA exists — in its OWN transaction. Bundling the
    // create with receiveMessage overflows Solana's 1232-byte tx limit (Kit
    // throws "encoding overruns Uint8Array"). Only send it when missing, so the
    // common case stays a single signature.
    const ataInfo = await fetchEncodedAccount(solanaRpc, recipientAta);
    if (!ataInfo.exists) {
        const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: ownerSigner,
            owner,
            mint,
        });
        await signAndSendSolanaTx({
            wallet: args.wallet,
            instructions: [createAta],
            feePayerSigner: ownerSigner,
        });
    }

    const base = await getReceiveMessageInstructionAsync({
        payer: ownerSigner,
        caller: ownerSigner,
        messageTransmitter,
        usedNonce,
        receiver: TMM, //   authorityPda derives from this
        program: MT, //     emit_cpi self-program (MessageTransmitter)
        message,
        attestation,
    });

    // Append the CPI remaining accounts (order + roles: Circle test_client.ts).
    const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
    const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
    const receive: Instruction = {
        ...base,
        accounts: [
            ...(base.accounts ?? []),
            ro(tokenMessenger),
            ro(remoteTokenMessenger),
            w(tokenMinter),
            w(localToken),
            ro(tokenPair),
            w(feeRecipientAta),
            w(recipientAta),
            w(custody),
            ro(TOKEN_PROGRAM_ADDRESS),
            ro(tmmEventAuthority),
            ro(TMM),
        ],
    };

    const signature = await signAndSendSolanaTx({
        wallet: args.wallet,
        instructions: [receive],
        feePayerSigner: ownerSigner,
    });
    return { signature };
}
