import { NFTHistory, NFTHistoryBlock } from '../entities/INFTHistory';
import { findNFTHistory } from '../nft_history';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log('[RUNNING NFT HISTORY]');
  await loadEnv([NFTHistory, NFTHistoryBlock]);
  await findNFTHistory();
  console.log('[NFT HISTORY COMPLETE]');
};
