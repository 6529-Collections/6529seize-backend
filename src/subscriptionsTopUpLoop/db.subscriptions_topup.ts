import { QueryRunner } from 'typeorm';
import { updateSubscriptionMode } from '../api-serverless/src/subscriptions/api.subscriptions.db';
import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '../constants';
import { getDataSource } from '../db';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../entities/ISubscription';
import { getTransactionLink } from '../helpers';
import { sendDiscordUpdate } from '../notifier-discord';
import { sqlExecutor } from '../sql-executor';

export async function persistTopUps(topUps: SubscriptionTopUp[]) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const balancesRepo = manager.getRepository(SubscriptionBalance);
    const topUpsRepo = manager.getRepository(SubscriptionTopUp);

    for (const topUp of topUps) {
      let consolidationKey = (
        await manager.query(
          `SELECT consolidation_key FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE address = '${topUp.from_wallet}'`
        )
      )[0]?.consolidation_key;

      if (!consolidationKey) {
        consolidationKey = topUp.from_wallet;
      }

      let balance = await balancesRepo.findOne({
        where: { consolidation_key: consolidationKey }
      });

      const setToAutoSubscribe = !balance;

      if (!balance) {
        balance = {
          consolidation_key: consolidationKey,
          balance: topUp.amount
        };
      } else {
        let balanceAfter = balance.balance + topUp.amount;
        balanceAfter = Math.round(balanceAfter * 100000) / 100000;
        balance.balance = balanceAfter;
      }
      await balancesRepo.save(balance);
      await topUpsRepo.save(topUp);

      if (setToAutoSubscribe) {
        await updateSubscriptionMode(consolidationKey, true, qrHolder);
      }
    }
  });

  for (const topUp of topUps) {
    const seizeDomain =
      process.env.NODE_ENV === 'development' ? 'staging.seize' : 'seize';
    let discordMessage = `🔝 Subscription Top Up of ${topUp.amount} ETH from ${topUp.from_wallet}.`;
    const link = getTransactionLink(
      parseInt(process.env.SUBSCRIPTIONS_CHAIN_ID ?? '1'),
      topUp.hash
    );
    discordMessage += ` \n\n[View on Seize] \nhttps://${seizeDomain}.io/${topUp.from_wallet}/subscriptions`;
    discordMessage += ` \n\n[View on Etherscan] \n${link}`;
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      discordMessage,
      'Subscription Top Up',
      'success'
    );
  }
}

export async function getMaxSubscriptionTopUpBlock(): Promise<number> {
  const result = await getDataSource().query(
    `SELECT MAX(block) as max_block FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
  );
  return result?.[0].max_block ?? 0;
}
