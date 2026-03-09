import { getDataSource } from '../db';
import { Logger } from '../logging';
import { fetchAllNftOwners } from '../nftOwnersLoop/db.nft_owners';
import { randomInt } from 'crypto';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import { NEXTGEN_CORE_CONTRACT, getNextgenNetwork } from './nextgen_constants';
import { upsertToken } from './nextgen_core_events';
import { refreshNextgenTokens } from './nextgen_tokens';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');
const DEADLOCK_MAX_ATTEMPTS = 3;
const DEADLOCK_BASE_RETRY_DELAY_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDeadlockError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | undefined;
  const msg = errorMessage(error);
  return (
    err?.code === 'ER_LOCK_DEADLOCK' ||
    msg.includes('ER_LOCK_DEADLOCK') ||
    msg.includes('Deadlock found when trying to get lock')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refreshNextgenMetadata() {
  logger.info(`[RUNNING]`);
  const dataSource = getDataSource();
  const network = getNextgenNetwork();
  for (let attempt = 1; attempt <= DEADLOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await dataSource.transaction(async (entityManager) => {
        const collections = await fetchNextGenCollections(entityManager);
        for (const collection of collections) {
          logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
          const collectionTokens = await fetchNextGenTokensForCollection(
            entityManager,
            collection
          );
          const owners = await fetchAllNftOwners([
            NEXTGEN_CORE_CONTRACT[network].toLowerCase()
          ]);
          const tokenRefreshResults = await Promise.all(
            collectionTokens.map(async (token) => {
              const metadataLink = `${collection.base_uri}${token.id}`;
              const owner =
                owners
                  .find((o) => Number(o.token_id) === Number(token.id))
                  ?.wallet.toLowerCase() ?? token.owner;
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
                  success: true as const
                };
              } catch (error: unknown) {
                const errMsg = errorMessage(error);
                logger.error(
                  `[TOKEN REFRESH FAILED] [COLLECTION ${collection.id}] [TOKEN ID ${token.id}] [METADATA LINK ${metadataLink}] [ERROR ${errMsg}]`
                );
                return {
                  tokenId: token.id,
                  metadataLink,
                  success: false as const,
                  error: errMsg
                };
              }
            })
          );

          const failures = tokenRefreshResults.filter((r) => !r.success);
          if (failures.length > 0) {
            const firstFailure = failures[0];
            throw new Error(
              `[COLLECTION ${collection.id}] Failed refreshing ${failures.length}/${tokenRefreshResults.length} tokens. First failure token ${firstFailure?.tokenId} (${firstFailure?.metadataLink}): ${firstFailure?.error}`
            );
          }
        }

        await refreshNextgenTokens(entityManager);
      });
      return;
    } catch (error: unknown) {
      const isDeadlock = isDeadlockError(error);
      if (!isDeadlock || attempt === DEADLOCK_MAX_ATTEMPTS) {
        throw error;
      }

      const jitter = randomInt(0, 100);
      const retryInMs =
        DEADLOCK_BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + jitter;
      logger.warn(
        `[DEADLOCK RETRY] [ATTEMPT ${attempt}/${DEADLOCK_MAX_ATTEMPTS}] [RETRY_IN_MS ${retryInMs}] [ERROR ${errorMessage(
          error
        )}]`
      );
      await sleep(retryInMs);
    }
  }
}
