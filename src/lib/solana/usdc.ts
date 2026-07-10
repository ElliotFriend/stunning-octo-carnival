import { address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { SOLANA } from '$lib/config';
import { solanaRpc } from './client';

// Devnet USDC uses the classic SPL Token program (not Token-2022), so
// TOKEN_PROGRAM_ADDRESS is the correct token-program seed for the ATA.
export async function getUsdcBalance(owner: string): Promise<string> {
    const [ata] = await findAssociatedTokenPda({
        owner: address(owner),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: address(SOLANA.usdc.mint),
    });

    // The ATA does not exist until the owner first receives USDC. Probe with
    // getAccountInfo (returns null for a missing account) instead of letting
    // getTokenAccountBalance throw, so a genuine RPC failure still surfaces.
    const info = await solanaRpc.getAccountInfo(ata, { encoding: 'base64' }).send();
    if (info.value === null) return '0';

    const bal = await solanaRpc.getTokenAccountBalance(ata).send();
    return bal.value.uiAmountString ?? '0';
}
