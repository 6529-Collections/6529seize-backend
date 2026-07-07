import { getDataSource } from '../db';
import { Logger } from '../logging';
import { fetchAllNftOwners } from '../nftOwnersLoop/db.nft_owners';
import { NextGenCollection, NextGenToken } from '../entities/INextGen';
import { DataSource, EntityManager } from 'typeorm';
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
  collection: NextGenCollection;
  metadata: nextgenCoreEvents.NextGenTokenMetadata;
  metadataLink: string;
  owner: string;
  success: true;
  token: NextGenToken;
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

type CollectionRefreshPlan = {
  collection: NextGenCollection;
  tokens: TokenRefreshSuccess[];
};

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

  const refreshPlans: CollectionRefreshPlan[] = [];
  const transientFailures: TokenRefreshFailure[] = [];
  let totalTokenCount = 0;

  for (const collection of collections) {
    logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
    const collectionTokens = await nextgenDb.fetchNextGenTokensForCollection(
      dataSource.manager,
      collection
    );
    totalTokenCount += collectionTokens.length;
    const tokenRefreshResults = await mapWithConcurrency(
      collectionTokens,
      TOKEN_REFRESH_CONCURRENCY,
      async (token) => fetchTokenMetadata(collection, token, ownerByTokenId)
    );

    const failures = tokenRefreshResults.filter(
      (result): result is TokenRefreshFailure => !result.success
    );
    const permanentFailure = failures.find((failure) => !failure.retryable);
    if (permanentFailure) {
      throw refreshFailureError(
        collection,
        failures,
        tokenRefreshResults.length
      );
    }

    transientFailures.push(...failures);
    refreshPlans.push({
      collection,
      tokens: tokenRefreshResults.filter(
        (result): result is TokenRefreshSuccess => result.success
      )
    });
  }

  handleTransientFailures(transientFailures, totalTokenCount);
  await runRefreshTransactionWithDbRetries(dataSource, refreshPlans);
}

async function fetchTokenMetadata(
  collection: NextGenCollection,
  token: NextGenToken,
  ownerByTokenId: Map<number, string>
): Promise<TokenRefreshResult> {
  const metadataLink = `${collection.base_uri}${token.id}`;
  const owner = ownerByTokenId.get(Number(token.id)) ?? token.owner;
  try {
    const metadata = await nextgenCoreEvents.fetchNextGenTokenMetadata(
      collection,
      token.id
    );
    return {
      collection,
      metadata,
      metadataLink: metadata.metadataLink,
      owner,
      tokenId: token.id,
      token,
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

async function runRefreshTransactionWithDbRetries(
  dataSource: DataSource,
  refreshPlans: CollectionRefreshPlan[]
): Promise<void> {
  for (let attempt = 1; attempt <= TOKEN_REFRESH_DB_ATTEMPTS; attempt++) {
    try {
      await dataSource.transaction(async (entityManager) => {
        await persistRefreshPlans(entityManager, refreshPlans);
      });
      return;
    } catch (error: unknown) {
      if (!isRetryableDbError(error) || attempt === TOKEN_REFRESH_DB_ATTEMPTS) {
        throw error;
      }
      logger.warn(
        `[REFRESH TRANSACTION RETRY] [ATTEMPT ${attempt}/${TOKEN_REFRESH_DB_ATTEMPTS}] [ERROR ${errorMessage(error)}]`
      );
      await sleep(tokenRefreshRetryDelayMs(attempt));
    }
  }
}

async function persistRefreshPlans(
  entityManager: EntityManager,
  refreshPlans: CollectionRefreshPlan[]
): Promise<void> {
  for (const refreshPlan of refreshPlans) {
    for (const tokenRefresh of refreshPlan.tokens) {
      await nextgenCoreEvents.persistTokenWithMetadata(
        entityManager,
        tokenRefresh.collection,
        tokenRefresh.token.id,
        tokenRefresh.token.normalised_id,
        tokenRefresh.owner,
        tokenRefresh.token.mint_date,
        tokenRefresh.token.mint_price,
        tokenRefresh.token.burnt_date,
        tokenRefresh.token.hodl_rate,
        tokenRefresh.token.mint_data,
        tokenRefresh.metadata
      );
    }
  }
  await nextgenTokens.refreshNextgenTokens(entityManager);
}

function handleTransientFailures(
  failures: TokenRefreshFailure[],
  tokenCount: number
): void {
  if (failures.length === 0) return;

  if (shouldSkipTransientFailures(failures, tokenCount)) {
    const skippedTokens = failures
      .slice(0, 20)
      .map((failure) => `${failure.tokenId}:${failure.metadataLink}`)
      .join(',');
    logger.error(
      `[SKIPPING TRANSIENT TOKEN REFRESH FAILURES] [COUNT ${failures.length}/${tokenCount}] [TOKENS ${skippedTokens}]`
    );
    return;
  }

  throw refreshFailureErrorForFailures(failures, tokenCount);
}

function refreshFailureError(
  collection: NextGenCollection,
  failures: TokenRefreshFailure[],
  tokenCount: number
): Error {
  const firstFailure =
    failures.find((failure) => !failure.retryable) ?? failures[0];
  return new Error(
    `[COLLECTION ${collection.id}] Failed refreshing ${failures.length}/${tokenCount} tokens. First failure token ${firstFailure.tokenId} (${firstFailure.metadataLink}): ${firstFailure.error}`
  );
}

function refreshFailureErrorForFailures(
  failures: TokenRefreshFailure[],
  tokenCount: number
): Error {
  const firstFailure =
    failures.find((failure) => !failure.retryable) ?? failures[0];
  return new Error(
    `Failed refreshing ${failures.length}/${tokenCount} tokens. First failure token ${firstFailure.tokenId} (${firstFailure.metadataLink}): ${firstFailure.error}`
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
  return TOKEN_REFRESH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
