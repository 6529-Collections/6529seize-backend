import { Logger } from './logging';
import { Time } from './time';
import * as transactionsLoopV2 from './transactionsLoopV2';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  await transactionsLoopV2.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
