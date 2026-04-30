import {
	isConnected,
	requestAccess,
	getAddress,
	getNetwork,
	signTransaction
} from '@stellar/freighter-api';
import { STELLAR } from '$lib/config';

export type FreighterState = {
	installed: boolean;
	address: string | null;
	networkPassphrase: string | null;
};

export async function detectFreighter(): Promise<FreighterState> {
	const result = await isConnected();
	if (!result.isConnected) {
		return { installed: false, address: null, networkPassphrase: null };
	}
	const addr = await getAddress();
	if (addr.error || !addr.address) {
		return { installed: true, address: null, networkPassphrase: null };
	}
	const net = await getNetwork();
	return {
		installed: true,
		address: addr.address,
		networkPassphrase: net.networkPassphrase ?? null
	};
}

export async function connectFreighter(): Promise<FreighterState> {
	const result = await isConnected();
	if (!result.isConnected) {
		throw new Error('Freighter is not installed. Install it from freighter.app and reload.');
	}
	const access = await requestAccess();
	if (access.error || !access.address) {
		throw new Error(access.error ?? 'User declined to share their Stellar account.');
	}
	const net = await getNetwork();
	if (net.networkPassphrase && net.networkPassphrase !== STELLAR.networkPassphrase) {
		throw new Error(
			`Freighter is on the wrong network. Switch to Testnet (currently: ${net.network}).`
		);
	}
	return {
		installed: true,
		address: access.address,
		networkPassphrase: net.networkPassphrase
	};
}

export async function signXdr(xdr: string): Promise<string> {
	const signed = await signTransaction(xdr, {
		networkPassphrase: STELLAR.networkPassphrase
	});
	if (signed.error || !signed.signedTxXdr) {
		throw new Error(signed.error ?? 'Freighter did not return a signed transaction.');
	}
	return signed.signedTxXdr;
}
