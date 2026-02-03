import { constructFilters } from '../api-helpers';
import { NFT_OWNERS_CONSOLIDATION_TABLE } from '@/constants';
import { fetchPaginated } from '../../../db-api';
import { ApiNftOwnerPage } from '../generated/models/ApiNftOwnerPage';
import { ApiNftOwner } from '../generated/models/ApiNftOwner';

export async function fetchAllNftOwners(
  contract: string | undefined,
  tokenId: string | undefined,
  page: number,
  pageSize: number,
  sortDir: string
): Promise<ApiNftOwnerPage> {
  let filters = '';
  const params: any = {};
  if (contract) {
    filters = constructFilters(filters, `contract = :contract`);
    params.contract = contract;
  }

  if (tokenId) {
    filters = constructFilters(filters, `token_id in (:tokenIds)`);
    params.tokenIds = tokenId.split(',').map((id) => parseInt(id));
  }

  return await fetchPaginated<ApiNftOwner>(
    NFT_OWNERS_CONSOLIDATION_TABLE,
    params,
    `contract ${sortDir}, token_id ${sortDir}`,
    pageSize,
    page,
    filters
  );
}

export async function fetchNftOwnersForConsolidation(
  consolidationKey: string,
  contractStr: string | undefined,
  tokenId: string | undefined,
  page: number,
  pageSize: number
): Promise<ApiNftOwnerPage> {
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

  return await fetchPaginated<ApiNftOwner>(
    NFT_OWNERS_CONSOLIDATION_TABLE,
    params,
    'contract asc, token_id asc',
    pageSize,
    page,
    filters
  );
}
