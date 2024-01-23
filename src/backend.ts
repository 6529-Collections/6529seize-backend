import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');
const tdh = require('./tdhLoop');
const nfts = require('./nftsLoop');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await nfts.handler();
  await tdh.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}] [SERVICE STARTED...]`);
}

start();
