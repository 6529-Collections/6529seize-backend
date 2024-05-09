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
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await runTDH();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
}

start();

async function runDelegations() {
  await delegations.handler();
}

async function runTransactions() {
  await transactions.handler(MEMES_CONTRACT);
  await transactions.handler(GRADIENT_CONTRACT);
  await transactions.handler(NEXTGEN_CONTRACT);
}

async function runTDH() {
  LOCKED = true;
  await tdh.handler();
  // LOCKED = false;
}
