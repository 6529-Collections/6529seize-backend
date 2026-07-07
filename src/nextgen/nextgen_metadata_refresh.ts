import { EntityManager } from 'typeorm';
import { getDataSource } from '../db';
import { NextGenCollection, NextGenToken } from '../entities/INextGen';
import { Logger } from '../logging';
import { fetchAllNftOwners } from '../nftOwnersLoop/db.nft_owners';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import { NEXTGEN_CORE_CONTRACT, getNextgenNetwork } from './nextgen_constants';
import { upsertToken } from './nextgen_core_events';
import { refreshNextgenTokens } from './nextgen_tokens';
import {
  isRetryableDbLockError,
  withNextgenDbLockRetry
} from './nextgen-db-lock-retry';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');

type TokenRefreshSuccess = {
  metadataLink: string;
  success: true;
  tokenId: number;
};

type TokenRefreshFailure = {
  error: string;
  metadataLink: string;
  success: false;
  tokenId: number;
};

type TokenRefreshResult = TokenRefreshSuccess | TokenRefreshFailure;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function refreshNextgenMetadata() {
  logger.info(`[RUNNING]`);
  const dataSource = getDataSource();
  const network = getNextgenNetwork();
  await withNextgenDbLockRetry(
    async () =>
      await dataSource.transaction(async (entityManager) => {
        const collections = await fetchNextGenCollections(entityManager);
        const owners = await fetchAllNftOwners([
          NEXTGEN_CORE_CONTRACT[network].toLowerCase()
        ]);
        const ownerByTokenId = new Map(
          owners.map((owner) => [
            Number(owner.token_id),
            owner.wallet.toLowerCase()
          ])
        );

        for (const collection of collections) {
          logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
          const collectionTokens = await fetchNextGenTokensForCollection(
            entityManager,
            collection
          );
          const tokenRefreshResults: TokenRefreshResult[] = [];
          for (const token of collectionTokens) {
            tokenRefreshResults.push(
              await refreshToken(
                entityManager,
                collection,
                token,
                ownerByTokenId
              )
            );
          }

          throwIfRefreshFailures(collection, tokenRefreshResults);
        }

        await refreshNextgenTokens(entityManager);
      }),
    {
      logger,
      operation: 'refresh-nextgen-metadata'
    }
  );
}

async function refreshToken(
  entityManager: EntityManager,
  collection: NextGenCollection,
  token: NextGenToken,
  ownerByTokenId: Map<number, string>
): Promise<TokenRefreshResult> {
  const metadataLink = `${collection.base_uri}${token.id}`;
  const owner = ownerByTokenId.get(Number(token.id)) ?? token.owner;
  try {
    await upsertToken(
      entityManager,
      collection,
      token.id,
      token.normalised_id,
      owner,
      token.mint_date,
      token.mint_price,
      token.burnt_date,
      token.hodl_rate,
      token.mint_data
    );
    return {
      tokenId: token.id,
      metadataLink,
      success: true
    };
  } catch (error: unknown) {
    if (isRetryableDbLockError(error)) {
      throw error;
    }
    const errMsg = errorMessage(error);
    logger.error(
      `[TOKEN REFRESH FAILED] [COLLECTION ${collection.id}] [TOKEN ID ${token.id}] [METADATA LINK ${metadataLink}] [ERROR ${errMsg}]`
    );
    return {
      tokenId: token.id,
      metadataLink,
      success: false,
      error: errMsg
    };
  }
}

function throwIfRefreshFailures(
  collection: NextGenCollection,
  results: TokenRefreshResult[]
): void {
  const failures = results.filter(
    (result): result is TokenRefreshFailure => !result.success
  );
  if (failures.length === 0) return;

  const firstFailure = failures[0];
  throw new Error(
    `[COLLECTION ${collection.id}] Failed refreshing ${failures.length}/${results.length} tokens. First failure token ${firstFailure.tokenId} (${firstFailure.metadataLink}): ${firstFailure.error}`
  );
}
