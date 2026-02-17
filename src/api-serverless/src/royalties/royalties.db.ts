import { constructFilters } from '../api-helpers';
import {
  ACK_DEPLOYER,
  MANIFOLD,
  MEME_LAB_ROYALTIES_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_ROYALTIES_RATE,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { Time } from '../../../time';
import { sqlExecutor } from '../../../sql-executor';
import * as mysql from 'mysql';

export interface RoyaltyResponse {
  token_id: number;
  contract: string;
  name: string;
  artist: string;
  thumbnail?: string;
  volume: number;
  proceeds: number;
  artist_split: number;
  artist_take: number;
}

export function getRoyaltiesSql(
  type: 'memes' | 'memelab',
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number | undefined,
  toBlock: number | undefined
) {
  const nftsTable = type === 'memes' ? NFTS_TABLE : NFTS_MEME_LAB_TABLE;
  const contract = type === 'memes' ? MEMES_CONTRACT : MEMELAB_CONTRACT;
  const primaryRoyaltySplitSource =
    type === 'memes'
      ? MEMES_ROYALTIES_RATE
      : `${MEME_LAB_ROYALTIES_TABLE}.primary_royalty_split`;
  const secondaryRoyaltySplitSource =
    type === 'memes'
      ? MEMES_ROYALTIES_RATE
      : `${MEME_LAB_ROYALTIES_TABLE}.secondary_royalty_split`;

  let filters = constructFilters(
    '',
    `${TRANSACTIONS_TABLE}.contract=:contract`
  );
  const params: any = {
    contract: contract,
    no_royalty_artist: '%6529%',
    null_address: NULL_ADDRESS,
    manifold: MANIFOLD,
    ack_deployer: ACK_DEPLOYER
  };

  filters = constructFilters(filters, `${TRANSACTIONS_TABLE}.value > 0`);

  let nftFilters = constructFilters('', `${nftsTable}.contract=:contract`);
  if (artist) {
    nftFilters = constructFilters(
      nftFilters,
      `${nftsTable}.artist REGEXP :artist`
    );
    params.artist = `(^|,| and )${artist}($|,| and )`;
  }

  if (fromDate) {
    filters = constructFilters(
      filters,
      `${TRANSACTIONS_TABLE}.transaction_date >= :from_date`
    );
    params.from_date = fromDate;
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    filters = constructFilters(
      filters,
      `${TRANSACTIONS_TABLE}.transaction_date < :to_date`
    );
    params.to_date = nextDay;
  }
  if (fromBlock) {
    filters = constructFilters(
      filters,
      `${TRANSACTIONS_TABLE}.block >= :from_block`
    );
    params.from_block = fromBlock;
  }
  if (toBlock) {
    filters = constructFilters(
      filters,
      `${TRANSACTIONS_TABLE}.block <= :to_block`
    );
    params.to_block = toBlock;
  }

  const royaltiesJoinClause =
    type === 'memelab'
      ? `LEFT JOIN ${MEME_LAB_ROYALTIES_TABLE} ON ${nftsTable}.id = ${MEME_LAB_ROYALTIES_TABLE}.token_id`
      : '';

  const specialCasePrimary =
    type === 'memelab'
      ? `OR (from_address = :ack_deployer AND token_id = 12)`
      : '';
  const specialCaseSecondary =
    type === 'memelab'
      ? `AND NOT (from_address = :ack_deployer AND token_id = 12)`
      : '';

  let selectClause = `
    SELECT 
      ${nftsTable}.id as token_id, 
      ${nftsTable}.contract, 
      ${nftsTable}.name, 
      ${nftsTable}.artist, 
      ${nftsTable}.icon as thumbnail`;

  const cases = `
    CASE WHEN 
    (artist not like :no_royalty_artist OR (contract = ${mysql.escape(
      MEMES_CONTRACT
    )} AND ${nftsTable}.id = 19))
    AND (contract != ${mysql.escape(
      MEMES_CONTRACT
    )} OR (contract = ${mysql.escape(
      MEMES_CONTRACT
    )} AND ${nftsTable}.id != 100))
  `;

  let joinClause = '';
  if (isPrimary) {
    selectClause += `,
      COALESCE(primaryVolume.primary_total_volume, 0) as volume,
      COALESCE(primaryVolume.primary_total_proceeds, 0) as proceeds,
      ${cases} THEN ${primaryRoyaltySplitSource} ELSE 0 END as artist_split,
      COALESCE(primaryVolume.primary_total_proceeds, 0) * ${cases} THEN ${primaryRoyaltySplitSource} ELSE 0 END AS artist_take`;

    joinClause = `LEFT JOIN 
      (SELECT 
        token_id, 
        SUM(CASE WHEN from_address IN (:null_address, :manifold) ${specialCasePrimary} THEN value ELSE 0 END) AS primary_total_volume,
        SUM(CASE WHEN from_address IN (:null_address, :manifold) ${specialCasePrimary} THEN primary_proceeds ELSE 0 END) AS primary_total_proceeds
      FROM 
        ${TRANSACTIONS_TABLE}
      ${filters}
      GROUP BY 
        token_id) AS primaryVolume
      ON ${nftsTable}.id = primaryVolume.token_id`;
  } else {
    selectClause += `,
      COALESCE(aggregated.secondary_total_volume, 0) as volume,
      COALESCE(aggregated.total_royalties, 0) as proceeds,
      ${cases} THEN ${secondaryRoyaltySplitSource} ELSE 0 END as artist_split,
      COALESCE(aggregated.total_royalties, 0) * ${cases} THEN ${secondaryRoyaltySplitSource} ELSE 0 END AS artist_take`;

    joinClause = `LEFT JOIN 
      (SELECT 
        token_id,
        SUM(CASE WHEN from_address NOT IN (:null_address, :manifold) ${specialCaseSecondary} THEN value ELSE 0 END) AS secondary_total_volume,
        SUM(CASE WHEN from_address NOT IN (:null_address, :manifold) ${specialCaseSecondary} THEN royalties ELSE 0 END) AS total_royalties
      FROM 
        ${TRANSACTIONS_TABLE}
      ${filters}
      GROUP BY 
        token_id) AS aggregated
      ON ${nftsTable}.id = aggregated.token_id`;
  }

  const sql = `
    ${selectClause}
    FROM 
      ${nftsTable} 
    ${joinClause}
    ${royaltiesJoinClause}
    ${nftFilters}
    ORDER BY 
      ${nftsTable}.id ASC;`;

  return {
    sql,
    params
  };
}

export async function fetchRoyalties(
  type: 'memes' | 'memelab',
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number | undefined,
  toBlock: number | undefined
): Promise<RoyaltyResponse[]> {
  const sql = getRoyaltiesSql(
    type,
    isPrimary,
    artist,
    fromDate,
    toDate,
    fromBlock,
    toBlock
  );
  return sqlExecutor.execute(sql.sql, sql.params);
}
