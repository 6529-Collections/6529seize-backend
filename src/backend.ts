// import * as dbMigrationsLoop from './dbMigrationsLoop';
import { Logger } from './logging';
import * as customReplayLoop from './customReplayLoop';
const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await dbMigrationsLoop.handler(
  //   undefined as any,
  //   undefined as any,
  //   undefined as any
  // );
  await customReplayLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  process.exit(0);
}

start();
