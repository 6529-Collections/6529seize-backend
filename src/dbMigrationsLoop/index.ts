import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { competitionRepository } from '../competitions/competition.repository';
export { handler as membershipRefreshHandler } from '../membershipRefreshLoop';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await doInDbContext(
    async () => {
      if (!appFeatures.isDbMigrateDisabled()) {
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
    },
    { logger, entities: Object.values(Entities), syncEntities: true }
  );

  logger.info(`[FINISHED]`);
});
