import { discoverEns } from '../ens';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING DISCOVER ENS LOOP]');
  await loadEnv();
  await discoverEns();
  console.log(new Date(), '[DISCOVER ENS LOOP COMPLETE]');
};
