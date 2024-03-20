import { constructFilters, constructFiltersOR } from '../api-helpers';
import {
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MANIFOLD,
  PROFILE_FULL
} from '../../../constants';
import { fetchPaginated } from '../../../db-api';
import { calculateLevel } from '../../../profiles/profile-level';
import { MetricsCollector, MetricsContent } from 'src/tdh/tdh.db';
import { sqlExecutor } from '../../../sql-executor';

export const fetchAggregatedActivity = async (
  sort: string,
  sortDir: string,
  page: number,
  pageSize: number,
  searchStr: string,
  content: MetricsContent,
  collector: MetricsCollector,
  season: number
) => {
  let filters = constructFilters(
    '',
    `${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key != :manifold`
  );
  const params: any = {
    manifold: MANIFOLD
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
          `${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key like :search${index}
          or ${PROFILE_FULL}.handle like :search${index}
          or ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display like :search${index}`
        );
      });

    filters = constructFilters(filters, `(${walletFilters})`);
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

  switch (content) {
    case MetricsContent.MEMES:
      if (season) {
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
    ${PROFILE_FULL}.handle,
    ${PROFILE_FULL}.pfp_url,
    ${PROFILE_FULL}.rep_score,
    ${PROFILE_FULL}.cic_score,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_display as consolidation_display,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh as boosted_tdh,
    (${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh + ${PROFILE_FULL}.rep_score) as level`;

  let joins = ` LEFT JOIN ${PROFILE_FULL} on ${PROFILE_FULL}.consolidation_key = ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key`;
  joins += ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;
  if (collector) {
    joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key`;
    if (season) {
      joins += ` LEFT JOIN ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE}.season = ${season}`;
    }
  }
  if (
    (content == MetricsContent.MEMES ||
      collector == MetricsCollector.MEMES ||
      collector == MetricsCollector.MEMES_SETS) &&
    season
  ) {
    joins += ` LEFT JOIN ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE} ON ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE}.consolidation_key = ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE}.consolidation_key and ${CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE}.season = ${season}`;
  }

  const results = await fetchPaginated(
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
      tdh: d.boosted_tdh ?? 0,
      rep: d.rep_score
    });
  });
  return results;
};

export const fetchAggregatedActivityForKey = async (key: string) => {
  const sql = `
    SELECT * from ${CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE} where consolidation_key = :key
    `;
  const result = await sqlExecutor.execute(sql, { key });
  if (result.length !== 1) {
    return null;
  }
  return result[0];
};
