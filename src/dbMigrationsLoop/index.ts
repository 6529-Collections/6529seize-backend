import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import { ActivityEventEntity } from '../entities/IActivityEvent';
import { IdentitySubscriptionEntity } from '../entities/IIdentitySubscription';
import { DataSource } from 'typeorm';
import { prepEnvironment } from '../env';
import { WaveMetricEntity } from '../entities/IWaveMetric';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

const MANAGED_ENTITIES = [
  ActivityEventEntity,
  IdentitySubscriptionEntity,
  WaveMetricEntity,
  IdentityNotificationEntity
];

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
    entities: MANAGED_ENTITIES,
    synchronize: true,
    logging: false
  });
  try {
    await ormDs.initialize().catch((error) => logger.error(error));

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
