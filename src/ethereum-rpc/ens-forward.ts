import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { ethTools } from '@/eth-tools';
import { Time } from '@/time';
import * as mcache from 'memory-cache';

export async function getWalletFromEns(
  identity: string
): Promise<string | null> {
  const normalisedIdentity = identity.toLowerCase();
  if (!normalisedIdentity.endsWith('.eth')) {
    return null;
  }
  const key = `ens2wallet-${normalisedIdentity}`;

  const cacheHit = mcache.get(key);
  if (cacheHit) {
    return cacheHit;
  } else {
    const rpcResponse = await getEthereumRpcClient()
      .resolveName(identity)
      .then((response) => response?.toLowerCase() ?? ``);
    mcache.put(key, rpcResponse, Time.minutes(1).toMillis());
    return ethTools.isEthAddress(rpcResponse) ? rpcResponse : null;
  }
}
