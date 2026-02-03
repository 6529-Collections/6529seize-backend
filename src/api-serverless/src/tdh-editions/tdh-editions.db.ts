import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  TDH_EDITIONS_TABLE
} from '@/constants';
import { fetchPaginated } from '../../../db-api';
import { constructFilters } from '../api-helpers';

export type TdhEditionFilters = {
  contract?: string;
  tokenId?: number;
  editionId?: number;
};

function buildOrderBy(sort: string, sortDir: string, table: string) {
  return `${table}.${sort} ${sortDir}`;
}

function applyEditionFilters(
  table: string,
  filters: string,
  params: Record<string, any>,
  options: TdhEditionFilters
) {
  if (options.contract) {
    params.contract = options.contract.toLowerCase();
    filters = constructFilters(filters, `${table}.contract = :contract`);
  }
  if (options.tokenId !== undefined) {
    params.tokenId = options.tokenId;
    filters = constructFilters(filters, `${table}.id = :tokenId`);
  }
  if (options.editionId !== undefined) {
    params.editionId = options.editionId;
    filters = constructFilters(filters, `${table}.edition_id = :editionId`);
  }
  return filters;
}

export async function fetchWalletTdhEditions(
  wallet: string,
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  options: TdhEditionFilters
) {
  const params: Record<string, any> = { wallet };
  let filters = constructFilters('', `${TDH_EDITIONS_TABLE}.wallet = :wallet`);
  filters = applyEditionFilters(TDH_EDITIONS_TABLE, filters, params, options);

  return fetchPaginated(
    TDH_EDITIONS_TABLE,
    params,
    buildOrderBy(sort, sortDir, TDH_EDITIONS_TABLE),
    pageSize,
    page,
    filters
  );
}

export async function fetchConsolidatedTdhEditions(
  consolidationKey: string,
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  options: TdhEditionFilters
) {
  const params: Record<string, any> = { consolidationKey };
  let filters = constructFilters(
    '',
    `${CONSOLIDATED_TDH_EDITIONS_TABLE}.consolidation_key = :consolidationKey`
  );
  filters = applyEditionFilters(
    CONSOLIDATED_TDH_EDITIONS_TABLE,
    filters,
    params,
    options
  );

  return fetchPaginated(
    CONSOLIDATED_TDH_EDITIONS_TABLE,
    params,
    buildOrderBy(sort, sortDir, CONSOLIDATED_TDH_EDITIONS_TABLE),
    pageSize,
    page,
    filters
  );
}
