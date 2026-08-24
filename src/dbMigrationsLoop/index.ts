import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { competitionRepository } from '../competitions/competition.repository';
import { contentModerationDb } from '../content-moderation/content-moderation.db';
import { Time } from '../time';

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

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const scheduledInvocation = isScheduledInvocation(event);
  logger.info(`[RUNNING]`);
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
