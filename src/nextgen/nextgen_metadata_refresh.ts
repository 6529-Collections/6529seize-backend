import { getDataSource } from '../db';
import { Logger } from '../logging';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import { upsertToken } from './nextgen_core_events';
import { refreshNextgenTokens } from './nextgen_tokens';

const logger = Logger.get('NEXTGEN_METADATA_REFRESH');

export async function refreshNextgenMetadata() {
  logger.info(`[RUNNING]`);
  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const collections = await fetchNextGenCollections(entityManager);
    for (const collection of collections) {
      logger.info(`[PROCESSING COLLECTION ${collection.id}]`);
      const collectionTokens = await fetchNextGenTokensForCollection(
        entityManager,
        collection
      );
      await Promise.all(
        collectionTokens.map(async (token) => {
          await upsertToken(
            entityManager,
            collection,
            token.id,
            token.normalised_id,
            token.owner,
            token.mint_date,
            token.mint_price,
            token.burnt_date,
            token.hodl_rate,
            token.mint_data
          );
        })
      );
    }

    await refreshNextgenTokens(entityManager);
  });
}
