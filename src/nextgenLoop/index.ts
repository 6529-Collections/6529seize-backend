import { loadEnv, unload } from '../secrets';
import {
  NextGenTransactionsBlock,
  NextGenAllowlist,
  NextGenCollection
} from '../entities/INextGen';
import { findNextgenTokens, refreshNextgenTokens } from '../nextgen';

export const handler = async () => {
  console.log(new Date(), '[RUNNING NEXTGEN LOOP]');
  await loadEnv([
    NextGenTransactionsBlock,
    NextGenAllowlist,
    NextGenCollection
  ]);
  await findNextgenTokens();
  await refreshNextgenTokens();
  await unload();
  console.log(new Date(), '[NEXTGEN LOOP COMPLETE]');
};

export const handlerRefresh = async () => {};
