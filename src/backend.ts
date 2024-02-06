import { Logger } from './logging';
import { Time } from './time';

const nextgenContract = require('./nextgenContractLoop');
const nextgenMetadata = require('./nextgenMetadataLoop');
const nextgenMissingImageResolutionsLoop = require('./nextgenMissingImageResolutionsLoop');
const tdhLoop = require('./tdhLoop');
const ownerMetricsLoop = require('./ownerMetricsLoop');
const ownersLoop = require('./ownersLoop');
const transactionsLoop = require('./transactionsLoop');

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await nextgenContract.handler();
  await nextgenMetadata.handler();
  await transactionsLoop.handler();
  // await nextgenMissingImageResolutionsLoop.handler();
  // await ownerMetricsLoop.handler();
  // await ownersLoop.handler();
  // await tdhLoop.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
