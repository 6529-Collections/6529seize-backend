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
import { withNextgenDbLockRetry } from './nextgen-db-lock-retry';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');

const TOKEN_REFRESH_CONCURRENCY = 20;

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
  const collections = await fetchNextGenCollections(dataSource.manager);
  const owners = await fetchAllNftOwners([
    NEXTGEN_CORE_CONTRACT[network].toLowerCase()
  ]);
  const ownerByTokenId = new Map(
    owners.map((owner) => [Number(owner.token_id), owner.wallet.toLowerCase()])
  );

  for (const collection of collections) {
    logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
    const collectionTokens = await fetchNextGenTokensForCollection(
      dataSource.manager,
      collection
    );
    const tokenRefreshResults = await mapWithConcurrency(
      collectionTokens,
      TOKEN_REFRESH_CONCURRENCY,
      async (token) =>
        refreshToken(dataSource, collection, token, ownerByTokenId)
    );

    throwIfRefreshFailures(collection, tokenRefreshResults);
  }

  await withNextgenDbLockRetry(
    async () =>
      await dataSource.transaction(async (entityManager) => {
        await refreshNextgenTokens(entityManager);
      }),
    {
      logger,
      operation: 'refresh-nextgen-token-scores'
    }
  );
}

async function refreshToken(
  dataSource: ReturnType<typeof getDataSource>,
  collection: NextGenCollection,
  token: NextGenToken,
  ownerByTokenId: Map<number, string>
): Promise<TokenRefreshResult> {
  const metadataLink = `${collection.base_uri}${token.id}`;
  const owner = ownerByTokenId.get(Number(token.id)) ?? token.owner;
  try {
    await withNextgenDbLockRetry(
      async () =>
        await dataSource.transaction(async (entityManager) => {
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
        }),
      {
        logger,
        operation: `refresh-nextgen-token-${token.id}`
      }
    );
    return {
      tokenId: token.id,
      metadataLink,
      success: true
    };
  } catch (error: unknown) {
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}
