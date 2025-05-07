import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import {
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '../constants';
import {
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
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

const set0Balance = [
  '0xaa1e92ddd28c835fe66689771d35f38947950fd4',
  '0x538eb86b52e480ec0ff1fa87c77c1f36e3f04a0a',
  '0xafc093b1c8419f05d4de6ff54d38121c0d733752',
  '0xca67baf0f7e33ff1bc00bec9d6eb252644828f69',
  '0xe375b00384ecbed3da6d2f8dec7b6784cf3693d9',
  '0xefc26e228cda4085476fb6a98331ed6f504fcad2'
];

async function replay() {
  // console.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const redeemedSubscriptions: RedeemedSubscription[] =
    await getDataSource().query(
      `SELECT * FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
    );

  const redeemedSubscriptionsNot352 = redeemedSubscriptions.filter(
    (redeemed) => redeemed.token_id != 352
  );
  const redeemedSubscriptions352 = redeemedSubscriptions.filter(
    (redeemed) => redeemed.token_id == 352
  );

  const topUps: SubscriptionTopUp[] = await getDataSource().query(
    `SELECT * FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
  );

  const balances: SubscriptionBalance[] = await getDataSource().query(
    `SELECT * FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
  );

  console.log('balances', balances.length);
  console.log('topUps', topUps.length);
  console.log('redeemedSubscriptions', redeemedSubscriptions.length);
  console.log(
    'redeemedSubscriptionsNot352',
    redeemedSubscriptionsNot352.length
  );

  for (const balance of balances) {
    console.info(`\n[BALANCE] ${balance.consolidation_key}`);

    const has352Redeemed = redeemedSubscriptions352.some(
      (redeemed) => balance.consolidation_key === redeemed.consolidation_key
    );
    console.info(`has 352 redeemed: ${has352Redeemed}`);

    const redeemed = redeemedSubscriptionsNot352.filter(
      (redeemed) => balance.consolidation_key === redeemed.consolidation_key
    );
    const latestRedeemed = redeemed.sort((a, d) => d.token_id - a.token_id)[0];
    if (!latestRedeemed) {
      console.info(`no latest redeemed`);
      await withoutLatestRedeemed(balance, topUps, has352Redeemed);
    } else {
      console.info(`latest redeemed: ${latestRedeemed.token_id}`);
      await withLatestRedeemed(balance, latestRedeemed, topUps, has352Redeemed);
    }
  }

  console.info(`\n[END]`);
}

async function withLatestRedeemed(
  balance: SubscriptionBalance,
  latestRedeemed: RedeemedSubscription,
  topUps: SubscriptionTopUp[],
  has352Redeemed: boolean
) {
  console.info(
    `latest redeemed balance after: ${latestRedeemed.balance_after}`
  );

  const topUpsForBalanceAfterLatestRedeemed = topUps.filter(
    (topUp) =>
      balance.consolidation_key
        .toLowerCase()
        .includes(topUp.from_wallet.toLowerCase()) &&
      topUp.transaction_date > latestRedeemed.transaction_date
  );
  const sumTopUps = topUpsForBalanceAfterLatestRedeemed.reduce(
    (acc, topUp) => acc + topUp.amount,
    0
  );
  console.info(`topUps for balance after latest redeemed: ${sumTopUps}`);

  let balanceAfter = latestRedeemed.balance_after;

  balanceAfter += sumTopUps;

  if (has352Redeemed) {
    balanceAfter -= 0.06529;
  }

  balanceAfter = Math.round(balanceAfter * 1e10) / 1e10;

  console.info(`End balance: ${balanceAfter}`);

  if (balanceAfter < 0) {
    console.error(
      `[BALANCE] ${balance.consolidation_key} has negative balance: ${balanceAfter}`
    );
  }

  await updateBalance(balance.consolidation_key, balanceAfter);
}

async function withoutLatestRedeemed(
  balance: SubscriptionBalance,
  topUps: SubscriptionTopUp[],
  has352Redeemed: boolean
) {
  const logs: SubscriptionLog[] = await getDataSource().query(
    `SELECT * FROM ${SUBSCRIPTIONS_LOGS_TABLE} 
    WHERE consolidation_key = '${balance.consolidation_key}' 
    AND created_at < '2025-04-23' 
    AND log like 'Added to Final Subscription%' 
    ORDER BY created_at DESC
    LIMIT 1`
  );

  const latestLog = logs[0];
  const match =
    latestLog && latestLog.additional_info
      ? latestLog.additional_info.match(/Balance:\s*([0-9.]+)/)
      : null;

  if (match) {
    let balanceAtLatestLog = parseFloat(match[1]);
    console.info(`balance at latest log: ${balanceAtLatestLog}`);
    const topUpsForBalanceAfterLatestRedeemed = topUps.filter(
      (topUp) =>
        balance.consolidation_key
          .toLowerCase()
          .includes(topUp.from_wallet.toLowerCase()) &&
        topUp.transaction_date > latestLog.created_at!
    );
    const sumTopUps = topUpsForBalanceAfterLatestRedeemed.reduce(
      (acc, topUp) => acc + topUp.amount,
      0
    );
    console.info(`topUps for balance after latest log: ${sumTopUps}`);
    balanceAtLatestLog += sumTopUps;
    if (has352Redeemed) {
      balanceAtLatestLog -= 0.06529;
    }
    balanceAtLatestLog = Math.round(balanceAtLatestLog * 1e10) / 1e10;
    console.info(`end balance: ${balanceAtLatestLog}`);
    await updateBalance(balance.consolidation_key, balanceAtLatestLog);
  } else {
    console.info('no match');
    if (set0Balance.includes(balance.consolidation_key)) {
      console.info('set 0 balance');
      await updateBalance(balance.consolidation_key, 0);
    } else {
      console.log('no change');
    }
  }
}

async function updateBalance(key: string, balance: number) {
  console.info(`WILL UPDATE BALANCE FOR ${key} TO ${balance}`);
  await getDataSource().query(
    `UPDATE ${SUBSCRIPTIONS_BALANCES_TABLE} SET balance = ${balance} WHERE consolidation_key = '${key}'`
  );
}

// top ups: 840.9179443168517
// redeemed: 10918 * 0.06529 = 712.83622
// balance: 128.08172431685
// actual balance: 128.60404431680013

// diff: -0.52232
// diff cards: 0.52232 / 0.06529 = 8

// docker exec -i 6529seize-backend-mariadb-1 \
//     mysql -u root -ppassword OM6529 < ~/Desktop/subscriptions_redeemed_dump.sql

// docker exec -i 6529seize-backend-mariadb-1 \
//     mysql -u root -ppassword OM6529 < ~/Desktop/subscriptions_dump.sql

// balances: 130.29987555920027
// top ups: 847.4452353168521
// redeemed: 11141 * 0.06529 = 727.39589

// diff: 847.4452353168521 - 727.39589 = 120.04934531685

// --------
// 0xaa1e92ddd28c835fe66689771d35f38947950fd4 -> balance 0
// 0x538eb86b52e480ec0ff1fa87c77c1f36e3f04a0a -> balance 0
// 0xafc093b1c8419f05d4de6ff54d38121c0d733752 -> balance 0
// 0xca67baf0f7e33ff1bc00bec9d6eb252644828f69 -> balance 0
// 0xe375b00384ecbed3da6d2f8dec7b6784cf3693d9 -> balance 0
// 0xefc26e228cda4085476fb6a98331ed6f504fcad2 -> balance 0

// ----FINAL PROD
// balance: 120.5063755592002;
// top ups: 847.9022653168521
// redeemed: 11141 * 0.06529 = 727.39589

// diff: 847.9022653168521 - 727.39589 = 120.5063753168521
