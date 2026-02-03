import { constructFilters } from '../api-helpers';
import {
  ACK_DEPLOYER,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { Time } from '../../../time';
import { sqlExecutor } from '../../../sql-executor';

export interface GasResponse {
  token_id: number;
  contract: string;
  name: string;
  artist: string;
  thumbnail?: string;
  gas: number;
}

function getGasSql(
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

  const transactionsAlias = 'distinct_transactions';
  let filters = constructFilters(
    '',
    `${transactionsAlias}.contract = :contract`
  );

  const params: any = {
    contract: contract,
    null_address: NULL_ADDRESS,
    manifold: MANIFOLD,
    ack_deployer: ACK_DEPLOYER
  };

  if (fromDate) {
    filters = constructFilters(
      filters,
      `${transactionsAlias}.transaction_date >= :from_date`
    );
    params.from_date = fromDate;
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    filters = constructFilters(
      filters,
      `${transactionsAlias}.transaction_date < :to_date`
    );
    params.to_date = nextDay;
  }
  if (fromBlock) {
    filters = constructFilters(
      filters,
      `${transactionsAlias}.block >= :from_block`
    );
    params.from_block = fromBlock;
  }
  if (toBlock) {
    filters = constructFilters(
      filters,
      `${transactionsAlias}.block <= :to_block`
    );
    params.to_block = toBlock;
  }

  let nftFilters = constructFilters('', `${nftsTable}.contract = :contract`);
  if (artist) {
    nftFilters = constructFilters(
      nftFilters,
      `${nftsTable}.artist REGEXP :artist`
    );
    params.artist = `(^|,| and )${artist}($|,| and )`;
  }

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
      ${nftsTable}.thumbnail`;

  let joinClause: string;
  if (isPrimary) {
    selectClause += `,
      COALESCE(primary_gas.primary_gas, 0) as gas`;

    joinClause = `LEFT JOIN
      (SELECT
        token_id,
        SUM(CASE
            WHEN from_address = :null_address OR from_address = :manifold ${specialCasePrimary}
            THEN gas
            ELSE 0
            END) AS primary_gas
      FROM
        (SELECT DISTINCT transaction, token_id, contract, gas, from_address FROM ${TRANSACTIONS_TABLE}) AS ${transactionsAlias}
      ${filters}
      GROUP BY token_id) AS primary_gas
      ON ${nftsTable}.id = primary_gas.token_id`;
  } else {
    selectClause += `,
      COALESCE(secondary_gas.secondary_gas, 0) as gas`;

    joinClause = `LEFT JOIN
      (SELECT
        token_id,
        SUM(CASE
            WHEN from_address != :null_address AND from_address != :manifold ${specialCaseSecondary}
            THEN gas
            ELSE 0
            END) AS secondary_gas
      FROM
        (SELECT DISTINCT transaction, token_id, contract, gas, from_address, transaction_date, block FROM ${TRANSACTIONS_TABLE}) AS ${transactionsAlias}
      ${filters}
      GROUP BY token_id) AS secondary_gas
      ON ${nftsTable}.id = secondary_gas.token_id`;
  }

  const sql = `
    ${selectClause}
    FROM
      ${nftsTable}
    ${joinClause}
    ${nftFilters}
    ORDER BY ${nftsTable}.contract ASC, ${nftsTable}.id ASC;`;

  return {
    sql,
    params
  };
}

export async function fetchGas(
  type: 'memes' | 'memelab',
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number | undefined,
  toBlock: number | undefined
): Promise<GasResponse[]> {
  const sql = getGasSql(
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
