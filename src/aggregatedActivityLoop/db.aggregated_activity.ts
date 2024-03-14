import {
  AGGREGATED_ACTIVITY_MEMES_TABLE,
  AGGREGATED_ACTIVITY_TABLE
} from '../constants';
import { getDataSource } from '../db';
import {
  AggregatedActivity,
  ConsolidatedAggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { Logger } from '../logging';

const logger = Logger.get('DB_AGGREGATED_ACTIVITY');

export async function getMaxBlockReference(): Promise<number> {
  const maxBlock = await getDataSource()
    .getRepository(AggregatedActivity)
    .createQueryBuilder(AGGREGATED_ACTIVITY_TABLE)
    .select(`MAX(${AGGREGATED_ACTIVITY_TABLE}.block_reference)`, 'max_block')
    .getRawOne();

  return maxBlock.max_block ?? 0;
}

export async function fetchAllActivity(addresses?: string[]) {
  const queryBuilder = getDataSource()
    .getRepository(AggregatedActivity)
    .createQueryBuilder('aggregatedActivity');

  if (addresses) {
    queryBuilder.where('aggregatedActivity.wallet IN (:...addresses)', {
      addresses
    });
  }

  return await queryBuilder.getMany();
}

export async function fetchAllActivityWallets(): Promise<string[]> {
  const wallets = await getDataSource()
    .getRepository(AggregatedActivity)
    .createQueryBuilder(AGGREGATED_ACTIVITY_TABLE)
    .select(`${AGGREGATED_ACTIVITY_TABLE}.wallet`, 'wallet')
    .distinct(true)
    .getRawMany();

  return wallets.map((w) => w.wallet);
}

export async function fetchAllMemesActivity(addresses?: string[]) {
  const queryBuilder = getDataSource()
    .getRepository(AggregatedActivityMemes)
    .createQueryBuilder(AGGREGATED_ACTIVITY_MEMES_TABLE);

  if (addresses) {
    queryBuilder.where(
      `${AGGREGATED_ACTIVITY_MEMES_TABLE}.wallet IN (:...addresses)`,
      { addresses }
    );
  }

  return await queryBuilder.getMany();
}

export async function persistActivity(
  activity: AggregatedActivity[],
  memesActivity: AggregatedActivityMemes[],
  reset?: boolean
) {
  logger.info({
    message: 'PERSISTING AGGREGATED ACTIVITY',
    activity: activity.length.toLocaleString(),
    memes_activity: memesActivity.length.toLocaleString(),
    reset: reset
  });

  await getDataSource().transaction(async (manager) => {
    const activityRepo = manager.getRepository(AggregatedActivity);
    const memesActivityRepo = manager.getRepository(AggregatedActivityMemes);

    if (reset) {
      await activityRepo.clear();
      await memesActivityRepo.clear();
      logger.info('[AGGREGATED ACTIVITY RESET]');
    }
    await activityRepo.upsert(activity, ['wallet']);
    await memesActivityRepo.upsert(memesActivity, ['wallet', 'season']);
  });

  logger.info('[AGGREGATED ACTIVITY PERSISTED]');
}

export async function persistConsolidatedActivity(
  activity: ConsolidatedAggregatedActivity[],
  memesActivity: ConsolidatedAggregatedActivityMemes[],
  reset?: boolean
) {
  logger.info({
    message: 'PERSISTING CONSOLIDATED AGGREGATED ACTIVITY',
    activity: activity.length.toLocaleString(),
    memes_activity: memesActivity.length.toLocaleString(),
    reset: reset
  });

  await getDataSource().transaction(async (manager) => {
    const activityRepo = manager.getRepository(ConsolidatedAggregatedActivity);
    const memesActivityRepo = manager.getRepository(
      ConsolidatedAggregatedActivityMemes
    );

    if (reset) {
      await activityRepo.clear();
      await memesActivityRepo.clear();
      logger.info('[CONSOLIDATED AGGREGATED ACTIVITY RESET]');
    }
    await activityRepo.upsert(activity, ['consolidation_key']);
    await memesActivityRepo.upsert(memesActivity, [
      'consolidation_key',
      'season'
    ]);
  });

  logger.info({
    message: '[CONSOLIDATED AGGREGATED ACTIVITY PERSISTED]'
  });
}
