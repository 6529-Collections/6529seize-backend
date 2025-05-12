import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import * as Entities from '../entities/entities';
import { doInDbContext } from '../secrets';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await doInDbContext(
    async () => {
      const dbmigrate = await DBMigrate.getInstance(true, {
        config: './database.json',
        env: 'main'
      });
      await dbmigrate.up();
    },
    { logger, entities: [Entities], syncEntities: true }
  );

  logger.info(`[FINISHED]`);
});
