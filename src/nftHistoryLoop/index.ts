import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from '../entities/INFTHistory';
import { findNFTHistory } from '../nft_history';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  await loadEnv([NFTHistory, NFTHistoryBlock, NFTHistoryClaim]);
  const force = process.env.NFT_HISTORY_RESET == 'true';
  console.log('[RUNNING NFT HISTORY]', `[FORCE ${force}]`);
  await findNFTHistory(force);
  console.log('[NFT HISTORY COMPLETE]');
};
