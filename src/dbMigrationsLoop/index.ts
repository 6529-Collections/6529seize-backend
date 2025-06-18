import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';

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
    },
    { logger, entities: Object.values(Entities), syncEntities: true }
  );

  logger.info(`[FINISHED]`);
});
