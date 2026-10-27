import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from '../entities/INFTHistory';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';
import { findNFTHistory } from '../nft_history';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { parseReplayRequest } from '@/nft-history/replay-request';
import { runHistoryReplay } from '@/nft-history/replay';

const logger = Logger.get('NFT_HISTORY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event, context) => {
    const replay = parseReplayRequest(event);
    if (replay) {
      return doInDbContext(
        () =>
          runHistoryReplay(
            replay,
            () => context?.getRemainingTimeInMillis() ?? 900000
          ),
        {
          logger,
          entities: [
            NFTHistory,
            NFTHistoryClaim,
            NFTHistoryEventEntity,
            NFTHistoryReplayJobEntity
          ],
          skipRedis: true
        }
      );
    }
    return doInDbContext(
      async () => {
        const force = process.env.NFT_HISTORY_RESET == 'true';
        logger.info(`[force=${force}]`);
        await findNFTHistory(force);
      },
      {
        logger,
        entities: [
          NFTHistory,
          NFTHistoryBlock,
          NFTHistoryClaim,
          NFTHistoryEventEntity
        ]
      }
    );
  }
);
