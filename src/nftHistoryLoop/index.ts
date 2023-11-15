import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from '../entities/INFTHistory';
import { findNFTHistory } from '../nft_history';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';

const logger = Logger.get('NFT_HISTORY_LOOP');

export const handler = async (event?: any, context?: any) => {
  await loadEnv([NFTHistory, NFTHistoryBlock, NFTHistoryClaim]);
  const force = process.env.NFT_HISTORY_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await findNFTHistory(force);
  logger.info('[COMPLETE]');
};
