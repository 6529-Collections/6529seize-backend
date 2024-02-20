import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');
const marketStatsNextgen = require('./marketStatsLoop');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);
  await marketStatsNextgen.handler();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
