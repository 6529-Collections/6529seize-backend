import { Logger } from './logging';
import { Time } from './time';
import * as delegations from './delegationsLoop';
import * as transactions from './transactionsLoop';
import * as tdh from './tdhLoop';

import cron from 'node-cron';

import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from './constants';

const logger = Logger.get('BACKEND');

let LOCKED = true;

//delegations every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  if (LOCKED) return;
  await runDelegations();
});

//transactions every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  if (LOCKED) return;
  await runTransactions();
});

async function start() {
  const start = Time.now();
  LOCKED = true;
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await dbMigrations.handler();
  // await runDelegations();
  // await runTransactions();
  await runTDH();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);

  // LOCKED = false;
}

start();

async function runDelegations() {
  LOCKED = true;
  await delegations.handler();
  LOCKED = false;
}

async function runTransactions() {
  LOCKED = true;
  await transactions.handler(MEMES_CONTRACT);
  await transactions.handler(GRADIENT_CONTRACT);
  await transactions.handler(NEXTGEN_CONTRACT);
  LOCKED = false;
}

async function runTDH() {
  LOCKED = true;
  await tdh.handler();
  LOCKED = false;
}
