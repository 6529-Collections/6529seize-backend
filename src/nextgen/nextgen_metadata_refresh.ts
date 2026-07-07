import { getDataSource } from '../db';
import { Logger } from '../logging';
import { fetchAllNftOwners } from '../nftOwnersLoop/db.nft_owners';
import { NextGenCollection, NextGenToken } from '../entities/INextGen';
import { DataSource } from 'typeorm';
import * as nextgenDb from './nextgen.db';
import { NEXTGEN_CORE_CONTRACT, getNextgenNetwork } from './nextgen_constants';
import * as nextgenCoreEvents from './nextgen_core_events';
import { isRetryableMetadataFetchError } from './nextgen-metadata';
import * as nextgenTokens from './nextgen_tokens';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');

const TOKEN_REFRESH_CONCURRENCY = 20;
const TOKEN_REFRESH_DB_ATTEMPTS = 3;
const TOKEN_REFRESH_RETRY_BASE_DELAY_MS = 250;
const MAX_TRANSIENT_FAILURES_TO_SKIP = 5;
const MAX_TRANSIENT_FAILURE_RATIO_TO_SKIP = 0.01;

type TokenRefreshSuccess = {
  metadataLink: string;
  success: true;
  tokenId: number;
};

type TokenRefreshFailure = {
  error: string;
  metadataLink: string;
  retryable: boolean;
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
  const collections = await nextgenDb.fetchNextGenCollections(
    dataSource.manager
  );
  const owners = await fetchAllNftOwners([
    NEXTGEN_CORE_CONTRACT[network].toLowerCase()
  ]);
  const ownerByTokenId = new Map(
    owners.map((owner) => [Number(owner.token_id), owner.wallet.toLowerCase()])
  );

  for (const collection of collections) {
    logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
    const collectionTokens = await nextgenDb.fetchNextGenTokensForCollection(
      dataSource.manager,
      collection
    );
    const tokenRefreshResults = await mapWithConcurrency(
      collectionTokens,
      TOKEN_REFRESH_CONCURRENCY,
      async (token) =>
        refreshToken(dataSource, collection, token, ownerByTokenId)
    );

    handleRefreshFailures(collection, tokenRefreshResults);
  }

  await dataSource.transaction(async (entityManager) => {
    await nextgenTokens.refreshNextgenTokens(entityManager);
  });
}

async function refreshToken(
  dataSource: DataSource,
  collection: NextGenCollection,
  token: NextGenToken,
  ownerByTokenId: Map<number, string>
): Promise<TokenRefreshResult> {
  const metadataLink = `${collection.base_uri}${token.id}`;
  const owner = ownerByTokenId.get(Number(token.id)) ?? token.owner;
  try {
    await refreshTokenWithDbRetries(dataSource, collection, token, owner);
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
      retryable: isTransientTokenFailure(error),
      error: errMsg
    };
  }
}

async function refreshTokenWithDbRetries(
  dataSource: DataSource,
  collection: NextGenCollection,
  token: NextGenToken,
  owner: string
): Promise<void> {
  for (let attempt = 1; attempt <= TOKEN_REFRESH_DB_ATTEMPTS; attempt++) {
    try {
      await dataSource.transaction(async (entityManager) => {
        await nextgenCoreEvents.upsertToken(
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
      });
      return;
    } catch (error: unknown) {
      if (!isRetryableDbError(error) || attempt === TOKEN_REFRESH_DB_ATTEMPTS) {
        throw error;
      }
      logger.warn(
        `[TOKEN REFRESH RETRY] [COLLECTION ${collection.id}] [TOKEN ID ${token.id}] [ATTEMPT ${attempt}/${TOKEN_REFRESH_DB_ATTEMPTS}] [ERROR ${errorMessage(error)}]`
      );
      await sleep(tokenRefreshRetryDelayMs(attempt));
    }
  }
}

function handleRefreshFailures(
  collection: NextGenCollection,
  results: TokenRefreshResult[]
): void {
  const failures = results.filter(
    (result): result is TokenRefreshFailure => !result.success
  );
  if (failures.length === 0) return;

  if (shouldSkipTransientFailures(failures, results.length)) {
    logger.warn(
      `[COLLECTION ${collection.id}] Skipping ${failures.length}/${results.length} transient token refresh failures`
    );
    return;
  }

  const firstFailure =
    failures.find((failure) => !failure.retryable) ?? failures[0];
  throw new Error(
    `[COLLECTION ${collection.id}] Failed refreshing ${failures.length}/${results.length} tokens. First failure token ${firstFailure.tokenId} (${firstFailure.metadataLink}): ${firstFailure.error}`
  );
}

function shouldSkipTransientFailures(
  failures: TokenRefreshFailure[],
  tokenCount: number
): boolean {
  if (failures.length === 0 || tokenCount === 0) return false;
  if (failures.some((failure) => !failure.retryable)) return false;
  return (
    failures.length <= MAX_TRANSIENT_FAILURES_TO_SKIP &&
    failures.length / tokenCount <= MAX_TRANSIENT_FAILURE_RATIO_TO_SKIP
  );
}

function isTransientTokenFailure(error: unknown): boolean {
  return isRetryableMetadataFetchError(error) || isRetryableDbError(error);
}

function isRetryableDbError(error: unknown): boolean {
  const dbError = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  const code = String(dbError.code ?? '');
  const errno = Number(dbError.errno);
  const message = String(dbError.message ?? '');
  return (
    code === 'ER_LOCK_DEADLOCK' ||
    code === 'ER_LOCK_WAIT_TIMEOUT' ||
    errno === 1213 ||
    errno === 1205 ||
    message.includes('Deadlock found when trying to get lock')
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

function tokenRefreshRetryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  return TOKEN_REFRESH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
