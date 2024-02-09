import { Logger } from '../logging';
import { Time } from '../time';
import { loadEnv } from '../secrets';
import {
  NextGenCollectionBurn,
  NextGenBlock,
  NextGenLog,
  NextGenToken,
  NextGenAllowlist,
  NextGenAllowlistBurn,
  NextGenAllowlistCollection,
  NextGenCollection,
  NextGenTokenTrait,
  NextGenTokenScore
} from '../entities/INextGen';
import { findNextGenTransactions } from '../nextgen/nextgen';
import { Transaction } from '../entities/ITransaction';

const logger = Logger.get('NEXTGEN_CONTRACT_LOOP');

export const handler = async () => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([
    NextGenAllowlist,
    NextGenAllowlistBurn,
    NextGenAllowlistCollection,
    NextGenCollection,
    NextGenCollectionBurn,
    NextGenBlock,
    NextGenLog,
    NextGenToken,
    NextGenTokenTrait,
    NextGenTokenScore,
    Transaction
  ]);
  await findNextGenTransactions();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
