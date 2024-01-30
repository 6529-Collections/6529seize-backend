import { Logger } from './logging';
import { Time } from './time';
import * as rateEventProcessingLoop from './rateEventProcessingLoop';

const nextgenContract = require('./nextgenContractLoop');
const nextgenMetadata = require('./nextgenMetadataLoop');

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await nextgenContract.handler();
  await nextgenMetadata.handler();

  const handler = null as unknown as any;
  await rateEventProcessingLoop.handler(undefined, handler, handler);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
