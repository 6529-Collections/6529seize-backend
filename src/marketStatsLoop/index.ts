import { mainnet } from '@wagmi/chains';
import { NEXTGEN_CORE } from '../api-serverless/src/nextgen/abis';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import {
  NextGenCollection,
  NextGenToken,
  NextGenTokenListing
} from '../entities/INextGen';
import { LabNFT, NFT } from '../entities/INFT';
import {
  MarketDepthCollectionStateEntity,
  MarketDepthCurrentOrderEntity,
  MarketDepthCursorEntity,
  MarketDepthEventEntity,
  MarketDepthSnapshotEntity
} from '../entities/IMarketDepth';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { findNftMarketStats } from './nft_market_stats';
import { findNextgenMarketStats } from './nft_market_stats_nextgen';
import { pollOpenSeaMarketDepthForContract } from '../market-depth/opensea-poller';

const logger = Logger.get('MARKET_STATS_LOOP');
const RESERVED_COMPLETION_MS = 60_000;
const MAX_INVOCATION_WORK_MS = 13 * 60_000;
const LEGACY_BUDGET_MS = 10 * 60_000;

const batchContracts = new Set(
  [MEMES_CONTRACT, MEMELAB_CONTRACT, GRADIENT_CONTRACT].map((c) =>
    c.toLowerCase()
  )
);

function combinedFailure(label: string, failures: unknown[]): Error {
  return new Error(
    `${label}: ${failures
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ')}`
  );
}

async function refreshStaticContract(
  contract: string,
  deadlineMs: number
): Promise<void> {
  const legacyDeadline = Math.min(deadlineMs, Date.now() + LEGACY_BUDGET_MS);
  await refreshTogether(`CONTRACT ${contract}`, [
    findNftMarketStats(contract, legacyDeadline),
    pollOpenSeaMarketDepthForContract(contract, { deadlineMs })
  ]);
}

async function refreshNextgen(deadlineMs: number): Promise<void> {
  await refreshTogether('NEXTGEN', [
    findNextgenMarketStats(
      NEXTGEN_CORE[mainnet.id].toLowerCase(),
      Math.min(deadlineMs, Date.now() + LEGACY_BUDGET_MS)
    ),
    pollOpenSeaMarketDepthForContract('nextgen', { deadlineMs })
  ]);
}

async function refreshTogether(
  label: string,
  tasks: Promise<unknown>[]
): Promise<void> {
  // Both tasks must finish before doInDbContext disconnects their database.
  const results = await Promise.allSettled(tasks);
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const task = index === 0 ? 'Legacy market stats' : 'Market-depth refresh';
    logger.error(`[${label}] ${task} failed`, result.reason);
    return [result.reason];
  });
  if (failures.length > 0)
    throw combinedFailure('Market refresh failed', failures);
}

export const handler = sentryContext.wrapLambdaHandler(
  async (
    _event: unknown,
    context: { getRemainingTimeInMillis?: () => number }
  ) => {
    const remainingMs = context?.getRemainingTimeInMillis?.() ?? 15 * 60_000;
    const deadlineMs =
      Date.now() +
      Math.max(
        1,
        Math.min(MAX_INVOCATION_WORK_MS, remainingMs - RESERVED_COMPLETION_MS)
      );
    await doInDbContext(
      async () => {
        const envContract = process.env.MARKET_STATS_CONTRACT?.toLowerCase();
        if (envContract) {
          if (batchContracts.has(envContract)) {
            await refreshStaticContract(envContract, deadlineMs);
          } else if (envContract === 'nextgen') {
            await refreshNextgen(deadlineMs);
          } else {
            logger.info(`[INVALID CONTRACT ${envContract}]`);
          }
        } else {
          logger.info('[MISSING process.env.MARKET_STATS_CONTRACT]');
        }
      },
      {
        entities: [
          NFT,
          LabNFT,
          NextGenCollection,
          NextGenToken,
          NextGenTokenListing,
          MarketDepthSnapshotEntity,
          MarketDepthCollectionStateEntity,
          MarketDepthCurrentOrderEntity,
          MarketDepthEventEntity,
          MarketDepthCursorEntity
        ],
        logger
      }
    );
  }
);

export const memeStats = async () => {
  const deadlineMs = Date.now() + MAX_INVOCATION_WORK_MS;
  await doInDbContext(
    async () => {
      await refreshStaticContract(MEMES_CONTRACT, deadlineMs);
    },
    {
      entities: [
        NFT,
        LabNFT,
        MarketDepthSnapshotEntity,
        MarketDepthCollectionStateEntity,
        MarketDepthCurrentOrderEntity,
        MarketDepthEventEntity,
        MarketDepthCursorEntity
      ],
      logger
    }
  );
};

export const memeLabStats = async () => {
  const deadlineMs = Date.now() + MAX_INVOCATION_WORK_MS;
  await doInDbContext(
    async () => {
      await refreshStaticContract(MEMELAB_CONTRACT, deadlineMs);
    },
    {
      entities: [
        NFT,
        LabNFT,
        MarketDepthSnapshotEntity,
        MarketDepthCollectionStateEntity,
        MarketDepthCurrentOrderEntity,
        MarketDepthEventEntity,
        MarketDepthCursorEntity
      ],
      logger
    }
  );
};

export const gradientStats = async () => {
  const deadlineMs = Date.now() + MAX_INVOCATION_WORK_MS;
  await doInDbContext(
    async () => {
      await refreshStaticContract(GRADIENT_CONTRACT, deadlineMs);
    },
    {
      entities: [
        NFT,
        LabNFT,
        MarketDepthSnapshotEntity,
        MarketDepthCollectionStateEntity,
        MarketDepthCurrentOrderEntity,
        MarketDepthEventEntity,
        MarketDepthCursorEntity
      ],
      logger
    }
  );
};
