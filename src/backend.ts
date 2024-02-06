import { Logger } from './logging';
import { Time } from './time';
import * as rateEventProcessingLoop from './rateEventProcessingLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  const handler = null as unknown as any;
  await rateEventProcessingLoop.handler(undefined, handler, handler);
  // Uncomment to call on start

  // await nftHistory.handler();
  // await delegations.handler();
  // await transactions.handler(undefined, handler, handler);
  // await nfts.handler();
  // await owners.handler();
  // await ownerMetrics.handler();
  // await tdhConsolidations.handler();
  // await memeLab.handler();
  // await memeStats();
  // await gradientStats();
  // await memeLabStats();
  // await s3.handler();
  // await team.handler();
  // await discoverEnsLoop.handler();
  // await refreshEnsLoop.handler();
  // await royaltiesLoop.handler();
  // await transactions.handlerValues();
  // await rememes.handler();
  // await transactionsReplay.handler();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}] [SERVICE STARTED...]`);
}

start();
