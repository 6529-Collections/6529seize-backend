import { Logger } from '../logging';
import { Time } from '../time';
import { loadEnv } from '../secrets';
import {
  NextGenCollectionBurn,
  NextGenBlock,
  NextGenLog,
  NextGenToken,
  NextGenTransaction
} from '../entities/INextGen';
import { findNextGenTransactions } from '../nextgen/nextgen';

const logger = Logger.get('NEXTGEN');

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([
    NextGenCollectionBurn,
    NextGenBlock,
    NextGenLog,
    NextGenToken,
    NextGenTransaction
  ]);
  await findNextGenTransactions();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
