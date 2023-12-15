import {
  discoverEns,
  discoverEnsConsolidations,
  discoverEnsDelegations
} from '../ens';
import { ENS } from '../entities/IENS';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';

const logger = Logger.get('DISCOVER_ENS_LOOP');

export const handler = async (event?: any, context?: any) => {
  logger.info('[RUNNING]');
  await loadEnv([ENS]);
  await discoverEns();
  await discoverEnsDelegations();
  await discoverEnsConsolidations();
  await unload();
  logger.info('[COMPLETE]');
};
