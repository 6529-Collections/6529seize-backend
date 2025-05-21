import { Alchemy, Network } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS } from './constants';
import * as mcache from 'memory-cache';
import { Time } from './time';
import { isWallet } from './helpers';

let alchemy: Alchemy | null = null;

export function getAlchemyInstance(
  network: Network = Network.ETH_MAINNET
): Alchemy {
  if (!alchemy || alchemy.config.network != network) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      network,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }
  return alchemy;
}

export async function getEns(address: string) {
  let ens: string | null;
  try {
    const alchemy = getAlchemyInstance();
    ens = await alchemy.core.lookupAddress(address);
  } catch (error) {
    ens = null;
  }
  return ens;
}

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
    const alchemyResponse = await getAlchemyInstance()
      .core.resolveName(identity)
      .then((response) => response?.toLowerCase() ?? ``);
    mcache.put(key, alchemyResponse, Time.minutes(1).toMillis());
    return isWallet(alchemyResponse) ? alchemyResponse : null;
  }
}
