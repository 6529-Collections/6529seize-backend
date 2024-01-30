import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');

const nftsLoop = require('./nftsLoop');
const ownersLoop = require('./ownersLoop');
const ownerMetricsLoop = require('./ownerMetricsLoop');
const tdhLoop = require('./tdhLoop');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  // await nftsLoop.handler();
  await ownersLoop.handler();
  await ownerMetricsLoop.handler();
  // await tdhLoop.handler();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}] [SERVICE STARTED...]`);
}

start();
