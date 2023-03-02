import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { findNftMarketStats } from '../nft_market_stats';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING NFT MARKET STATS]');
  if (process.env.CONTRACT) {
    await loadEnv();
    await findNftMarketStats(process.env.CONTRACT);
    await unload();
  } else {
    console.log('[MISSING process.env.CONTRACT]');
  }
  console.log(new Date(), '[NFT MARKET STATS COMPLETE]');
};

export const memeStats = async () => {
  await loadEnv();
  await findNftMarketStats(MEMES_CONTRACT);
  await unload();
};

export const memeLabStats = async () => {
  await loadEnv();
  await findNftMarketStats(MEMELAB_CONTRACT);
  await unload();
};

export const gradientStats = async () => {
  await loadEnv();
  await findNftMarketStats(GRADIENT_CONTRACT);
  await unload();
};
