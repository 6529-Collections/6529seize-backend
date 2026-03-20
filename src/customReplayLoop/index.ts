import {
  MANIFOLD,
  MEMES_CONTRACT,
  MEMES_MINT_STATS_TABLE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    { logger }
  );
});

async function replay() {
  await backfillMemesMintStatsCounts();
}

async function backfillMemesMintStatsCounts() {
  logger.info(`[MEMES MINT STATS BACKFILL START]`);

  const result = await sqlExecutor.execute<any>(
    `UPDATE ${MEMES_MINT_STATS_TABLE} mms
    LEFT JOIN (
      SELECT
        token_id,
        COALESCE(SUM(token_count), 0) AS direct_mint_count
      FROM ${TRANSACTIONS_TABLE}
      WHERE contract = '${MEMES_CONTRACT}'
        AND from_address IN ('${NULL_ADDRESS}', '${MANIFOLD}')
        AND to_address NOT IN ('${NULL_ADDRESS}', '${MANIFOLD}')
        AND value > 0
      GROUP BY token_id
    ) direct_mints ON direct_mints.token_id = mms.id
    LEFT JOIN (
      SELECT
        token_id,
        COALESCE(SUM(count), 0) AS subscriptions_count
      FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
      WHERE contract = '${MEMES_CONTRACT}'
      GROUP BY token_id
    ) subscription_mints ON subscription_mints.token_id = mms.id
    SET
      mms.direct_mint_count = COALESCE(direct_mints.direct_mint_count, 0),
      mms.subscriptions_count = COALESCE(subscription_mints.subscriptions_count, 0)`
  );

  logger.info(
    `[MEMES MINT STATS BACKFILL DONE] [affectedRows=${sqlExecutor.getAffectedRows(
      result
    )}]`
  );
}
