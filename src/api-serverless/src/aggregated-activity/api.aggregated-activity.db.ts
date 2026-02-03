import { constructFilters, constructFiltersOR } from '../api-helpers';
import {
  AGGREGATED_ACTIVITY_MEMES_TABLE,
  AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  MANIFOLD
} from '@/constants';
import { fetchPaginated } from '../../../db-api';
import { calculateLevel } from '../../../profiles/profile-level';
import { MetricsCollector, MetricsContent } from '../tdh/api.tdh.db';
import { sqlExecutor } from '../../../sql-executor';
import { ApiAggregatedActivity } from '../generated/models/ApiAggregatedActivity';
import { ApiAggregatedActivityMemes } from '../generated/models/ApiAggregatedActivityMemes';
import { ApiAggregatedActivityPage } from '../generated/models/ApiAggregatedActivityPage';

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
        `${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key like :search${index}
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
        return constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.balance > 0`
        );
      } else {
        return constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memes_balance > 0`
        );
      }
    case MetricsCollector.MEMES_SETS:
      if (season) {
        return constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.sets > 0`
        );
      } else {
        return constructFilters(
          filters,
          `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memes_cards_sets > 0`
        );
      }
    case MetricsCollector.GENESIS:
      return constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.genesis > 0`
      );
    case MetricsCollector.GRADIENTS:
      return constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.gradients_balance > 0`
      );
    case MetricsCollector.MEMELAB:
      return constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.memelab_balance > 0`
      );
    case MetricsCollector.NEXTGEN:
      return constructFilters(
        filters,
        `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.nextgen_balance > 0`
      );
    default:
      return filters;
  }
}

export const fetchAggregatedActivity = async (
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
): Promise<ApiAggregatedActivityPage> => {
  let filters = constructFilters(
    '',
    `${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key != :manifold`
  );
  let params: any = {
    manifold: MANIFOLD
  };

  if (query.search) {
    const { walletFilters, searchParams } = getSearchFilters(query.search);
    filters = constructFilters(filters, `(${walletFilters})`);
    params = {
      ...params,
      ...searchParams
    };
  }

  let primaryPurchasesCount = 'primary_purchases_count';
  let primaryPurchasesValue = 'primary_purchases_value';
  let secondaryPurchasesCount = 'secondary_purchases_count';
  let secondaryPurchasesValue = 'secondary_purchases_value';
  let salesCount = 'sales_count';
  let salesValue = 'sales_value';
  let transfersIn = 'transfers_in';
  let transfersOut = 'transfers_out';
  let airdrops = 'airdrops';
  let burns = 'burns';
  let activityTable = CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE;

  switch (query.content) {
    case MetricsContent.MEMES:
      if (query.season) {
        activityTable = CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE;
      } else {
        primaryPurchasesCount += '_memes';
        primaryPurchasesValue += '_memes';
        secondaryPurchasesCount += '_memes';
        secondaryPurchasesValue += '_memes';
        salesCount += '_memes';
        salesValue += '_memes';
        transfersIn += '_memes';
        transfersOut += '_memes';
        airdrops += '_memes';
        burns += '_memes';
      }
      break;
    case MetricsContent.GRADIENTS:
      primaryPurchasesCount += '_gradients';
      primaryPurchasesValue += '_gradients';
      secondaryPurchasesCount += '_gradients';
      secondaryPurchasesValue += '_gradients';
      salesCount += '_gradients';
      salesValue += '_gradients';
      transfersIn += '_gradients';
      transfersOut += '_gradients';
      airdrops += '_gradients';
      burns += '_gradients';
      break;
    case MetricsContent.MEMELAB:
      primaryPurchasesCount += '_memelab';
      primaryPurchasesValue += '_memelab';
      secondaryPurchasesCount += '_memelab';
      secondaryPurchasesValue += '_memelab';
      salesCount += '_memelab';
      salesValue += '_memelab';
      transfersIn += '_memelab';
      transfersOut += '_memelab';
      airdrops += '_memelab';
      burns += '_memelab';
      break;
    case MetricsContent.NEXTGEN:
      primaryPurchasesCount += '_nextgen';
      primaryPurchasesValue += '_nextgen';
      secondaryPurchasesCount += '_nextgen';
      secondaryPurchasesValue += '_nextgen';
      salesCount += '_nextgen';
      salesValue += '_nextgen';
      transfersIn += '_nextgen';
      transfersOut += '_nextgen';
      airdrops += '_nextgen';
      burns += '_nextgen';
      break;
  }

  if (query.collector) {
    filters = getCollectorFilters(query.collector, query.season, filters);
  }

  const activityFields = `
    ${activityTable}.consolidation_key as consolidation_key,
    ${activityTable}.${primaryPurchasesCount} as primary_purchases_count,
    ${activityTable}.${primaryPurchasesValue} as primary_purchases_value,
    ${activityTable}.${secondaryPurchasesCount} as secondary_purchases_count,
    ${activityTable}.${secondaryPurchasesValue} as secondary_purchases_value,
    ${activityTable}.${salesCount} as sales_count,
    ${activityTable}.${salesValue} as sales_value,
    ${activityTable}.${transfersIn} as transfers_in,
    ${activityTable}.${transfersOut} as transfers_out,
    ${activityTable}.${airdrops} as airdrops,
    ${activityTable}.${burns} as burns`;

  const fields = `${activityFields}, 
    ${IDENTITIES_TABLE}.handle,
    ${IDENTITIES_TABLE}.pfp as pfp_url,
    ${IDENTITIES_TABLE}.rep as rep_score,
    ${IDENTITIES_TABLE}.cic as cic_score,
    ${IDENTITIES_TABLE}.primary_address as primary_wallet,
    ${IDENTITIES_TABLE}.xtdh as xtdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as boosted_tdh,
    ${IDENTITIES_TABLE}.level_raw as level`;

  let joins = ` LEFT JOIN ${IDENTITIES_TABLE} on ${IDENTITIES_TABLE}.consolidation_key = ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;
  if (query.collector) {
    joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key`;
    if (query.season) {
      joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.season = ${query.season}`;
    }
  }
  if (
    (query.content == MetricsContent.MEMES ||
      query.collector == MetricsCollector.MEMES ||
      query.collector == MetricsCollector.MEMES_SETS) &&
    query.season
  ) {
    joins += ` LEFT JOIN ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE}.season = ${query.season}`;
  }

  const results = await fetchPaginated<ApiAggregatedActivity>(
    CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
    params,
    `${sort} ${sortDir}, ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key ${sortDir}`,
    pageSize,
    page,
    filters,
    fields,
    joins,
    ''
  );

  results.data.forEach((d: any) => {
    d.level = calculateLevel({
      tdh: (d.boosted_tdh ?? 0) + (d.xtdh ?? 0),
      rep: d.rep_score
    });
  });
  return results;
};

