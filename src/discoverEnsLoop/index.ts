import { discoverEns, discoverEnsDelegations } from '../ens';
import { ENS } from '../entities/IENS';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING DISCOVER ENS LOOP]');
  await loadEnv([ENS]);
  await discoverEns();
  await discoverEnsDelegations();
  await unload();
  console.log(new Date(), '[DISCOVER ENS LOOP COMPLETE]');
};
