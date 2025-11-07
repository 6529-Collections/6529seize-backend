import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';
import * as nftsLoop from './nftsLoop';
import * as ownersBalancesLoop from './ownersBalancesLoop';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await nftsLoop.handler(
    {
      mode: 'discover'
    },
    undefined as any,
    undefined as any
  );

  await nftsLoop.handler(
    {
      mode: 'refresh'
    },
    undefined as any,
    undefined as any
  );

  await ownersBalancesLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  await nftsLoop.handler(
    {
      mode: 'refresh'
    },
    undefined as any,
    undefined as any
  );

  process.exit(0);
}

start();
