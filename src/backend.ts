import { Logger } from './logging';
import { Time } from './time';

const nextgenContract = require('./nextgenContractLoop');
const nextgenMetadata = require('./nextgenMetadataLoop');
const tdhLoop = require('./tdhLoop');
const ownerMetricsLoop = require('./ownerMetricsLoop');
const ownersLoop = require('./ownersLoop');

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await nextgenContract.handler();
  // await nextgenMetadata.handler();
  // await tdhLoop.handler();
  // await ownerMetricsLoop.handler();
  // await ownersLoop.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
