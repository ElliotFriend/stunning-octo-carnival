import { TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import { STELLAR } from '$lib/config';
import { stellarRpc } from './client';
import { signXdr } from './freighter';

// Simulate, prepare, sign with Freighter, submit, poll until SUCCESS or FAILED.
// Returns the on-chain transaction hash.
export async function simulateSignAndSubmit(
    tx: ReturnType<TransactionBuilder['build']>,
): Promise<string> {
    const sim = await stellarRpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Soroban simulation failed: ${sim.error}`);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();

    const signedXdr = await signXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, STELLAR.networkPassphrase);

    const send = await stellarRpc.sendTransaction(signed);
    if (send.status === 'ERROR') {
        throw new Error(`Submission rejected: ${JSON.stringify(send.errorResult)}`);
    }

    let attempts = 0;
    while (attempts++ < 60) {
        const got = await stellarRpc.getTransaction(send.hash);
        if (got.status === 'SUCCESS') return send.hash;
        if (got.status === 'FAILED') {
            throw new Error(`Transaction failed on-chain: ${send.hash}`);
        }
        await sleep(1000);
    }
    throw new Error(`Transaction did not finalize within 60s: ${send.hash}`);
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}
