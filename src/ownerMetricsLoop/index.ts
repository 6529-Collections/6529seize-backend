import { findOwnerMetrics } from '../owner_metrics';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING OWNER METRICS LOOP]');
  await loadEnv();
  await findOwnerMetrics();
  console.log(new Date(), '[OWNER METRICS LOOP COMPLETE]');
};
