import { DISTRIBUTION_PHOTO_TABLE } from '@/constants';
import { fetchPaginated } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';
import { PaginatedResponse } from '@/api/api-constants';
import { constructFilters } from '@/api/api-helpers';
import { DistributionPhoto } from '@/api/generated/models/DistributionPhoto';

const DISTRIBUTION_PHOTOS_ORDER_BY = `id asc`;

function buildDistributionPhotoParams(contract: string, cardId: number) {
  return {
    contract: contract.toLowerCase(),
    card_id: cardId
  };
}

function buildDistributionPhotoFilters() {
  let filters = constructFilters('', `contract = :contract`);
  filters = constructFilters(filters, `card_id = :card_id`);
  return filters;
}

export async function fetchDistributionPhotos(
  contract: string,
  cardId: number,
  pageSize: number,
  page: number
): Promise<PaginatedResponse<DistributionPhoto>> {
  const filters = buildDistributionPhotoFilters();
  const params = buildDistributionPhotoParams(contract, cardId);

  return fetchPaginated(
    DISTRIBUTION_PHOTO_TABLE,
    params,
    DISTRIBUTION_PHOTOS_ORDER_BY,
    pageSize,
    page,
    filters,
    ``,
    ``
  );
}

export async function fetchDistributionPhotoLinks(
  contract: string,
  cardId: number
): Promise<{ link: string }[]> {
  return sqlExecutor.execute<{ link: string }>(
    `SELECT link FROM ${DISTRIBUTION_PHOTO_TABLE} WHERE contract = :contract AND card_id = :card_id ORDER BY ${DISTRIBUTION_PHOTOS_ORDER_BY}`,
    buildDistributionPhotoParams(contract, cardId)
  );
}

export async function fetchDistributionPhotosCount(
  contract: string,
  cardId: number
): Promise<number> {
  const result = await sqlExecutor.execute<{ count: number }>(
    `SELECT COUNT(*) as count FROM ${DISTRIBUTION_PHOTO_TABLE} WHERE contract = :contract AND card_id = :card_id`,
    buildDistributionPhotoParams(contract, cardId)
  );
  return result[0]?.count || 0;
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
