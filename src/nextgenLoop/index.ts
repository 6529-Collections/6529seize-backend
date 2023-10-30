import { loadEnv, unload } from '../secrets';
import {
  NextGenTransactionsBlock,
  NextGenAllowlist,
  NextGenCollection
} from '../entities/INextGen';
import { findNextgenTokens } from '../nextgen';

export const handler = async () => {
  console.log(new Date(), '[RUNNING NEXTGEN LOOP]');
  await loadEnv([
    NextGenTransactionsBlock,
    NextGenAllowlist,
    NextGenCollection
  ]);
  await findNextgenTokens();
  await unload();
  console.log(new Date(), '[NEXTGEN LOOP COMPLETE]');
};
