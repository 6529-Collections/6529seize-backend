import { mainnet } from '@wagmi/chains';
import { NEXTGEN_CORE } from '../api-serverless/src/nextgen/abis';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { NextGenToken, NextGenTokenListing } from '../entities/INextGen';
import { LabNFT, NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { findNftMarketStats } from './nft_market_stats';
import { findNextgenMarketStats } from './nft_market_stats_nextgen';

const logger = Logger.get('MARKET_STATS_LOOP');

const batchContracts = new Set(
  [MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT].map((c) =>
    c.toLowerCase()
  )
);

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const envContract = process.env.MARKET_STATS_CONTRACT?.toLowerCase();
      if (envContract) {
        if (batchContracts.has(envContract)) {
          await findNftMarketStats(envContract);
        } else if (envContract === 'nextgen') {
          await findNextgenMarketStats(NEXTGEN_CORE[mainnet.id].toLowerCase());
        } else {
          logger.info(`[INVALID CONTRACT ${envContract}]`);
        }
      } else {
        logger.info('[MISSING process.env.MARKET_STATS_CONTRACT]');
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
