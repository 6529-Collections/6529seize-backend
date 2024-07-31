import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from '../entities/INFTHistory';
import { findNFTHistory } from '../nft_history';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('NFT_HISTORY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const force = process.env.NFT_HISTORY_RESET == 'true';
      logger.info(`[force=${force}]`);
      await findNFTHistory(force);
    },
    { logger, entities: [NFTHistory, NFTHistoryBlock, NFTHistoryClaim] }
  );
});
