import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');

const nextgenNewUploader = require('./nextgenNewUploader');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await nextgenNewUploader.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
