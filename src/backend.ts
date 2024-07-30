import { Logger } from './logging';
import { Time } from './time';
import * as custom from './customReplayLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  const diff = start.diffFromNow().formatAsDuration();
  await custom.handler(undefined as any, undefined as any, undefined as any);

  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
