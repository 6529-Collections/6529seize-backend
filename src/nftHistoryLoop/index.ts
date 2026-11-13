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
import {
  parseSourceReplayRequest,
  runSourceReplay
} from '@/nft-history/source-replay';
import {
  parseHistoryRepairRequest,
  runHistoryRepair
} from '@/nft-history/history-repair';

const logger = Logger.get('NFT_HISTORY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event, context) => {
    const repair = parseHistoryRepairRequest(event);
    const sourceReplay = repair ? null : parseSourceReplayRequest(event);
    const replay = repair || sourceReplay ? null : parseReplayRequest(event);
    const remainingMillis = () => context?.getRemainingTimeInMillis() ?? 900000;
    if (replay || sourceReplay || repair) {
      return doInDbContext<unknown>(
        () => {
          if (repair) return runHistoryRepair(repair, remainingMillis);
          if (sourceReplay)
            return runSourceReplay(sourceReplay, remainingMillis);
          return runHistoryReplay(replay!, remainingMillis);
        },
        {
          logger,
          entities: [
            NFTHistory,
            NFTHistoryClaim,
            NFTHistoryEventEntity,
            NFTHistoryReplayJobEntity
          ],
          syncEntities: false,
          skipRedis: true
        }
      );
    }
    return doInDbContext(
      async () => {
        const force = process.env.NFT_HISTORY_RESET == 'true';
        logger.info(`[force=${force}]`);
        await findNFTHistory(force, undefined, undefined, remainingMillis);
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
