import { Logger } from './logging';
import { Time } from './time';
import * as customReplayLoop from './customReplayLoop';
import * as dbMigrationsLoop from './dbMigrationsLoop';

import * as subscriptionsLoop from './subscriptionsLoop';
import * as subscriptionsTopUpLoop from './subscriptionsTopUpLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await dbMigrationsLoop.handler(null, null as any, null as any);
  // await customReplayLoop.handler(null, null as any, null as any);

  await subscriptionsLoop.handler(null, null as any, null as any);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
