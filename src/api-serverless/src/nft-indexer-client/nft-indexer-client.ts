import { env } from '../../../env';
import {
  NftIndexerCollectionMetadata,
  NftIndexerCollectionStatus,
  NftIndexerErrorApiModel
} from './nft-indexer-client-models';
import fetch from 'node-fetch';
import { Logger } from '../../../logging';
import { BadRequestException } from '../../../exceptions';
import { numbers } from '../../../numbers';

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

  async getContractStatus({
    chain,
    contract
  }: {
    chain: number;
    contract: string;
  }): Promise<{
    status: NftIndexerCollectionStatus;
    error: string | null;
    safe_head_block: number | null;
  }> {
    try {
      const metadata = await this.getJson<NftIndexerCollectionMetadata>(
        `/collection/${chain}/contract`
      );
      return {
        safe_head_block: metadata.safe_head_block ?? null,
        status: metadata.status ?? 'ERROR_SNAPSHOTTING',
        error:
          metadata.status === 'ERROR_SNAPSHOTTING'
            ? `Unknown snapshotting error`
            : null
      };
    } catch (e: any) {
      return {
        status: 'ERROR_SNAPSHOTTING',
        error: `Error fetching info from NFT indexer about chain/contract ${chain}/${contract} ${e?.message ?? JSON.stringify(e)}`,
        safe_head_block: null
      };
    }
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

  async getSnapshot({
    target_contract,
    target_chain,
    block
  }: {
    target_contract: string;
    target_chain: number;
    block: number;
  }): Promise<
    {
      tokenId: number;
      owner: string;
      block: number;
      timestamp: number;
      acquiredAsSale: boolean;
    }[]
  > {
    const endpoint = `${this.config.endpoint()}/collection/${target_chain}/${target_contract}/snapshot.csv?at_block=${block}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'text/csv'
      }
    });
    const csvText = await response.text();
    const rows = csvText.split('\n');
    return rows
      .slice(1)
      .map((line) =>
        line.split(',').map((cols) => ({
          tokenId: numbers.parseIntOrNull(cols[0])!,
          owner: cols[1]!,
          block: numbers.parseIntOrNull(cols[2])!,
          timestamp: numbers.parseIntOrNull(cols[3])!,
          acquiredAsSale: cols[4] === 'true'
        }))
      )
      .flat();
  }
}

export const nftIndexerClient = new NftIndexerClient(
  new EnvBasedNftIndexerClientConf()
);
