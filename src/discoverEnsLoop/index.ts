import { discoverEns } from '../ens';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING DISCOVER ENS LOOP]');
  await loadEnv();
  await discoverEns();
  await unload();
  console.log(new Date(), '[DISCOVER ENS LOOP COMPLETE]');
};
