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
  NULL_ADDRESS
} from './constants';
import { constructFilters } from './api-serverless/src/api-helpers';
import { Time } from './time';

const mysql = require('mysql');

export function getConsolidationsSql(wallet: string) {
  const sql = `SELECT * FROM ${CONSOLIDATIONS_TABLE} 
    WHERE 
      (wallet1 = ${mysql.escape(wallet)} OR wallet2 = ${mysql.escape(wallet)}
      OR wallet1 IN (SELECT wallet2 FROM consolidations WHERE wallet1 = ${mysql.escape(
        wallet
      )} AND confirmed = true)
      OR wallet2 IN (SELECT wallet1 FROM consolidations WHERE wallet2 = ${mysql.escape(
        wallet
      )} AND confirmed = true)
      OR wallet2 IN (SELECT wallet2 FROM consolidations WHERE wallet1 = ${mysql.escape(
        wallet
      )} AND confirmed = true)
      OR wallet1 IN (SELECT wallet1 FROM consolidations WHERE wallet2 = ${mysql.escape(
        wallet
      )} AND confirmed = true)
      )
      AND confirmed = true
    ORDER BY block DESC`;
  return sql;
}

export function getProfilePageSql(resolvedWallets: string[]) {
  return `SELECT 
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_out,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0) AS transfers_in,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_count,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS purchases_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_count,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0) AS sales_value,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS sales_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS sales_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS transfers_out_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS purchases_count_memes,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS purchases_value_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )}) AS transfers_in_memes,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS sales_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS sales_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_out_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_count_memes_season1,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS purchases_value_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id <= ${SZN1_INDEX.end}) AS transfers_in_memes_season1,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS sales_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS sales_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS transfers_out_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS purchases_count_memes_season2,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS purchases_value_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN1_INDEX.end} AND token_id <= ${
    SZN2_INDEX.end
  }) AS transfers_in_memes_season2,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS sales_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS sales_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS transfers_out_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS purchases_count_memes_season3,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS purchases_value_memes_season3,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN2_INDEX.end} AND token_id <= ${
    SZN3_INDEX.end
  }) AS transfers_in_memes_season3,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS sales_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS sales_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS transfers_out_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS purchases_count_memes_season4,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS purchases_value_memes_season4,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN3_INDEX.end} AND token_id <= ${
    SZN4_INDEX.end
  }) AS transfers_in_memes_season4,
      (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS sales_count_memes_season5,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS sales_value_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS transfers_out_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS purchases_count_memes_season5,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS purchases_value_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    MEMES_CONTRACT
  )} AND token_id > ${SZN4_INDEX.end}) AS transfers_in_memes_season5,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS sales_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS sales_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE from_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS transfers_out_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS purchases_count_gradients,
    (SELECT SUM(value) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value > 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS purchases_value_gradients,
    (SELECT SUM(token_count) FROM transactions 
     WHERE to_address IN (${mysql.escape(
       resolvedWallets
     )}) AND value = 0 AND contract=${mysql.escape(
    GRADIENT_CONTRACT
  )}) AS transfers_in_gradients`;
}

