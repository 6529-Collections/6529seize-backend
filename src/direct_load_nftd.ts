import { Logger } from './logging';
import { Time } from './time';
import * as delegations from './delegationsLoop';

const logger = Logger.get('DIRECT_LOAD_NFTD');

async function directLoad() {
  const start = Time.now();
  logger.info(
    `[CONFIG ${process.env.NODE_ENV}] [EXECUTING DIRECT DB LOAD FOR NFTD...]`
  );

  await runDelegations(0);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[DIRECT DB LOAD FOR NFTD COMPLETE IN ${diff}]`);
}

async function runDelegations(startBlock?: number) {
  await delegations.handler(startBlock);
}

directLoad();
