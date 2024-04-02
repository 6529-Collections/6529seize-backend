import { constructFilters } from 'src/api-helpers';
import { NFT_OWNERS_CONSOLIDATION_TABLE } from '../../../constants';
import { fetchPaginated } from '../../../db-api';

export async function fetchNftOwnersForConsolidation(
  consolidationKey: string,
  contractStr: string | undefined,
  tokenId: string | undefined,
  page: number,
  pageSize: number
) {
  let filters = constructFilters('', `consolidation_key = :consolidationKey`);
  const params: any = { consolidationKey };

  if (contractStr) {
    filters = constructFilters(filters, `contract in (:contracts)`);
    params.contracts = contractStr.split(',');
  }
  if (tokenId) {
    filters = constructFilters(filters, `token_id in (:tokenIds)`);
    params.tokenIds = tokenId.split(',').map((id) => parseInt(id));
  }

  return await fetchPaginated(
    NFT_OWNERS_CONSOLIDATION_TABLE,
    params,
    'contract asc, token_id asc',
    pageSize,
    page,
    filters
  );
}
