import { Logger } from './logging';
import { Time } from './time';

const { memeStats, memeLabStats, gradientStats } = require('./marketStatsLoop');

const cron = require('node-cron');

let RUNNING_START_SCRIPT = true;

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // Uncomment to call on start

  // await nftHistory.handler();
  // await delegations.handler();
  // await transactions.handler();
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

  RUNNING_START_SCRIPT = false;
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}] [SERVICE STARTED...]`);
}

start();
