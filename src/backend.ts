import { Logger } from './logging';
import { Time } from './time';

import * as trx from './transactionsLoop';
import * as nfts from './nftsLoop';
import * as ml from './memeLabLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await trx.handler(undefined as any, undefined as any, undefined as any);
  await nfts.handler(undefined as any, undefined as any, undefined as any);
  await ml.handler(undefined as any, undefined as any, undefined as any);
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
