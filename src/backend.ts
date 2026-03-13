import * as subscriptionsDaily from './subscriptionsDaily';
import { Logger } from './logging';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await subscriptionsDaily.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  process.exit(0);
}

start();
