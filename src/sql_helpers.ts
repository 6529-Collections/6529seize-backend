import {
  MEMES_CONTRACT,
  SZN1_INDEX,
  SZN2_INDEX,
  SZN3_INDEX,
  SZN4_INDEX,
  GRADIENT_CONTRACT,
  CONSOLIDATIONS_TABLE,
  TRANSACTIONS_TABLE,
  TRANSACTIONS_MEME_LAB_TABLE,
  NFTS_TABLE,
  NFTS_MEME_LAB_TABLE,
  MEMES_ROYALTIES_RATE,
  MEME_LAB_ROYALTIES_TABLE,
  MEMELAB_CONTRACT,
  MANIFOLD,
  NULL_ADDRESS,
  ACK_DEPLOYER
} from './constants';
import { constructFilters } from './api-serverless/src/api-helpers';
import { Time } from './time';

const mysql = require('mysql');

export function getConsolidationsSql() {
  const sql = `SELECT * FROM ${CONSOLIDATIONS_TABLE} 
    WHERE 
      (wallet1 = :wallet OR wallet2 = :wallet
      OR wallet1 IN (SELECT wallet2 FROM consolidations WHERE wallet1 = :wallet AND confirmed = true)
      OR wallet2 IN (SELECT wallet1 FROM consolidations WHERE wallet2 = :wallet AND confirmed = true)
      OR wallet2 IN (SELECT wallet2 FROM consolidations WHERE wallet1 = :wallet AND confirmed = true)
      OR wallet1 IN (SELECT wallet1 FROM consolidations WHERE wallet2 = :wallet AND confirmed = true)
      )
      AND confirmed = true
    ORDER BY block DESC`;
  return sql;
}

export function getProfilePageSql(wallets: string[]) {
  const sql = `SELECT 
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0) AS transfers_out,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0) AS transfers_in,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0) AS purchases_count,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0) AS purchases_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0) AS sales_count,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0) AS sales_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract) AS sales_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract) AS sales_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=:memes_contract) AS transfers_out_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:memes_contract) AS purchases_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:memes_contract) AS purchases_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=:memes_contract) AS transfers_in_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS sales_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS sales_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS transfers_out_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS purchases_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS purchases_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=:memes_contract AND token_id <= ${
       SZN1_INDEX.end
     }) AS transfers_in_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id > ${
       SZN1_INDEX.end
     } AND token_id <= ${SZN2_INDEX.end}) AS sales_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:memes_contract AND token_id > ${
       SZN1_INDEX.end
     } AND token_id <= ${SZN2_INDEX.end}) AS sales_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS transfers_out_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS purchases_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS purchases_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS transfers_in_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS sales_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS sales_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS transfers_out_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS purchases_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS purchases_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS transfers_in_memes_season3,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS sales_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS sales_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS transfers_out_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS purchases_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS purchases_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS transfers_in_memes_season4,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS sales_count_memes_season5,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS sales_value_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS transfers_out_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS purchases_count_memes_season5,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS purchases_value_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=${mysql.escape(
       MEMES_CONTRACT
     )} AND token_id > ${SZN4_INDEX.end}) AS transfers_in_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:gradient_contract AS sales_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (:wallets) AND value > 0 AND contract=:gradient_contract AS sales_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (:wallets) AND value = 0 AND contract=:gradient_contract AS transfers_out_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:gradient_contract AS purchases_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (:wallets) AND value > 0 AND contract=:gradient_contract AS purchases_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (:wallets) AND value = 0 AND contract=:gradient_contract AS transfers_in_gradients`;
  return {
    sql,
    params: {
      wallets: wallets,
      memes_contract: MEMES_CONTRACT,
      gradient_contract: GRADIENT_CONTRACT
    }
  };
}

export function getRoyaltiesSql(
  type: 'memes' | 'memelab',
  artist: string,
  fromDate: string,
  toDate: string
) {
  const transactionsTable =
    type === 'memes' ? TRANSACTIONS_TABLE : TRANSACTIONS_MEME_LAB_TABLE;
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

  let filters = constructFilters('', `${transactionsTable}.contract=:contract`);
  const params: any = {
    contract: contract,
    no_royalty_artist: '%6529%',
    null_address: NULL_ADDRESS,
    manifold: MANIFOLD,
    ack_deployer: ACK_DEPLOYER
  };

  filters = constructFilters(filters, `${transactionsTable}.value > 0`);

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
      `${transactionsTable}.transaction_date >= :from_date`
    );
    params.from_date = fromDate;
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    filters = constructFilters(
      filters,
      `${transactionsTable}.transaction_date < :to_date`
    );
    params.to_date = nextDay;
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

  const sql = `
    SELECT 
      ${nftsTable}.id as token_id, 
      ${nftsTable}.contract, 
      ${nftsTable}.name, 
      ${nftsTable}.artist, 
      ${nftsTable}.thumbnail,
      COALESCE(primaryVolume.primary_total_volume, 0) as primary_volume,
      COALESCE(aggregated.secondary_total_volume, 0) as secondary_volume,
      COALESCE(aggregated.total_royalties, 0) as royalties,
      CASE WHEN artist not like :no_royalty_artist THEN ${primaryRoyaltySplitSource} ELSE 0 END as primary_royalty_split,
      CASE WHEN artist not like :no_royalty_artist THEN ${secondaryRoyaltySplitSource} ELSE 0 END as secondary_royalty_split,
      COALESCE(primaryVolume.primary_total_volume, 0) * CASE WHEN artist not like :no_royalty_artist THEN ${primaryRoyaltySplitSource} ELSE 0 END AS primary_artist_take,
      COALESCE(aggregated.total_royalties, 0) * CASE WHEN artist not like :no_royalty_artist THEN ${secondaryRoyaltySplitSource} ELSE 0 END AS secondary_artist_take
    FROM 
      ${nftsTable} 
    LEFT JOIN 
      (SELECT 
        token_id, 
        SUM(CASE WHEN from_address IN (:null_address, :manifold) ${specialCasePrimary} THEN value ELSE 0 END) AS primary_total_volume
      FROM 
        ${transactionsTable}
      WHERE contract=:contract
      GROUP BY 
        token_id) AS primaryVolume
      ON ${nftsTable}.id = primaryVolume.token_id
    LEFT JOIN 
      (SELECT 
        token_id,
        SUM(CASE WHEN from_address NOT IN (:null_address, :manifold) ${specialCaseSecondary} THEN value ELSE 0 END) AS secondary_total_volume,
        SUM(royalties) AS total_royalties
      FROM 
        ${transactionsTable}
      ${filters}
      GROUP BY 
        token_id) AS aggregated
      ON ${nftsTable}.id = aggregated.token_id
    ${royaltiesJoinClause}
    ${nftFilters}
    ORDER BY 
      ${nftsTable}.id ASC;`;

  return {
    sql,
    params
  };
}

export function getGasSql(
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
