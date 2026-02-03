import { EntityManager, QueryRunner } from 'typeorm';
import { updateSubscriptionMode } from '../api-serverless/src/subscriptions/api.subscriptions.db';
import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { getDataSource } from '../db';
import {
  SubscriptionBalance,
  SubscriptionTopUp,
  SubscriptionTopUpLatestBlock
} from '../entities/ISubscription';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import { sendDiscordUpdate } from '../notifier-discord';
import { sqlExecutor } from '../sql-executor';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_DB');

const SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_ID = 'subscription_top_up_latest_block';

export async function persistTopUps(topUps: SubscriptionTopUp[]) {
  const processedTopUps: SubscriptionTopUp[] = [];
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const balancesRepo = manager.getRepository(SubscriptionBalance);
    const topUpsRepo = manager.getRepository(SubscriptionTopUp);

    for (const topUp of topUps) {
      const isProcessed = await isTopUpProcessed(topUp.hash, manager);
      if (isProcessed) {
        const message = `Top up ${topUp.hash} already processed`;
        logger.warn(message);
        await sendDiscordUpdate(
          process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
          message,
          'Subscriptions',
          'warn'
        );

        continue;
      }

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
        try {
          await updateSubscriptionMode(consolidationKey, true, qrHolder);
        } catch (e) {
          logger.warn(
            `Error setting subscription mode to auto-subscribe for ${consolidationKey}: ${e}`
          );
        }
      }

      processedTopUps.push(topUp);
    }
  });

  for (const topUp of processedTopUps) {
    const seizeDomain =
      process.env.NODE_ENV === 'development' ? 'staging.6529' : '6529';
    let discordMessage = `🔝 Subscription Top Up of ${topUp.amount} ETH from ${topUp.from_wallet}.`;
    const link = ethTools.toEtherScanTransactionLink(
      parseInt(process.env.SUBSCRIPTIONS_CHAIN_ID ?? '1'),
      topUp.hash
    );
    discordMessage += ` \n\n[View on 6529.io] \nhttps://${seizeDomain}.io/${topUp.from_wallet}/subscriptions`;
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

export async function getLatestSubscriptionTopUpBlock(): Promise<
  number | null
> {
  try {
    const repository = getDataSource().getRepository(
      SubscriptionTopUpLatestBlock
    );
    const latestBlock = await repository.findOne({
      where: { id: SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_ID }
    });
    return latestBlock?.block ?? null;
  } catch (error) {
    logger.warn(
      `Error fetching latest subscription top up block: ${(error as Error).message}`
    );
    return null;
  }
}

export async function persistLatestSubscriptionTopUpBlock(
  block: number,
  blockTimestamp?: number
): Promise<void> {
  const repository = getDataSource().getRepository(
    SubscriptionTopUpLatestBlock
  );
  const entity: Partial<SubscriptionTopUpLatestBlock> = {
    id: SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_ID,
    block
  };

  if (blockTimestamp !== undefined) {
    entity.block_timestamp = new Date(blockTimestamp * 1000);
  }

  await repository.save(entity);
}

async function isTopUpProcessed(
  hash: string,
  manager: EntityManager
): Promise<boolean> {
  const exists = await manager
    .createQueryBuilder()
    .select('1')
    .from(SubscriptionTopUp, 'topup')
    .where('topup.hash = :hash', { hash })
    .getExists();
  return exists;
}
