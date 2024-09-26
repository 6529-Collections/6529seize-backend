import { Logger } from './logging';
import * as dbMigrationsLoop from './dbMigrationsLoop';
import * as tdh from './tdhLoop';
import * as nfts from './nftsLoop';
import * as owners from './nftOwnersLoop';
import * as marketStats from './marketStatsLoop';
import * as memeLab from './memeLabLoop';
import * as pushNotificationsHandler from './pushNotificationsHandler';
const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await owners.handler(null as any, null as any, null as any);
  // await nfts.handler(null as any, null as any, null as any);

  // await tdh.handler(null as any, null as any, null as any);
  // await marketStats.handler(null as any, null as any, null as any);
  // await memeLab.handler(null as any, null as any, null as any);
  // await nfts.handler(null as any, null as any, null as any);
  await pushNotificationsHandler.handler(null as any, null as any, null as any);

  process.exit(0);
}

start();
