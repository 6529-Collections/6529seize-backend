import { Logger } from './logging';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import * as externalCollectionLiveTailingLoop from './externalCollectionLiveTailingLoop';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
  await externalCollectionLiveTailingLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
  process.exit(0);
}

start();
