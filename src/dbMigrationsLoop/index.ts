import { Logger } from '../logging';
import { prepEnvironment } from '../env';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

export const handler = async () => {
  logger.info(`[RUNNING]`);
  await prepEnvironment();
  const dbmigrate = await DBMigrate.getInstance(true, {
    config: './database.json',
    env: 'main'
  });
  await dbmigrate.up();
  logger.info(`[FINISHED]`);
};
