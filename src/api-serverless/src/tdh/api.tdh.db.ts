import { constructFilters, constructFiltersOR } from '../api-helpers';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  LATEST_TDH_HISTORY_TABLE,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFT_OWNERS_CONSOLIDATION_TABLE,
  NULL_ADDRESS,
  TDH_NFT_TABLE
} from '@/constants';
import { fetchPaginated } from '../../../db-api';
import {
  calculateLevel,
  getLevelFromScore
} from '../../../profiles/profile-level';
import { sqlExecutor } from '../../../sql-executor';

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
  const params: any = {
    contract: contract.toLowerCase(),
    nftId,
    nullAddress: NULL_ADDRESS,
    memesContract: MEMES_CONTRACT
  };
  let filters = constructFilters(
    '',
    `${NFT_OWNERS_CONSOLIDATION_TABLE}.contract = :contract`
  );
  filters = constructFilters(
    filters,
    `${NFT_OWNERS_CONSOLIDATION_TABLE}.token_id = :nftId`
  );

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
          or ${IDENTITIES_TABLE}.handle like :search${index}
          or ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display like :search${index}`
        );
      });

    filters = constructFilters(filters, `(${walletFilters})`);
  }

  const fields = `
    ${NFT_OWNERS_CONSOLIDATION_TABLE}.token_id,
    ${NFT_OWNERS_CONSOLIDATION_TABLE}.contract,
    CASE 
      WHEN 
        ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key = :nullAddress 
        AND ${NFT_OWNERS_CONSOLIDATION_TABLE}.contract = :memesContract
      THEN ${NFT_OWNERS_CONSOLIDATION_TABLE}.balance + ${MEME_8_EDITION_BURN_ADJUSTMENT} 
      ELSE ${NFT_OWNERS_CONSOLIDATION_TABLE}.balance END as balance,
    ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key,
    ${TDH_NFT_TABLE}.tdh, 
    ${TDH_NFT_TABLE}.boost, 
    ${TDH_NFT_TABLE}.boosted_tdh, 
    ${TDH_NFT_TABLE}.tdh__raw, 
    ${TDH_NFT_TABLE}.tdh_rank, 
    ${IDENTITIES_TABLE}.handle,
    ${IDENTITIES_TABLE}.pfp as pfp_url,
    ${IDENTITIES_TABLE}.rep as rep_score,
    ${IDENTITIES_TABLE}.cic as cic_score,
    ${IDENTITIES_TABLE}.primary_address as primary_wallet,
    ${IDENTITIES_TABLE}.xtdh as xtdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.balance as total_balance, 
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh as total_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.tdh__raw as total_tdh__raw,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as total_boosted_tdh`;
  let joins = ` LEFT JOIN ${TDH_NFT_TABLE} on ${TDH_NFT_TABLE}.consolidation_key = ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key AND ${TDH_NFT_TABLE}.contract = ${NFT_OWNERS_CONSOLIDATION_TABLE}.contract AND ${TDH_NFT_TABLE}.id = ${NFT_OWNERS_CONSOLIDATION_TABLE}.token_id`;
  joins += ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${NFT_OWNERS_CONSOLIDATION_TABLE}.consolidation_key`;
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
      tdh: d.total_boosted_tdh ?? 0 + (d.xtdh ?? 0),
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
          or ${IDENTITIES_TABLE}.handle like :search${index}
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
  let tdhField = `${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as boosted_tdh`;

  switch (query.content) {
    case MetricsContent.MEMES:
      if (query.season) {
        balancesTable = CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE;
        balanceColumn = 'balance';
        uniqueMemesColumn = 'unique';
        memeCardSetsColumn = 'sets';
        tdhField = `${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}.boosted_tdh as boosted_tdh`;
      } else {
        balanceColumn = 'memes_balance';
        tdhField = `${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh as boosted_tdh`;
      }
      break;
    case MetricsContent.GRADIENTS:
      balanceColumn = 'gradients_balance';
      tdhField = `${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh as boosted_tdh`;
      break;
    case MetricsContent.MEMELAB:
      balanceColumn = 'memelab_balance';
      tdhField = '0 as boosted_tdh';
      break;
    case MetricsContent.NEXTGEN:
      balanceColumn = 'nextgen_balance';
      tdhField = `${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_nextgen_tdh as boosted_tdh`;
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
    ${IDENTITIES_TABLE}.handle,
    ${IDENTITIES_TABLE}.pfp as pfp_url,
    ${IDENTITIES_TABLE}.rep as rep_score,
    ${IDENTITIES_TABLE}.cic as cic_score,
    ${IDENTITIES_TABLE}.primary_address as primary_wallet,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as total_tdh,
    ${tdhField},
    ${IDENTITIES_TABLE}.level_raw as level,
    COALESCE(${LATEST_TDH_HISTORY_TABLE}.net_boosted_tdh, 0) as day_change`;

  let joins = ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${LATEST_TDH_HISTORY_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key=${LATEST_TDH_HISTORY_TABLE}.consolidation_key`;

  const isMemesSeason =
    (query.content == MetricsContent.MEMES ||
      query.collector == MetricsCollector.MEMES ||
      query.collector == MetricsCollector.MEMES_SETS) &&
    query.season;

  if (isMemesSeason) {
    joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.season = ${query.season}`;
    joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE} ON ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}.season = ${query.season}`;
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
    d.level = getLevelFromScore(d.level);
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
