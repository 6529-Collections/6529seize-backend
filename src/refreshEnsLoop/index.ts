import { refreshEns } from '../ens';
import { ENS } from '../entities/IENS';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING REFRESH ENS LOOP]');
  await loadEnv([ENS]);
  await refreshEns();
  await unload();
  console.log(new Date(), '[REFRESH ENS LOOP COMPLETE]');
};
