import { getDataSource } from '../db';
import { Logger } from '../logging';
import { fetchAllNftOwners } from '../nftOwnersLoop/db.nft_owners';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import { NEXTGEN_CORE_CONTRACT, getNextgenNetwork } from './nextgen_constants';
import { upsertToken } from './nextgen_core_events';
import { refreshNextgenTokens } from './nextgen_tokens';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function refreshNextgenMetadata() {
  logger.info(`[RUNNING]`);
  const dataSource = getDataSource();
  const network = getNextgenNetwork();
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
}
