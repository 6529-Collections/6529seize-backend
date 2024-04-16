import { constructFilters, constructFiltersOR } from '../api-helpers';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_SEASONS_TABLE,
  NFT_OWNERS_CONSOLIDATION_TABLE,
  PROFILE_FULL,
  TDH_HISTORY_TABLE,
  TDH_NFT_TABLE
} from '../../../constants';
import { NftTDH } from '../../../entities/ITDH';
import { fetchPaginated } from '../../../db-api';
import { calculateLevel } from '../../../profiles/profile-level';
import { sqlExecutor } from '../../../sql-executor';

export interface NftTdhResponse extends NftTDH {
  total_balance: number;
  total_boosted_tdh: number;
}

export enum MetricsContent {
  MEMES = 'Memes',
  GRADIENTS = 'Gradient',
  MEMELAB = 'MemeLab',
  NEXTGEN = 'NextGen'
}

export enum MetricsCollector {
  ALL = 'All',
  MEMES = 'Memes',
  MEMES_SETS = 'Meme SZN Set',
  GENESIS = 'Genesis Set',
  GRADIENTS = 'Gradient',
  MEMELAB = 'MemeLab',
  NEXTGEN = 'NextGen'
}

export const fetchNftTdh = async (
  contract: string,
  nftId: number,
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  searchStr: string | undefined
) => {
  let filters = constructFilters(
    '',
    `${NFT_OWNERS_CONSOLIDATION_TABLE}.contract = :contract`
  );
  filters = constructFilters(
    filters,
    `${NFT_OWNERS_CONSOLIDATION_TABLE}.token_id = :nftId`
  );
  const params: any = {
    contract: contract.toLowerCase(),
    nftId
  };

  if (searchStr) {
    let walletFilters = '';
    searchStr
      .toLowerCase()
      .split(',')
      .forEach((s: string, index: number) => {
        params[`search${index}`] = `%${s}%`;
        walletFilters = constructFiltersOR(
          walletFilters,
          `${TDH_NFT_TABLE}.consolidation_key like :search${index}
          or ${PROFILE_FULL}.handle like :search${index}
          or ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display like :search${index}`
        );
      });

    filters = constructFilters(filters, `(${walletFilters})`);
  }

  const fields = `
    ${NFT_OWNERS_CONSOLIDATION_TABLE}.*,
    ${TDH_NFT_TABLE}.tdh, 
    ${TDH_NFT_TABLE}.boost, 
    ${TDH_NFT_TABLE}.boosted_tdh, 
    ${TDH_NFT_TABLE}.tdh__raw, 
    ${TDH_NFT_TABLE}.tdh_rank, 
    ${PROFILE_FULL}.handle,
    ${PROFILE_FULL}.pfp_url,
    ${PROFILE_FULL}.rep_score,
    ${PROFILE_FULL}.cic_score,
    ${PROFILE_FULL}.primary_wallet,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display, 
    ${NFT_OWNERS_CONSOLIDATION_TABLE}.balance as total_balance, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh as total_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw as total_tdh__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as total_boosted_tdh`;
  let joins = ` LEFT JOIN ${TDH_NFT_TABLE} on ${TDH_NFT_TABLE}.consolidation_key = ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key AND ${TDH_NFT_TABLE}.contract = ${NFT_OWNERS_CONSOLIDATION_TABLE}.contract AND ${TDH_NFT_TABLE}.id = ${NFT_OWNERS_CONSOLIDATION_TABLE}.token_id`;
  joins += ` LEFT JOIN ${PROFILE_FULL} on ${PROFILE_FULL}.consolidation_key = ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;

  const results = await fetchPaginated(
    NFT_OWNERS_CONSOLIDATION_TABLE,
    params,
    `${sort} ${sortDir}, ${TDH_NFT_TABLE}.boosted_tdh ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins,
    ''
  );
  results.data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: d.total_boosted_tdh ?? 0,
      rep: d.rep_score
    });
  });
  return results;
};

