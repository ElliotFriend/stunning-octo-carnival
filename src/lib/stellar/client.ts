import { rpc, Horizon } from '@stellar/stellar-sdk';
import { STELLAR } from '$lib/config';

export const stellarRpc = new rpc.Server(STELLAR.rpcUrl, { allowHttp: false });
export const horizon = new Horizon.Server(STELLAR.horizonUrl);
