import { Alchemy, Network } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS } from './constants';

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
