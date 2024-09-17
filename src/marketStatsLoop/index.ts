import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { LabNFT, NFT } from '../entities/INFT';
import { findNftMarketStats } from './nft_market_stats';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NEXTGEN_CORE } from '../api-serverless/src/nextgen/abis';
import { mainnet } from '@wagmi/chains';
import { findNextgenMarketStats } from './nft_market_stats_nextgen';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';
import { doInDbContext } from '../secrets';

const logger = Logger.get('MARKET_STATS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      if (process.env.CONTRACT) {
        if (
          [MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT].includes(
            process.env.CONTRACT
          )
        ) {
          await findNftMarketStats(process.env.CONTRACT);
        } else if (process.env.CONTRACT === 'NEXTGEN') {
          await findNextgenMarketStats(NEXTGEN_CORE[mainnet.id].toLowerCase());
        } else {
          logger.info(`[INVALID CONTRACT ${process.env.CONTRACT}]`);
        }
      } else {
        logger.info('[MISSING process.env.CONTRACT]');
      }
    },
    {
      entities: [NFT, LabNFT, NextGenToken, NextGenTokenListing],
      logger
    }
  );
});

export const memeStats = async () => {
  await doInDbContext(
    async () => {
      await findNftMarketStats(MEMES_CONTRACT);
    },
    { entities: [NFT, LabNFT], logger }
  );
};

export const memeLabStats = async () => {
  await doInDbContext(
    async () => {
      await findNftMarketStats(MEMELAB_CONTRACT);
    },
    { entities: [NFT, LabNFT], logger }
  );
};

export const gradientStats = async () => {
  await doInDbContext(
    async () => {
      await findNftMarketStats(GRADIENT_CONTRACT);
    },
    { entities: [NFT, LabNFT], logger }
  );
};
