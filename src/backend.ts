import { Logger } from './logging';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import { prepEnvironment } from './env';
import { DataSource } from 'typeorm';
import * as customReplay from './customReplayLoop';

const logger = Logger.get('BACKEND');

async function syncAllEntities() {
  await prepEnvironment();
  const ormDs = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: ['src/entities/*.ts'],
    synchronize: true,
    logging: false
  });
  await ormDs
    .initialize()
    .catch((error) => logger.error(`DB INIT ERROR: ${error}`));
}

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await syncAllEntities();

  // await dbMigrationsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );
  await customReplay.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
  process.exit(0);
}

start();