export function getRoyaltiesSql(
  type: 'memes' | 'memelab',
  fromDate: string,
  toDate: string
) {
  const transactionsTable =
    type === 'memes' ? TRANSACTIONS_TABLE : TRANSACTIONS_MEME_LAB_TABLE;
  const nftsTable = type === 'memes' ? NFTS_TABLE : NFTS_MEME_LAB_TABLE;
  const contract = type === 'memes' ? MEMES_CONTRACT : MEMELAB_CONTRACT;
  const royaltySplitSource =
    type === 'memes'
      ? MEMES_ROYALTIES_RATE
      : `${MEME_LAB_ROYALTIES_TABLE}.royalty_split`;

  let filters = constructFilters(
    '',
    `${transactionsTable}.contract=${mysql.escape(contract)}`
  );

  filters = constructFilters(filters, `${transactionsTable}.value > 0`);
  if (fromDate) {
    filters = constructFilters(
      filters,
      `${transactionsTable}.transaction_date >= ${mysql.escape(fromDate)}`
    );
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    filters = constructFilters(
      filters,
      `${transactionsTable}.transaction_date < ${mysql.escape(nextDay)}`
    );
  }

  filters = constructFilters(
    filters,
    `from_address != ${mysql.escape(NULL_ADDRESS)}`
  );
  filters = constructFilters(
    filters,
    `from_address != ${mysql.escape(MANIFOLD)}`
  );

  const royaltiesJoinClause =
    type === 'memelab'
      ? `JOIN ${MEME_LAB_ROYALTIES_TABLE} ON aggregated.token_id = ${MEME_LAB_ROYALTIES_TABLE}.token_id`
      : '';

  const sql = `
    SELECT 
      aggregated.token_id, 
      ${nftsTable}.name, 
      ${nftsTable}.artist, 
      ${nftsTable}.thumbnail, 
      aggregated.total_volume,
      aggregated.total_royalties,
      ${royaltySplitSource} as royalty_split,
      aggregated.total_royalties * ${royaltySplitSource} AS artist_take
    FROM 
      (SELECT 
        token_id,
        contract,
        SUM(value) AS total_volume,
        SUM(royalties) AS total_royalties
      FROM 
        ${transactionsTable}
      ${filters}
      GROUP BY 
        token_id, 
        contract) AS aggregated
    JOIN 
      ${nftsTable} ON aggregated.contract = ${nftsTable}.contract AND aggregated.token_id = ${nftsTable}.id
    ${royaltiesJoinClause}
    ORDER BY 
      aggregated.contract ASC, 
      aggregated.token_id ASC;`;
  return sql;
}

export function getGasSql(
  type: 'memes' | 'memelab',
  fromDate: string,
  toDate: string
) {
  const transactionsTable =
    type === 'memes' ? TRANSACTIONS_TABLE : TRANSACTIONS_MEME_LAB_TABLE;
  const nftsTable = type === 'memes' ? NFTS_TABLE : NFTS_MEME_LAB_TABLE;
  const contract = type === 'memes' ? MEMES_CONTRACT : MEMELAB_CONTRACT;

  const transactionsAlias = 'distinct_transactions';
  let filters = constructFilters(
    '',
    `${transactionsAlias}.contract=${mysql.escape(contract)}`
  );
  if (fromDate) {
    filters = constructFilters(
      filters,
      `${transactionsAlias}.transaction_date >= ${mysql.escape(fromDate)}`
    );
  }
  if (toDate) {
    const nextDay = Time.fromString(toDate).plusDays(1).toIsoDateString();
    filters = constructFilters(
      filters,
      `${transactionsAlias}.transaction_date < ${mysql.escape(nextDay)}`
    );
  }

  const sql = `
    SELECT
      aggregated.token_id,
      ${nftsTable}.name,
      ${nftsTable}.artist,
      ${nftsTable}.thumbnail,
      aggregated.primary_gas,
      aggregated.secondary_gas
    FROM
      (SELECT
        token_id,
        contract,
        SUM(CASE
            WHEN from_address = ${mysql.escape(
              NULL_ADDRESS
            )} OR from_address = ${mysql.escape(MANIFOLD)}
            THEN gas
            ELSE 0
            END) AS primary_gas,
        SUM(CASE
            WHEN from_address != ${mysql.escape(
              NULL_ADDRESS
            )} AND from_address != ${mysql.escape(MANIFOLD)}
            THEN gas
            ELSE 0
            END) AS secondary_gas
      FROM
        (SELECT DISTINCT transaction, token_id, contract, gas, from_address, transaction_date FROM ${transactionsTable}) as ${transactionsAlias}
      ${filters}
      GROUP BY
        token_id,
        contract) AS aggregated
    JOIN
      ${nftsTable} ON aggregated.contract = ${nftsTable}.contract AND aggregated.token_id = ${nftsTable}.id
    GROUP BY
      aggregated.token_id,
      aggregated.contract
    ORDER BY
      aggregated.contract ASC,
      aggregated.token_id ASC;`;
  return sql;
}
