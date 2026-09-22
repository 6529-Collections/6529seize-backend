import { Alchemy } from '@/alchemy-sdk';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { ALCHEMY_SETTINGS } from '@/constants';

let alchemy: Alchemy | null = null;

export function getAlchemyInstance(
  network: Network = Network.ETH_MAINNET
): Alchemy {
  if (alchemy?.config.network !== network) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      network,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }
  return alchemy;
}
