import { Logger } from './logging';
import { Time } from './time';
import * as transactions from './transactionsLoop';

import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NEXTGEN_CONTRACT
} from './constants';

const logger = Logger.get('DIRECT_LOAD_TRX');

async function directLoad() {
  const start = Time.now();
  logger.info(
    `[CONFIG ${process.env.NODE_ENV}] [EXECUTING DIRECT DB LOAD FOR TRANSACTIONS...]`
  );

  await runTransactions();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[DIRECT DB LOAD FOR TRANSACTIONS COMPLETE IN ${diff}]`);
}

async function runTransactions() {
  await transactions.handler(MEMES_CONTRACT);
  await transactions.handler(GRADIENT_CONTRACT);
  await transactions.handler(NEXTGEN_CONTRACT);
}

directLoad();
