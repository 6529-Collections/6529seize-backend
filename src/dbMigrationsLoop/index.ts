import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import { DataSource } from 'typeorm';
import { prepEnvironment } from '../env';
import * as Entities from '../entities/entities';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await prepEnvironment();
  const ormDs = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: Object.values(Entities),
    synchronize: true,
    logging: false
  });
  try {
    await ormDs
      .initialize()
      .then(() => {
        logger.info(`[ENTITIES SYNCHRONIZED]`);
      })
      .catch((error) => logger.error(`DB INIT ERROR: ${error}`));

    const dbmigrate = await DBMigrate.getInstance(true, {
      config: './database.json',
      env: 'main'
    });
    await dbmigrate.up();
  } finally {
    await ormDs.destroy();
  }
  logger.info(`[FINISHED]`);
});
