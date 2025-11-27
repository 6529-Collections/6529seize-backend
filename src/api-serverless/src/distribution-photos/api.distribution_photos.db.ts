import { DISTRIBUTION_PHOTO_TABLE } from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { DistributionPhoto } from '../../../entities/IDistributionPhoto';
import { PaginatedResponse } from '../api-constants';
import { constructFilters } from '../api-helpers';

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
