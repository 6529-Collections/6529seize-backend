import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_TABLE,
  MEMELAB_CONTRACT
} from '../constants';
import { areEqualAddresses } from '../helpers';
import { DistributionNormalized } from '../entities/IDistribution';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
}
