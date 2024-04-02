import { Logger } from './logging';
import { Time } from './time';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import * as customReplayLoop from './customReplayLoop';
import * as ownerBalances from './ownersBalancesLoop';
import * as transactions from './transactionsLoop';
import * as nftsLoop from './nftsLoop';
import * as owners from './nftOwnersLoop';
import * as activity from './aggregatedActivityLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await nftsLoop.handler(null, null as any, null as any);
  await transactions.handler(null, null as any, null as any);
  // await dbMigrationsLoop.handler(null, null as any, null as any);
  // await customReplayLoop.handler(null, null as any, null as any);
  await owners.handler(null, null as any, null as any);
  await ownerBalances.handler(null, null as any, null as any);
  await activity.handler(null, null as any, null as any);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