function getSearchFilters(search: string) {
  let walletFilters = '';
  const searchParams: any = {};
  search
    .toLowerCase()
    .split(',')
    .forEach((s: string, index: number) => {
      searchParams[`search${index}`] = `%${s}%`;
      walletFilters = constructFiltersOR(
        walletFilters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key like :search${index}
          or ${PROFILE_FULL}.handle like :search${index}
          or ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display like :search${index}`
      );
    });
  return { walletFilters, searchParams };
}

function getCollectorFilters(
  collector: MetricsCollector,
  season: number | undefined,
  filters: string
) {
  switch (collector) {
    case MetricsCollector.MEMES:
      if (season) {
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.balance > 0`
        );
      } else {
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memes_balance > 0`
        );
      }
      break;
    case MetricsCollector.MEMES_SETS:
      if (season) {
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.sets > 0`
        );
      } else {
        filters = constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memes_cards_sets > 0`
        );
      }
      break;
    case MetricsCollector.GENESIS:
      filters = constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.genesis > 0`
      );
      break;
    case MetricsCollector.GRADIENTS:
      filters = constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.gradients_balance > 0`
      );
      break;
    case MetricsCollector.MEMELAB:
      filters = constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memelab_balance > 0`
      );
      break;
    case MetricsCollector.NEXTGEN:
      filters = constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.nextgen_balance > 0`
      );
      break;
  }
  return filters;
}

export const fetchConsolidatedMetrics = async (
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  query: {
    search: string | undefined;
    content: MetricsContent | undefined;
    collector: MetricsCollector | undefined;
    season: number | undefined;
  }
) => {
  let filters = '';
  let params: any = {};

  if (query.search) {
    const { walletFilters, searchParams } = getSearchFilters(query.search);
    filters = constructFilters(filters, `(${walletFilters})`);
    params = {
      ...params,
      ...searchParams
    };
  }

  let balanceColumn = 'total_balance';
  let uniqueMemesColumn = 'unique_memes';
  let memeCardSetsColumn = 'memes_cards_sets';
  let balancesTable = CONSOLIDATED_OWNERS_BALANCES_TABLE;
  switch (query.content) {
    case MetricsContent.MEMES:
      if (query.season) {
        balancesTable = CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE;
        balanceColumn = 'balance';
        uniqueMemesColumn = 'unique';
        memeCardSetsColumn = 'sets';
      } else {
        balanceColumn = 'memes_balance';
      }
      break;
    case MetricsContent.GRADIENTS:
      balanceColumn = 'gradients_balance';
      break;
    case MetricsContent.MEMELAB:
      balanceColumn = 'memelab_balance';
      break;
    case MetricsContent.NEXTGEN:
      balanceColumn = 'nextgen_balance';
      break;
  }

  if (query.collector) {
    filters = getCollectorFilters(query.collector, query.season, filters);
  }

  const balancesTableField = `
    ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key as consolidation_key,
    ${balancesTable}.${balanceColumn} as balance,
    ${balancesTable}.${uniqueMemesColumn} as unique_memes,
    ${balancesTable}.${memeCardSetsColumn} as memes_cards_sets`;

  const fields = `${balancesTableField}, 
    ${PROFILE_FULL}.handle,
    ${PROFILE_FULL}.pfp_url,
    ${PROFILE_FULL}.rep_score,
    ${PROFILE_FULL}.cic_score,
    ${PROFILE_FULL}.primary_wallet,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as boosted_tdh,
    (${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh + ${PROFILE_FULL}.rep_score) as level,
    COALESCE(${TDH_HISTORY_TABLE}.net_boosted_tdh, 0) as day_change`;

  let joins = ` LEFT JOIN ${PROFILE_FULL} on ${PROFILE_FULL}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${TDH_HISTORY_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${TDH_HISTORY_TABLE}.consolidation_key and ${CONSOLIDATED_WALLETS_TDH_TABLE}.block=${TDH_HISTORY_TABLE}.block`;

  const isMemesSeason =
    (query.content == MetricsContent.MEMES ||
      query.collector == MetricsCollector.MEMES ||
      query.collector == MetricsCollector.MEMES_SETS) &&
    query.season;
  if (isMemesSeason) {
    joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.season = ${query.season}`;
  }

  const results = await fetchPaginated(
    CONSOLIDATED_OWNERS_BALANCES_TABLE,
    params,
    `${sort} ${sortDir}, ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.total_balance ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins,
    ''
  );

  const uniqueMemesTotal =
    (
      await sqlExecutor.execute(
        query.content == MetricsContent.MEMES && query.season
          ? `SELECT ${MEMES_SEASONS_TABLE}.count as total from ${MEMES_SEASONS_TABLE} where ${MEMES_SEASONS_TABLE}.id = :season`
          : `SELECT SUM(${MEMES_SEASONS_TABLE}.count) as total from ${MEMES_SEASONS_TABLE}`,
        { season: query.season }
      )
    )?.[0].total ?? 0;

  results.data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: d.boosted_tdh ?? 0,
      rep: d.rep_score
    });
    d.unique_memes_total = uniqueMemesTotal;
  });
  return results;
};

export const fetchTDH = async (key: string, value: string, table: string) => {
  const sql = `
    SELECT * from ${table} where ${key} = :value
    `;
  const result = await sqlExecutor.execute(sql, { value });
  if (result.length !== 1) {
    return null;
  }
  return result[0];
};

export const fetchSingleWalletTDH = async (wallet: string) => {
  const blockResult = await sqlExecutor.execute(
    `SELECT MAX(block) as block from ${CONSOLIDATED_WALLETS_TDH_TABLE}`
  );
  const block = blockResult[0].block ?? 0;
  const sql = `
    SELECT * from ${CONSOLIDATED_WALLETS_TDH_TABLE} where LOWER(consolidation_key) like '%${wallet.toLowerCase()}%'
  `;
  const tdh = await sqlExecutor.execute(sql);
  return {
    tdh: tdh[0]?.boosted_tdh ?? 0,
    block
  };
};
