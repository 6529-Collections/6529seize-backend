import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { competitionRepository } from '../competitions/competition.repository';
import { contentModerationDb } from '../content-moderation/content-moderation.db';
import { Time } from '../time';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import {
  WalletTransferAnalysisStateEntity,
  WalletTransferPairDailyEntity,
  WalletTransferWalletDailyEntity
} from '@/entities/IWalletTransferAnalysis';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');
export const CONTENT_MODERATION_RETENTION_BATCH_SIZE = 1000;
export const CONTENT_MODERATION_RETENTION_MAX_BATCHES = 10;

type ContentModerationRetentionDb = Pick<
  typeof contentModerationDb,
  'deleteExpiredPrePublicationChecks'
>;

export async function deleteExpiredContentModerationChecksInBatches(
  olderThan: number,
  moderationDb: ContentModerationRetentionDb = contentModerationDb
): Promise<number> {
  let totalDeleted = 0;
  for (
    let batch = 0;
    batch < CONTENT_MODERATION_RETENTION_MAX_BATCHES;
    batch++
  ) {
    const deleted = await moderationDb.deleteExpiredPrePublicationChecks(
      olderThan,
      CONTENT_MODERATION_RETENTION_BATCH_SIZE
    );
    totalDeleted += deleted;
    if (deleted < CONTENT_MODERATION_RETENTION_BATCH_SIZE) {
      break;
    }
  }
  return totalDeleted;
}

export function isScheduledInvocation(event: unknown): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const record = event as Record<string, unknown>;
  return (
    record.source === 'aws.events' &&
    record['detail-type'] === 'Scheduled Event'
  );
}

function schemaScope(event: unknown, scheduledInvocation: boolean) {
  if (
    !event ||
    typeof event !== 'object' ||
    !Object.prototype.hasOwnProperty.call(event, 'schema_scope')
  ) {
    return 'full';
  }
  const scope = (event as { schema_scope: unknown }).schema_scope;
  if (
    scheduledInvocation ||
    (scope !== 'full' && scope !== 'wallet-transfer-analysis')
  ) {
    throw new Error('Unsupported database schema scope for this invocation');
  }
  return scope;
}

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const scheduledInvocation = isScheduledInvocation(event);
  const scope = schemaScope(event, scheduledInvocation);
  logger.info(`[RUNNING]`);
  if (scope === 'wallet-transfer-analysis') {
    await doInDbContext(async () => undefined, {
      logger,
      entities: [
        WalletTransferAnalysisStateEntity,
        WalletTransferPairDailyEntity,
        WalletTransferWalletDailyEntity
      ],
      syncEntities: true,
      skipRedis: true
    });
    logger.info('[FINISHED WALLET TRANSFER ANALYSIS SCHEMA]');
    return { schema_scope: scope };
  }
  await doInDbContext(
    async () => {
      if (!scheduledInvocation && !appFeatures.isDbMigrateDisabled()) {
        const dbmigrate = await DBMigrate.getInstance(true, {
          config: './database.json',
          env: 'main'
        });
        await dbmigrate.up();
      }
      const insertedLegacyCompetitions =
        await competitionRepository.backfillLegacyMappings({});
      logger.info(
        `Ensured immutable legacy competition mappings; inserted ${insertedLegacyCompetitions}`
      );
      const deletedModerationChecks =
        await deleteExpiredContentModerationChecksInBatches(
          Time.currentMillis() - Time.days(30).toMillis()
        );
      await moderationReviewDb.retain({});
      logger.info(
        `Deleted ${deletedModerationChecks} expired content moderation pre-publication checks`
      );
    },
    {
      logger,
      entities: Object.values(Entities),
      syncEntities: !scheduledInvocation
    }
  );

  logger.info(`[FINISHED]`);
});
