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
import { loadEnv } from './secrets';

const logger = Logger.get('BACKEND');

let RUNNING_TDH = false;
let RUNNING_DELEGATIONS = false;
let RUNNING_TRX = false;

// delegations every 3 minutes
cron.schedule('*/3 * * * *', async () => {
  if (RUNNING_TDH || RUNNING_DELEGATIONS) {
    logger.info(
      `[SKIPPING DELEGATIONS RUN] : [RUNNING_TDH: ${RUNNING_TDH}] : [RUNNING_DELEGATIONS: ${RUNNING_DELEGATIONS}]`
    );
    return;
  }
  await runDelegations();
});

// transactions every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  if (RUNNING_TDH || RUNNING_TRX) {
    logger.info(
      `[SKIPPING TRANSACTIONS RUN] : [RUNNING_TDH: ${RUNNING_TDH}] : [RUNNING_TRX: ${RUNNING_TRX}]`
    );
    return;
  }
  await runTransactions();
});

// TDH calculations at 00:01
// cron.schedule('1 0 * * *', async () => {
cron.schedule('07 15 * * *', async () => {
  if (RUNNING_TDH) {
    logger.info(`[SKIPPING TDH RUN] : [RUNNING_TDH: ${RUNNING_TDH}]`);
    return;
  }
  await runTDH();
});

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await loadEnv();

  await runTDH();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
}

async function runDelegations(startBlock?: number) {
  RUNNING_DELEGATIONS = true;
  try {
    await delegations.handler(startBlock);
  } catch (e) {
    logger.error(`Error during delegations run: ${e}`);
  } finally {
    RUNNING_DELEGATIONS = false;
  }
}

async function runTransactions() {
  RUNNING_TRX = true;
  try {
    await transactions.handler(MEMES_CONTRACT.toLowerCase());
    await transactions.handler(GRADIENT_CONTRACT.toLowerCase());
    await transactions.handler(NEXTGEN_CONTRACT.toLowerCase());
  } catch (e) {
    logger.error(`Error during delegations run: ${e}`);
  } finally {
    RUNNING_TRX = false;
  }
}

async function runTDH() {
  RUNNING_TDH = true;
  try {
    await tdh.handler();
  } catch (e) {
    logger.error(`Error during delegations run: ${e}`);
  } finally {
    RUNNING_TDH = false;
  }
}

start();
