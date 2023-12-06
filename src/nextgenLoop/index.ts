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

async function loadNextGenEnv() {
  await loadEnv([
    NextGenTransactionsBlock,
    NextGenAllowlist,
    NextGenAllowlistBurn,
    NextGenCollection,
    NextGenCollectionBurn
  ]);
}
export const handler = async () => {
  logger.info('[RUNNING FIND LOOP]');
  await loadNextGenEnv();
  await findNextgenTokens();
  await unload();
  logger.info('[FIND LOOP COMPLETE]');
};

export const handlerRefresh = async () => {
  logger.info('[RUNNING REFRESH LOOP]');
  await loadNextGenEnv();
  await refreshNextgenTokens();
  await unload();
  logger.info('[REFRESH LOOP COMPLETE]');
};
