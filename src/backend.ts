import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');
const nextgenContract = require('./nextgenContractLoop');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  await nextgenContract.handler();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
