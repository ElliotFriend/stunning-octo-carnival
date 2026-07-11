import {
    appendTransactionMessageInstructions,
    createTransactionMessage,
    getBase64Decoder,
    getTransactionEncoder,
    partiallySignTransactionMessageWithSigners,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Base64EncodedWireTransaction,
    type Instruction,
    type TransactionSigner,
} from '@solana/kit';
import { solanaRpc } from './client';
import type { SolanaWallet } from './wallet';

// Wallet Standard chain id for Phantom's signing feature. Reads go through our
// pinned devnet RPC regardless, but signTransaction wants the chain named.
const SOLANA_DEVNET_CHAIN = 'solana:devnet';

// Minimal shape of the Wallet Standard solana:signTransaction feature — kept
// local rather than pulling @wallet-standard/features (mirrors evm/wallet.ts).
type SignTransactionOutput = { signedTransaction: Uint8Array };
type SignTransactionFeature = {
    signTransaction: (input: {
        account: SolanaWallet['account'];
        transaction: Uint8Array;
        chain: string;
    }) => Promise<SignTransactionOutput | readonly SignTransactionOutput[]>;
};

// Assemble → sign → submit. Instructions may embed their own signers (e.g. the
// burn's ephemeral message_sent_event_data keypair signs locally here); the
// fee-payer is a noop signer whose slot Phantom fills. We serialize the
// partially-signed tx, hand it to Phantom for the fee-payer signature, then
// submit through our own devnet RPC so the network stays pinned no matter
// Phantom's cluster.
export async function signAndSendSolanaTx(args: {
    wallet: SolanaWallet;
    instructions: Instruction[];
    feePayerSigner: TransactionSigner;
}): Promise<string> {
    const { wallet, instructions, feePayerSigner } = args;

    const { value: blockhash } = await solanaRpc.getLatestBlockhash().send();

    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayerSigner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
    );

    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const wireUnsigned = new Uint8Array(getTransactionEncoder().encode(partiallySigned));

    // Feature implementations live on the Wallet, not the account.
    const features = wallet.standardWallet.features as unknown as Record<string, unknown>;
    const signFeature = features['solana:signTransaction'] as SignTransactionFeature | undefined;
    if (!signFeature) throw new Error('Wallet does not support solana:signTransaction.');

    const res = await signFeature.signTransaction({
        account: wallet.account,
        transaction: wireUnsigned,
        chain: SOLANA_DEVNET_CHAIN,
    });
    const signed = Array.isArray(res) ? res[0] : (res as SignTransactionOutput);

    const wireBase64 = getBase64Decoder().decode(
        signed.signedTransaction,
    ) as Base64EncodedWireTransaction;
    const signature = await solanaRpc
        .sendTransaction(wireBase64, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send();

    return signature;
}
