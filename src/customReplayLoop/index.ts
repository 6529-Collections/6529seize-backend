import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '../constants';
import {
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionTopUp
} from '../entities/ISubscription';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      logger,
      entities: [
        SUBSCRIPTIONS_REDEEMED_TABLE,
        SUBSCRIPTIONS_TOP_UP_TABLE,
        SUBSCRIPTIONS_BALANCES_TABLE
      ]
    }
  );
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const redeemedSubscriptions: RedeemedSubscription[] =
    await getDataSource().query(
      `SELECT * FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
    );

  const topUps: SubscriptionTopUp[] = await getDataSource().query(
    `SELECT * FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
  );

  const balances: SubscriptionBalance[] = await getDataSource().query(
    `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
  );

  for (const balance of balances) {
    const balanceTopUps = topUps.filter((topUp) =>
      balance?.consolidation_key.includes(topUp.from_wallet)
    );
    const totalTopUp = balanceTopUps.reduce(
      (acc, topUp) => acc + topUp.amount,
      0
    );

    const balanceRedeemed = redeemedSubscriptions.filter(
      (redeemed) => balance?.consolidation_key === redeemed.consolidation_key
    );

    const rawResult = totalTopUp - balanceRedeemed.length * 0.06529;
    const balanceAfter = Math.round(rawResult * 1e10) / 1e10;

    logger.info(`[BALANCE] ${balance.consolidation_key} ${balanceAfter}`);

    // await getDataSource().query(
    //   `UPDATE ${SUBSCRIPTIONS_BALANCES_TABLE} SET balance = ${balanceAfter} WHERE consolidation_key = '${balance.consolidation_key}'`
    // );
  }
}
