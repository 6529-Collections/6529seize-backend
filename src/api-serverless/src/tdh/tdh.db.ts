import { constructFilters, constructFiltersOR } from '../api-helpers';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_SEASONS_TABLE,
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
  searchStr: string
) => {
  let filters = constructFilters('', `contract = :contract`);
  filters = constructFilters(filters, `id = :nftId`);
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

  const fields = `${TDH_NFT_TABLE}.*, 
    ${PROFILE_FULL}.handle,
    ${PROFILE_FULL}.pfp_url,
    ${PROFILE_FULL}.rep_score,
    ${PROFILE_FULL}.cic_score,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.balance as total_balance, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh as total_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw as total_tdh__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as total_boosted_tdh`;
  let joins = ` LEFT JOIN ${PROFILE_FULL} on ${PROFILE_FULL}.consolidation_key = ${TDH_NFT_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${TDH_NFT_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;

  const results = await fetchPaginated(
    TDH_NFT_TABLE,
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

export const fetchConsolidatedMetrics = async (
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  searchStr: string,
  content: MetricsContent,
  collector: MetricsCollector,
  season: number
) => {
  let filters = '';
  const params: any = {};

  if (searchStr) {
    let walletFilters = '';
    searchStr
      .toLowerCase()
      .split(',')
      .forEach((s: string, index: number) => {
        params[`search${index}`] = `%${s}%`;
        walletFilters = constructFiltersOR(
          walletFilters,
          `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key like :search${index}
          or ${PROFILE_FULL}.handle like :search${index}
          or ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display like :search${index}`
        );
      });

    filters = constructFilters(filters, `(${walletFilters})`);
  }

  let balanceColumn = 'total_balance';
  let uniqueMemesColumn = 'unique_memes';
  let memeCardSetsColumn = 'memes_cards_sets';
  let balancesTable = CONSOLIDATED_OWNERS_BALANCES_TABLE;
  switch (content) {
    case MetricsContent.MEMES:
      if (season) {
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
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as boosted_tdh,
    (${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh + ${PROFILE_FULL}.rep_score) as level,
    COALESCE(${TDH_HISTORY_TABLE}.net_boosted_tdh, 0) as day_change`;

  let joins = ` LEFT JOIN ${PROFILE_FULL} on ${PROFILE_FULL}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${TDH_HISTORY_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${TDH_HISTORY_TABLE}.consolidation_key and ${CONSOLIDATED_WALLETS_TDH_TABLE}.block=${TDH_HISTORY_TABLE}.block`;

  const isMemesSeason =
    (content == MetricsContent.MEMES ||
      collector == MetricsCollector.MEMES ||
      collector == MetricsCollector.MEMES_SETS) &&
    season;
  if (isMemesSeason) {
    joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.season = ${season}`;
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
        content == MetricsContent.MEMES && season
          ? `SELECT ${MEMES_SEASONS_TABLE}.count as total from ${MEMES_SEASONS_TABLE} where ${MEMES_SEASONS_TABLE}.id = :season`
          : `SELECT SUM(${MEMES_SEASONS_TABLE}.count) as total from ${MEMES_SEASONS_TABLE}`,
        { season }
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

export const fetchSingleTDH = async (
  key: string,
  value: string,
  table: string
) => {
  const sql = `
    SELECT * from ${table} where ${key} = :value
    `;
  const result = await sqlExecutor.execute(sql, { value });
  if (result.length !== 1) {
    return null;
  }
  return result[0];
};
