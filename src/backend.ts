import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');
const nftsLoop = require('./nftsLoop');
const ownersLoop = require('./ownersLoop');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
