import { env } from '../../../env';
import {
  NftIndexerCollectionMetadata,
  NftIndexerErrorApiModel
} from './nft-indexer-client-models';
import fetch from 'node-fetch';
import { Logger } from '../../../logging';
import { BadRequestException } from '../../../exceptions';

export interface NftIndexerClientConf {
  endpoint(): string;
}

class EnvBasedNftIndexerClientConf implements NftIndexerClientConf {
  public endpoint(): string {
    return env.getStringOrThrow('NFT_INDEXER_ENDPOINT');
  }
}

export class NftIndexerError extends Error {
  public constructor(model: NftIndexerErrorApiModel) {
    super(JSON.stringify(model));
  }
}

export class NftIndexerNotFound404Error extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class NftIndexerClient {
  private readonly logger = Logger.get(this.constructor.name);
  constructor(private readonly config: NftIndexerClientConf) {}

  public async getStateOrStartIndexing({
    chain,
    contract
  }: {
    chain: number;
    contract: string;
  }): Promise<NftIndexerCollectionMetadata> {
    return await this.postJson<NftIndexerCollectionMetadata>(`/collection`, {
      chain,
      contract
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    const endpoint = `${this.config.endpoint()}${path}`;
    try {
      const result = await fetch(endpoint, {
        method: 'GET',
        headers: {
          accept: 'application/json'
        }
      });
      const resultJson = await result.json();
      if (result.status !== 200) {
        if (result.status === 404) {
          throw new NftIndexerNotFound404Error(resultJson.message);
        }
        throw new NftIndexerError(resultJson);
      }
      return resultJson;
    } catch (error) {
      this.logger.error(
        `Error invoking GET ${endpoint}: ${JSON.stringify(error)}`
      );
      throw error;
    }
  }

  private async postJson<T>(path: string, jsonBody: any): Promise<T> {
    const endpoint = `${this.config.endpoint()}${path}`;
    try {
      const result = await fetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(jsonBody)
      });
      const resultJson = await result.json();
      if (result.status === 422 && resultJson.error === 'UnindexableContract') {
        throw new BadRequestException(resultJson.message);
      }
      if (result.status !== 201 && result.status !== 200) {
        throw new NftIndexerError(resultJson);
      }
      return resultJson;
    } catch (error) {
      this.logger.error(
        `Error invoking POST ${endpoint} with body ${JSON.stringify(jsonBody)}: ${JSON.stringify(error)}`
      );
      throw error;
    }
  }
}

export const nftIndexerClient = new NftIndexerClient(
  new EnvBasedNftIndexerClientConf()
);
