import { DISTRIBUTION_PHOTO_TABLE } from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { sqlExecutor } from '../../../sql-executor';
import { PaginatedResponse } from '../api-constants';
import { constructFilters } from '../api-helpers';
import { DistributionPhoto } from '../generated/models/DistributionPhoto';

export async function fetchDistributionPhotos(
  contract: string,
  cardId: number,
  pageSize: number,
  page: number
): Promise<PaginatedResponse<DistributionPhoto>> {
  let filters = constructFilters('', `contract = :contract`);
  filters = constructFilters(filters, `card_id = :card_id`);
  const params = {
    contract: contract,
    card_id: cardId
  };

  return fetchPaginated(
    DISTRIBUTION_PHOTO_TABLE,
    params,
    `link asc`,
    pageSize,
    page,
    filters,
    ``,
    ``
  );
}

export async function saveDistributionPhotos(
  contract: string,
  cardId: number,
  photoUrls: string[]
): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(
    async (connectionHolder) => {
      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_PHOTO_TABLE} WHERE card_id = :cardId AND contract = :contract`,
        {
          cardId,
          contract: contract.toLowerCase()
        },
        { wrappedConnection: connectionHolder }
      );

      await sqlExecutor.bulkInsert(
        DISTRIBUTION_PHOTO_TABLE,
        photoUrls.map((link) => ({
          contract: contract.toLowerCase(),
          card_id: cardId,
          link
        })),
        ['contract', 'card_id', 'link'],
        undefined,
        { connection: connectionHolder }
      );
    }
  );
}
