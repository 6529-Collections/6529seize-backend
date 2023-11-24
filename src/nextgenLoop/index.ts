import { loadEnv, unload } from '../secrets';
import {
  NextGenTransactionsBlock,
  NextGenAllowlist,
  NextGenCollection,
  NextGenAllowlistBurn,
  NextGenCollectionBurn
} from '../entities/INextGen';
import { findNextgenTokens, refreshNextgenTokens } from '../nextgen';
import { Logger } from '../logging';

const logger = Logger.get('NEXTGEN_LOOP');

export const handler = async () => {
  logger.info('[RUNNING NEXTGEN LOOP]');
  await loadEnv([
    NextGenTransactionsBlock,
    NextGenAllowlist,
    NextGenAllowlistBurn,
    NextGenCollection,
    NextGenCollectionBurn
  ]);
  await findNextgenTokens();
  // await refreshNextgenTokens();
  await unload();
  logger.info('[NEXTGEN LOOP COMPLETE]');
};

export const handlerRefresh = async () => {};
