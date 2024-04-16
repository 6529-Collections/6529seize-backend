import { Logger } from './logging';
import { Time } from './time';
import * as dbMigrations from './dbMigrationsLoop';
import * as delegations from './delegationsLoop';
import * as transactions from './transactionsLoop';
import cron from 'node-cron';
const logger = Logger.get('BACKEND');

//delegations every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  await delegations.handler();
});

//transactions every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  await transactions.handler();
});

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await dbMigrations.handler();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  logger.info(`[WAITING FOR CRON JOBS...]`);
}

start();
