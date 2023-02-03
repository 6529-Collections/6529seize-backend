import { findNftMarketStats } from '../nft_market_stats';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING NFT MARKET STATS]');
  if (process.env.CONTRACT) {
    await loadEnv();
    await findNftMarketStats(process.env.CONTRACT);
  } else {
    console.log('[MISSING process.env.CONTRACT]');
  }
  console.log(new Date(), '[NFT MARKET STATS COMPLETE]');
};
