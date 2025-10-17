import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  IDENTITIES_TABLE,
  TDH_EDITIONS_TABLE
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { constructFilters } from '../api-helpers';

export const TDH_EDITION_SORT_MAP: Record<string, string> = {
  hodl_rate: 'hodl_rate',
  days_held: 'days_held',
  balance: 'balance',
  edition_id: 'edition_id',
  id: 'id',
  contract: 'contract'
};

export const DEFAULT_TDH_EDITION_SORT = 'id';

export type TdhEditionFilters = {
  contract?: string;
  tokenId?: number;
  editionId?: number;
};

function resolveSortColumn(sort: string | undefined, table: string) {
  const key = sort?.toLowerCase() ?? DEFAULT_TDH_EDITION_SORT;
  const column =
    TDH_EDITION_SORT_MAP[key] ?? TDH_EDITION_SORT_MAP[DEFAULT_TDH_EDITION_SORT];
  return `${table}.${column}`;
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
  sort: string | undefined,
  sortDir: string,
  page: number,
  pageSize: number,
  options: TdhEditionFilters
) {
  const params: Record<string, any> = { wallet: wallet.toLowerCase() };
  let filters = constructFilters('', `${TDH_EDITIONS_TABLE}.wallet = :wallet`);
  filters = applyEditionFilters(TDH_EDITIONS_TABLE, filters, params, options);

  return fetchPaginated(
    TDH_EDITIONS_TABLE,
    params,
    `${resolveSortColumn(sort, TDH_EDITIONS_TABLE)} ${sortDir}`,
    pageSize,
    page,
    filters
  );
}

export async function fetchConsolidatedTdhEditions(
  consolidationKey: string,
  sort: string | undefined,
  sortDir: string,
  page: number,
  pageSize: number,
  options: TdhEditionFilters
) {
  const params: Record<string, any> = {
    consolidationKey: consolidationKey.toLowerCase()
  };
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
    `${resolveSortColumn(sort, CONSOLIDATED_TDH_EDITIONS_TABLE)} ${sortDir}`,
    pageSize,
    page,
    filters
  );
}

export enum IdentityFilterType {
  PROFILE_ID = 'PROFILE_ID',
  HANDLE = 'HANDLE'
}

export async function fetchIdentityTdhEditions(
  identity: string,
  filterType: IdentityFilterType,
  sort: string | undefined,
  sortDir: string,
  page: number,
  pageSize: number,
  options: TdhEditionFilters
) {
  const params: Record<string, any> = {};
  let filters = '';

  switch (filterType) {
    case IdentityFilterType.PROFILE_ID:
      params.identity = identity;
      filters = constructFilters(
        filters,
        `${IDENTITIES_TABLE}.profile_id = :identity`
      );
      break;
    case IdentityFilterType.HANDLE:
      params.identity = identity.toLowerCase();
      filters = constructFilters(
        filters,
        `${IDENTITIES_TABLE}.normalised_handle = :identity`
      );
      break;
  }

  filters = applyEditionFilters(
    CONSOLIDATED_TDH_EDITIONS_TABLE,
    filters,
    params,
    options
  );

  const joins = ` INNER JOIN ${IDENTITIES_TABLE} ON ${IDENTITIES_TABLE}.consolidation_key = ${CONSOLIDATED_TDH_EDITIONS_TABLE}.consolidation_key`;
  const fields = `
    ${CONSOLIDATED_TDH_EDITIONS_TABLE}.*,
    ${IDENTITIES_TABLE}.profile_id as identity_id,
    ${IDENTITIES_TABLE}.handle as identity_handle,
    ${IDENTITIES_TABLE}.normalised_handle as identity_normalised_handle
  `;

  return fetchPaginated(
    CONSOLIDATED_TDH_EDITIONS_TABLE,
    params,
    `${resolveSortColumn(sort, CONSOLIDATED_TDH_EDITIONS_TABLE)} ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins
  );
}
