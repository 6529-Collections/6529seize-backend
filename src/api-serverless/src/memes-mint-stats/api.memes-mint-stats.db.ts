import { ARTISTS_TABLE, MEMES_MINT_STATS_TABLE } from '@/constants';
import { fetchPaginated } from '@/db-api';
import { sqlExecutor } from '@/sql-executor';
import { ApiMemesMintStat } from '@/api/generated/models/ApiMemesMintStat';
import { ApiMemesMintStatsPage } from '@/api/generated/models/ApiMemesMintStatsPage';
import { ApiMemesMintStatsTotals } from '@/api/generated/models/ApiMemesMintStatsTotals';
import { ApiMemesMintStatsYearly } from '@/api/generated/models/ApiMemesMintStatsYearly';

export async function fetchMemesMintStats(
  page: number,
  pageSize: number,
  sortDir: 'ASC' | 'DESC'
): Promise<ApiMemesMintStatsPage> {
  return fetchPaginated<ApiMemesMintStat>(
    MEMES_MINT_STATS_TABLE,
    {},
    `id ${sortDir}`,
    pageSize,
    page,
    ''
  );
}

export async function fetchMemesMintStatById(
  id: number
): Promise<ApiMemesMintStat | null> {
  return sqlExecutor.oneOrNull<ApiMemesMintStat>(
    `SELECT * FROM ${MEMES_MINT_STATS_TABLE} WHERE id = :id LIMIT 1`,
    { id }
  );
}

export async function fetchMemesMintStatsTotals(): Promise<ApiMemesMintStatsTotals> {
  const result = await sqlExecutor.oneOrNull<ApiMemesMintStatsTotals>(
    `SELECT
      COALESCE(SUM(mint_count), 0) AS mint_count,
      COALESCE(SUM(proceeds_eth), 0) AS proceeds_eth,
      ROUND(COALESCE(SUM(proceeds_usd), 0), 2) AS proceeds_usd,
      COALESCE(SUM(artist_split_eth), 0) AS artist_split_eth,
      ROUND(COALESCE(SUM(artist_split_usd), 0), 2) AS artist_split_usd,
      (SELECT COUNT(1) FROM ${ARTISTS_TABLE}) AS artists_count
    FROM ${MEMES_MINT_STATS_TABLE}`
  );

  return (
    result ?? {
      mint_count: 0,
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
      YEAR(mint_date) AS year,
      COALESCE(SUM(mint_count), 0) AS mint_count,
      COALESCE(SUM(proceeds_eth), 0) AS proceeds_eth,
      ROUND(COALESCE(SUM(proceeds_usd), 0), 2) AS proceeds_usd,
      COALESCE(SUM(artist_split_eth), 0) AS artist_split_eth,
      ROUND(COALESCE(SUM(artist_split_usd), 0), 2) AS artist_split_usd
    FROM ${MEMES_MINT_STATS_TABLE}
    WHERE mint_date IS NOT NULL
    GROUP BY YEAR(mint_date)
    ORDER BY YEAR(mint_date) ASC`
  );
}
