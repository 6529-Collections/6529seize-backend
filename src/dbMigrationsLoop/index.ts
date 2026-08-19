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
        await contentModerationDb.deleteExpiredPrePublicationChecks(
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
