import { Logger } from './logging';
import { Time } from './time';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import * as customReplayLoop from './customReplayLoop';
import * as aggregatedActivity from './aggregatedActivityLoop';
import * as transactions from './transactionsLoop';
import * as balances from './ownersBalancesLoop';
import * as nftOwners from './nftOwnersLoop';
import * as nfts from './nftsLoop';
import * as tdh from './tdhLoop';
import * as memelab from './memeLabLoop';
import * as delegations from './delegationsLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  await dbMigrationsLoop.handler(null, null as any, null as any);

  // await delegations.handler(null, null as any, null as any);
  // await memelab.handler(null, null as any, null as any);
  // await transactions.handler(null, null as any, null as any);
  await nftOwners.handler(null, null as any, null as any);
  // await nfts.handler(null, null as any, null as any);
  await aggregatedActivity.handler(null, null as any, null as any);
  await balances.handler(null, null as any, null as any);
  // await customReplayLoop.handler(null, null as any, null as any);
  // await tdh.handler(null, null as any, null as any);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
