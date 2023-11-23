import { constructFilters } from '../api-helpers';
import {
  TRANSACTIONS_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NFTS_MEME_LAB_TABLE,
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  NULL_ADDRESS,
  MANIFOLD,
  ACK_DEPLOYER
} from '../../../constants';
import { Time } from '../../../time';
import { sqlExecutor } from '../../../sql-executor';

export interface GasResponse {
  token_id: number;
  contract: string;
  name: string;
  artist: string;
  thumbnail?: string;
  primary_gas: number;
  secondary_gas: number;
}

function getGasSql(
  type: 'memes' | 'memelab',
  artist: string,
  fromDate: string,
  toDate: string
) {
  const transactionsTable =
    type === 'memes' ? TRANSACTIONS_TABLE : TRANSACTIONS_MEME_LAB_TABLE;
  const nftsTable = type === 'memes' ? NFTS_TABLE : NFTS_MEME_LAB_TABLE;
  const contract = type === 'memes' ? MEMES_CONTRACT : MEMELAB_CONTRACT;

  const transactionsAlias = 'distinct_transactions';
  let primaryFilters = constructFilters(
    '',
    `${transactionsAlias}.contract = :contract`
  );
  let secondaryFilters = constructFilters(
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
    secondaryFilters = constructFilters(
      secondaryFilters,
      `${transactionsAlias}.transaction_date >= :from_date`
    );
    params.from_date = fromDate;
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    secondaryFilters = constructFilters(
      secondaryFilters,
      `${transactionsAlias}.transaction_date < :to_date`
    );
    params.to_date = nextDay;
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

  const sql = `
    SELECT
      ${nftsTable}.id as token_id,
      ${nftsTable}.contract,
      ${nftsTable}.name,
      ${nftsTable}.artist,
      ${nftsTable}.thumbnail,
      COALESCE(primary_gas.primary_gas, 0) as primary_gas,
      COALESCE(secondary_gas.secondary_gas, 0) as secondary_gas
    FROM
      ${nftsTable}
    LEFT JOIN
      (SELECT
        token_id,
        SUM(CASE
            WHEN from_address = :null_address OR from_address = :manifold ${specialCasePrimary}
            THEN gas
            ELSE 0
            END) AS primary_gas
      FROM
        (SELECT DISTINCT transaction, token_id, contract, gas, from_address FROM ${transactionsTable}) AS ${transactionsAlias}
      ${primaryFilters}
      GROUP BY token_id) AS primary_gas
      ON ${nftsTable}.id = primary_gas.token_id
    LEFT JOIN
      (SELECT
        token_id,
        SUM(CASE
            WHEN from_address != :null_address AND from_address != :manifold ${specialCaseSecondary}
            THEN gas
            ELSE 0
            END) AS secondary_gas
      FROM
        (SELECT DISTINCT transaction, token_id, contract, gas, from_address, transaction_date FROM ${transactionsTable}) AS ${transactionsAlias}
      ${secondaryFilters}
      GROUP BY token_id) AS secondary_gas
      ON ${nftsTable}.id = secondary_gas.token_id
    ${nftFilters}
    ORDER BY ${nftsTable}.contract ASC, ${nftsTable}.id ASC;`;

  return {
    sql,
    params
  };
}

export async function fetchGas(
  type: 'memes' | 'memelab',
  artist: string,
  fromDate: string,
  toDate: string
): Promise<GasResponse[]> {
  const sql = getGasSql(type, artist, fromDate, toDate);
  return sqlExecutor.execute(sql.sql, sql.params);
}
