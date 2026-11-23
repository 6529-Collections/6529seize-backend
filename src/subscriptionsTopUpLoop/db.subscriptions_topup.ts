import { EntityManager, QueryRunner } from 'typeorm';
import { updateSubscriptionMode } from '../api-serverless/src/subscriptions/api.subscriptions.db';
import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { getDataSource } from '../db';
import {
  SubscriptionTopUp,
  SubscriptionTopUpLatestBlock
} from '../entities/ISubscription';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import { sendDiscordUpdate } from '../notifier-discord';
import {
  sendProcessedTopUpWaveWarning,
  sendSubscriptionTopUpWaveUpdate
} from '../subscription-wave-notifier';
import { sqlExecutor } from '../sql-executor';
import {
  claimDeferredWrite,
  deferralReason,
  deferSubscriptionWrites,
  executorSink,
  isWriteWaiting
} from '@/subscription-key-width/subscription-deferred-writes';
import { markSubscriptionCoverageDirty } from '../subscription-coverage/subscription-coverage-dirty';
import { invalidateUpcomingSubscriptionCaches } from '@/subscriptionsDaily/subscription-cache';
import {
  lockSubscriptionBalance,
  writeSubscriptionBalance
} from '@/subscriptionsDaily/db.subscriptions';
import {
  hasMinimumBalanceForAutomaticMode,
  InsufficientSubscriptionBalanceException
} from '@/api/subscriptions/insufficient-subscription-balance.exception';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_DB');

const SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_ID = 'subscription_top_up_latest_block';

/**
 * The top-up rows alone, as discovery found them: no balance credit, log
 * line or mode change. A rebuild of the rows from Ethereum, where the
 * credit is kept elsewhere (the identity tables after the switch). A hash
 * already there is left as it is. A top-up whose write waits in the
 * deferred writes queue is left out: persistTopUps queued it whole, and
 * its row is written only when the queue replays it.
 */
