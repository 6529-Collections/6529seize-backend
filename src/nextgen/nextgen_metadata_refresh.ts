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
      await Promise.all(
        collectionTokens.map(async (token) => {
          const owner =
            owners
              .find((o) => Number(o.token_id) === Number(token.id))
              ?.wallet.toLowerCase() ?? token.owner;
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
        })
      );
    }

    await refreshNextgenTokens(entityManager);
  });
}
