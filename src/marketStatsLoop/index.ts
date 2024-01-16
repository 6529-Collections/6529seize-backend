import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { LabNFT, NFT } from '../entities/INFT';
import { findNftMarketStats } from '../nft_market_stats';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from "../sentry.context";

const logger = Logger.get('MARKET_STATS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event?: any, context?: any) => {
  logger.info('[RUNNING]');
  if (process.env.CONTRACT) {
    await loadEnv([NFT, LabNFT]);
    await findNftMarketStats(process.env.CONTRACT);
    await unload();
  } else {
    logger.info('[MISSING process.env.CONTRACT]');
  }
  logger.info('[COMPLETE]');
});

export const memeStats = async () => {
  await loadEnv([NFT, LabNFT]);
  await findNftMarketStats(MEMES_CONTRACT);
  await unload();
};

export const memeLabStats = async () => {
  await loadEnv([NFT, LabNFT]);
  await findNftMarketStats(MEMELAB_CONTRACT);
  await unload();
};

export const gradientStats = async () => {
  await loadEnv([NFT, LabNFT]);
  await findNftMarketStats(GRADIENT_CONTRACT);
  await unload();
};
