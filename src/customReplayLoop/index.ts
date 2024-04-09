import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import { ETH_PRICE_TABLE, TRANSACTIONS_TABLE } from '../constants';
import { Transaction } from '../entities/ITransaction';
import { EthPrice } from '../entities/IEthPrice';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  const allEthPrices: EthPrice[] = await getDataSource().manager.query(
    `SELECT * from ${ETH_PRICE_TABLE} ORDER BY timestamp_ms DESC`
  );

  let hasMore = true;
  while (hasMore) {
    hasMore = await addEthPriceToTransactions(allEthPrices);
  }
}

async function addEthPriceToTransactions(allEthPrices: EthPrice[]) {
  const batchSize = 1000;
  const missingEthPrices: Transaction[] = await getDataSource().manager.query(
    `
      SELECT * from ${TRANSACTIONS_TABLE}
      WHERE eth_price_usd IS NULL OR eth_price_usd = 0
      ORDER BY block DESC 
      LIMIT ${batchSize}
    `
  );

  await getDataSource().manager.transaction(async (manager) => {
    await Promise.all(
      missingEthPrices.map(async (t) => {
        const ethPrice = getClosestEthUsdPrice(
          allEthPrices,
          t.transaction_date
        );
        const valueUsd = t.value * ethPrice;
        const gasUsd = t.gas * ethPrice;

        await manager.query(
          `
            UPDATE ${TRANSACTIONS_TABLE}
            SET eth_price_usd = ?,
                value_usd = ?,
                gas_usd = ?
            WHERE transaction = ?
            AND from_address = ?
            AND to_address = ?
            AND contract = ?
            AND token_id = ?
          `,
          [
            ethPrice,
            valueUsd,
            gasUsd,
            t.transaction,
            t.from_address,
            t.to_address,
            t.contract,
            t.token_id
          ]
        );
      })
    );
  });

  const hasMore = missingEthPrices.length === batchSize;
  logger.info(
    `[REPLAYED ${missingEthPrices.length} TRANSACTIONS] : [HAS MORE: ${hasMore}]`
  );
  return missingEthPrices.length === batchSize;
}

function getClosestEthUsdPrice(allEthPrices: EthPrice[], date: Date): number {
  const timestampMs = date.getTime();
  const price = allEthPrices.find((p) => p.timestamp_ms <= timestampMs);
  return price ? price.usd_price : 0;
}
