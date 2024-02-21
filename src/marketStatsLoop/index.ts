import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { LabNFT, NFT } from '../entities/INFT';
import { findNftMarketStats } from '../nft_market_stats';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NEXTGEN_CORE } from '../api-serverless/src/nextgen/abis';
import { mainnet } from '@wagmi/chains';
import { findNftMarketStatsOpensea } from '../nft_market_stats_opensea';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';

const logger = Logger.get('MARKET_STATS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info('[RUNNING]');
  await loadEnv([NFT, LabNFT, NextGenToken, NextGenTokenListing]);
  if (process.env.CONTRACT) {
    if (
      [MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT].includes(
        process.env.CONTRACT
      )
    ) {
      await findNftMarketStats(process.env.CONTRACT);
    } else if (process.env.CONTRACT === 'NEXTGEN') {
      await findNftMarketStatsOpensea(NEXTGEN_CORE[mainnet.id]);
    } else {
      logger.info(`[INVALID CONTRACT ${process.env.CONTRACT}]`);
    }
  } else {
    logger.info('[MISSING process.env.CONTRACT]');
  }
  await unload();
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
