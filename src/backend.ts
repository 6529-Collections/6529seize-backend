import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');

import * as customReplayLoop from './customReplayLoop';
import * as nextgenContractLoop from './nextgenContractLoop';

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await nextgenContractLoop.handler(null, null as any, null as any);
  await customReplayLoop.handler(null, null as any, null as any);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
