import { ARTISTS_TABLE, MEMES_MINT_STATS_TABLE } from '@/constants';
import type { PaginatedResponse } from '@/api/api-constants';
import { fetchPaginated } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';
import { ApiMemesMintStatsTotals } from '@/api/generated/models/ApiMemesMintStatsTotals';
import { ApiMemesMintStatsYearly } from '@/api/generated/models/ApiMemesMintStatsYearly';
import type { ApiMemesMintStatRow } from '@/api/memes-mint-stats/api.memes-mint-stats.mappers';

const MEMES_MINT_STATS_TABLE_ALIAS = 'mms';

const MEMES_MINT_STATS_FIELDS = `
  ${MEMES_MINT_STATS_TABLE_ALIAS}.id,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.mint_date,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.mint_count AS total_count,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.direct_mint_count AS mint_count,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.subscriptions_count,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_eth,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_usd,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_eth,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_usd,
  ${MEMES_MINT_STATS_TABLE_ALIAS}.payment_details
`;

export async function fetchMemesMintStats(
  page: number,
  pageSize: number,
  sortDir: 'ASC' | 'DESC'
): Promise<PaginatedResponse<ApiMemesMintStatRow>> {
  return fetchPaginated<ApiMemesMintStatRow>(
    `${MEMES_MINT_STATS_TABLE} ${MEMES_MINT_STATS_TABLE_ALIAS}`,
    {},
    `${MEMES_MINT_STATS_TABLE_ALIAS}.id ${sortDir}`,
    pageSize,
    page,
    '',
    MEMES_MINT_STATS_FIELDS,
    '',
    undefined,
    { skipJoinsOnCountQuery: true }
  );
}

export async function fetchMemesMintStatById(
  id: number
): Promise<ApiMemesMintStatRow | null> {
  return sqlExecutor.oneOrNull<ApiMemesMintStatRow>(
    `SELECT
      ${MEMES_MINT_STATS_FIELDS}
    FROM ${MEMES_MINT_STATS_TABLE} ${MEMES_MINT_STATS_TABLE_ALIAS}
    WHERE ${MEMES_MINT_STATS_TABLE_ALIAS}.id = :id
    LIMIT 1`,
    { id }
  );
}

export async function fetchMemesMintStatsTotals(): Promise<ApiMemesMintStatsTotals> {
  const result = await sqlExecutor.oneOrNull<ApiMemesMintStatsTotals>(
    `SELECT
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.mint_count), 0) AS total_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.direct_mint_count), 0) AS mint_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.subscriptions_count), 0) AS subscriptions_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_eth), 0) AS proceeds_eth,
      ROUND(COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_usd), 0), 2) AS proceeds_usd,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_eth), 0) AS artist_split_eth,
      ROUND(COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_usd), 0), 2) AS artist_split_usd,
      (SELECT COUNT(1) FROM ${ARTISTS_TABLE}) AS artists_count
    FROM ${MEMES_MINT_STATS_TABLE} ${MEMES_MINT_STATS_TABLE_ALIAS}`
  );

  return (
    result ?? {
      total_count: 0,
      mint_count: 0,
      subscriptions_count: 0,
      proceeds_eth: 0,
      proceeds_usd: 0,
      artist_split_eth: 0,
      artist_split_usd: 0,
      artists_count: 0
    }
  );
}

export async function fetchMemesMintStatsYearly(): Promise<
  ApiMemesMintStatsYearly[]
> {
  return sqlExecutor.execute<ApiMemesMintStatsYearly>(
    `SELECT
      YEAR(${MEMES_MINT_STATS_TABLE_ALIAS}.mint_date) AS year,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.mint_count), 0) AS total_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.direct_mint_count), 0) AS mint_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.subscriptions_count), 0) AS subscriptions_count,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_eth), 0) AS proceeds_eth,
      ROUND(COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.proceeds_usd), 0), 2) AS proceeds_usd,
      COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_eth), 0) AS artist_split_eth,
      ROUND(COALESCE(SUM(${MEMES_MINT_STATS_TABLE_ALIAS}.artist_split_usd), 0), 2) AS artist_split_usd
    FROM ${MEMES_MINT_STATS_TABLE} ${MEMES_MINT_STATS_TABLE_ALIAS}
    WHERE ${MEMES_MINT_STATS_TABLE_ALIAS}.mint_date IS NOT NULL
    GROUP BY YEAR(${MEMES_MINT_STATS_TABLE_ALIAS}.mint_date)
    ORDER BY YEAR(${MEMES_MINT_STATS_TABLE_ALIAS}.mint_date) ASC`
  );
}
