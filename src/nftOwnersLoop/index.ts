import { findNftOwners } from './nft_owners';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { Time } from '../time';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('NFT_OWNERS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([MemesSeason, NFTOwner, ConsolidatedNFTOwner]);
  await findNftOwners(process.env.NFT_OWNERS_RESET === 'true');
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});
