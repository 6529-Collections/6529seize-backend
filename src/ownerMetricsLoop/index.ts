import { findOwnerMetrics } from '../owner_metrics';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log('[RUNNING OWNER METRICS LOOP]');
  await loadEnv();
  await findOwnerMetrics(process.env.RESET == 'true');
  await unload();
  console.log('[OWNER METRICS LOOP COMPLETE]');
};
