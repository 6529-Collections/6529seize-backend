import { Logger } from './logging';
import { Time } from './time';

const logger = Logger.get('BACKEND');

const nextgenNewUploader = require('./nextgenNewUploader');
const nextgenMissingImageResolutions = require('./nextgenMissingImageResolutions');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await nextgenNewUploader.handler();
  await nextgenMissingImageResolutions.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
