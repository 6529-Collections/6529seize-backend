import { ethers } from 'ethers';
import { env } from '../env';

export class ExternalIndexerRpc {
  private instance: ethers.providers.JsonRpcProvider | undefined;

  public get provider(): ethers.providers.JsonRpcProvider {
    if (!this.instance) {
      this.instance = new ethers.providers.JsonRpcProvider(
        env.getStringOrThrow('NFT_INDEXER_RPC')
      );
    }
    return this.instance;
  }
}

export const externalIndexerRpc = new ExternalIndexerRpc();
