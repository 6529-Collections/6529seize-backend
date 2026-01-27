import { ethers } from 'ethers';
import { env } from '../env';

export class ExternalIndexerRpc {
  private instance: ethers.JsonRpcProvider | undefined;

  public get provider(): ethers.JsonRpcProvider {
    if (!this.instance) {
      this.instance = new ethers.JsonRpcProvider(
        env.getStringOrThrow('NFT_INDEXER_RPC')
      );
    }
    return this.instance;
  }
}

export const externalIndexerRpc = new ExternalIndexerRpc();
