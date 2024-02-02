import { getDataSource } from '../db';
import { Logger } from '../logging';
import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import { upsertToken } from './nextgen_core_events';
import { processTraitScores } from './nextgen_traits';

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
            false,
            token.burnt,
            token.hodl_rate
          );
        })
      );
    }

    await processTraitScores(entityManager);
  });
}