export async function recordTopUps(topUps: SubscriptionTopUp[]): Promise<void> {
  for (const topUp of topUps) {
    if (await isWriteWaiting('TOP_UP', topUp.hash)) {
      logger.info(
        `[TOP UP ${topUp.hash} WAITS IN THE DEFERRED WRITES QUEUE] [ROW LEFT OUT]`
      );
      continue;
    }
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE}
        (created_at, hash, block, transaction_date, from_wallet, amount)
        VALUES (NOW(), :hash, :block, :transactionDate, :fromWallet, :amount)
        ON DUPLICATE KEY UPDATE hash = hash`,
      {
        hash: topUp.hash,
        block: topUp.block,
        transactionDate: topUp.transaction_date,
        fromWallet: topUp.from_wallet,
        amount: topUp.amount
      }
    );
  }
}

/**
 * Credits top-ups to their consolidation keys. With `replaySequence` it
 * replays one queued top-up: the queue entry is claimed in the same
 * transaction, and false is returned when another run had claimed it.
 */
export async function persistTopUps(
  topUps: SubscriptionTopUp[],
  options: { readonly replaySequence?: number } = {}
): Promise<boolean> {
  const processedTopUps: SubscriptionTopUp[] = [];
  const alreadyProcessedTopUpHashes: string[] = [];
  const dirtyConsolidationKeys = new Set<string>();
  let claimed = true;
  await sqlExecutor.executeNativeQueriesInTransaction(async (qrHolder) => {
    const queryRunner = qrHolder.connection as QueryRunner;
    const manager = queryRunner.manager;
    const topUpsRepo = manager.getRepository(SubscriptionTopUp);
    const sink = executorSink({ wrappedConnection: qrHolder });
    if (options.replaySequence !== undefined) {
      claimed = await claimDeferredWrite(options.replaySequence, 'DONE', sink);
      if (!claimed) {
        return;
      }
    }

    for (const topUp of topUps) {
      const isProcessed = await isTopUpProcessed(topUp.hash, manager);
      if (isProcessed) {
        const message = `⚠️ Top up ${topUp.hash} already processed`;
        logger.error(message);
        addUniqueTopUpHash(alreadyProcessedTopUpHashes, topUp.hash);

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

      // The key read above can be stale: a merge may have moved its balance
      // to another key since. lockSubscriptionBalance follows the move.
      const locked = await lockSubscriptionBalance(consolidationKey, manager);
      consolidationKey = locked.consolidationKey;

      // A key that must wait (too long for a subscription table, or with
      // earlier writes waiting) has the whole top-up queued: no balance and
      // no top-up row, so the top-up is applied, once, when it is replayed.
      // Checked on the key the top-up would be written to, after the move.
      const reason = await deferralReason(
        consolidationKey,
        sink,
        options.replaySequence,
        { locking: true }
      );
      if (reason) {
        await deferSubscriptionWrites(
          [
            {
              kind: 'TOP_UP',
              consolidationKey,
              dedupe: topUp.hash,
              payload: { topUp },
              reason
            }
          ],
          sink
        );
        continue;
      }

      let balance = locked.balance;

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
      await writeSubscriptionBalance(manager, balance, locked.balance !== null);
      await topUpsRepo.save(topUp);

      if (setToAutoSubscribe) {
        await enableAutomaticModeAfterFirstTopUp(
          consolidationKey,
          balance.balance,
          qrHolder
        );
      }
      dirtyConsolidationKeys.add(consolidationKey);
      processedTopUps.push(topUp);
    }
  });
  await invalidateUpcomingSubscriptionCaches(
    Array.from(dirtyConsolidationKeys)
  );
  await markSubscriptionCoverageDirty(
    Array.from(dirtyConsolidationKeys),
    'BALANCE_TOPPED_UP'
  );

  for (const hash of alreadyProcessedTopUpHashes) {
    await sendProcessedTopUpWaveWarning(hash);
  }

  for (const topUp of processedTopUps) {
    const seizeDomain =
      process.env.NODE_ENV === 'development' ? 'staging.6529' : '6529';
    let discordMessage = `💰 Subscription Top Up of ${topUp.amount} ETH from ${topUp.from_wallet}.`;
    const link = ethTools.toEtherScanTransactionLink(
      parseInt(process.env.SUBSCRIPTIONS_CHAIN_ID ?? '1'),
      topUp.hash
    );
    discordMessage += ` \n\nView on [6529.io](https://${seizeDomain}.io/${topUp.from_wallet}/subscriptions) | [Etherscan](${link})`;
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      discordMessage,
      'Subscription Top Up',
      'success'
    );
    await sendSubscriptionTopUpWaveUpdate({
      topUp,
      seizeDomain,
      etherscanLink: link
    });
  }
  return claimed;
}

/**
 * A first top-up switches the consolidation to automatic mode when it covers
 * at least one mint. A smaller first top-up keeps the current mode: that is
 * an expected outcome and must not roll back the batch. Any other failure
 * (for example a lock wait timeout) still propagates so the whole batch
 * rolls back and is retried.
 */
async function enableAutomaticModeAfterFirstTopUp(
  consolidationKey: string,
  balance: number,
  qrHolder: unknown
): Promise<void> {
  if (!hasMinimumBalanceForAutomaticMode(balance)) {
    logger.info(
      `First top-up for ${consolidationKey} is below the mint price; subscription mode left unchanged`
    );
    return;
  }
  try {
    await updateSubscriptionMode(consolidationKey, true, qrHolder);
  } catch (e) {
    if (e instanceof InsufficientSubscriptionBalanceException) {
      logger.info(
        `Balance for ${consolidationKey} does not cover a mint; subscription mode left unchanged`
      );
      return;
    }
    logger.warn(
      `Error setting subscription mode to auto-subscribe for ${consolidationKey}: ${e}`
    );
    throw e;
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

function addUniqueTopUpHash(hashes: string[], hash: string): void {
  if (!hashes.includes(hash)) {
    hashes.push(hash);
  }
}
