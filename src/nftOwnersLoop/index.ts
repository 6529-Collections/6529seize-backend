import { updateNftOwners } from './nft_owners';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { doInDbContext } from '../secrets';

const logger = Logger.get('NFT_OWNERS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateNftOwners(process.env.NFT_OWNERS_RESET === 'true');
    },
    { logger, entities: [MemesSeason, NFTOwner, ConsolidatedNFTOwner] }
  );
});