export const fetchAggregatedActivityForConsolidationKey = async (
  key: string
): Promise<ApiAggregatedActivity | null> => {
  return fetchSingleAggregatedActivity<ApiAggregatedActivity>(
    'consolidation_key',
    key,
    CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE
  );
};

export const fetchMemesAggregatedActivityForConsolidationKey = async (
  key: string
): Promise<ApiAggregatedActivityMemes[]> => {
  return fetchMemesAggregatedActivity<ApiAggregatedActivityMemes>(
    'consolidation_key',
    key,
    CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE
  );
};

export async function fetchAggregatedActivityForWallet(wallet: string) {
  return fetchSingleAggregatedActivity<ApiAggregatedActivity>(
    'wallet',
    wallet,
    AGGREGATED_ACTIVITY_TABLE
  );
}

export async function fetchMemesAggregatedActivityForWallet(wallet: string) {
  return fetchMemesAggregatedActivity<ApiAggregatedActivityMemes>(
    'wallet',
    wallet,
    AGGREGATED_ACTIVITY_MEMES_TABLE
  );
}

async function fetchSingleAggregatedActivity<T>(
  key: 'wallet' | 'consolidation_key',
  value: string,
  table: string
): Promise<T | null> {
  const sql = `
    SELECT * from ${table} where ${key} = :value
    `;
  const result = await sqlExecutor.execute(sql, { value });
  if (result.length !== 1) {
    return null;
  }
  return result[0];
}

async function fetchMemesAggregatedActivity<T>(
  key: string,
  value: string,
  table: string
): Promise<T[]> {
  const sql = `
    SELECT * from ${table} where ${key} = :value
    `;
  return await sqlExecutor.execute<T>(sql, { value });
}
