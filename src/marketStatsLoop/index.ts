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
import { marketDepthDb } from '../market-depth/market-depth.db';
import { purgeMarketDepthHistory } from '../market-depth/market-depth-retention';

const logger = Logger.get('MARKET_STATS_LOOP');
const RESERVED_COMPLETION_MS = 60_000;
const MAX_INVOCATION_WORK_MS = 13 * 60_000;
const LEGACY_BUDGET_MS = 10 * 60_000;
const RETENTION_BUDGET_MS = 4 * 60_000;

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
  await refreshThenPurge(`CONTRACT ${contract}`, contract, deadlineMs, () =>
    refreshTogether(`CONTRACT ${contract}`, [
      findNftMarketStats(contract, legacyDeadline),
      pollOpenSeaMarketDepthForContract(contract, { deadlineMs })
    ])
  );
}

async function refreshNextgen(deadlineMs: number): Promise<void> {
  const contract = NEXTGEN_CORE[mainnet.id].toLowerCase();
  await refreshThenPurge('NEXTGEN', contract, deadlineMs, () =>
    refreshTogether('NEXTGEN', [
      findNextgenMarketStats(
        contract,
        Math.min(deadlineMs, Date.now() + LEGACY_BUDGET_MS)
      ),
      pollOpenSeaMarketDepthForContract('nextgen', { deadlineMs })
    ])
  );
}

// Retention runs after the refresh, even a failed one, so a persistently
// failing provider cannot let market-depth history grow without bound.
async function refreshThenPurge(
  label: string,
  contract: string,
  deadlineMs: number,
  refresh: () => Promise<void>
): Promise<void> {
  let refreshError: unknown = null;
  try {
    await refresh();
  } catch (error) {
    refreshError = error;
  }
  try {
    await purgeMarketDepthHistory({
      contract,
      db: marketDepthDb,
      deadlineMs: Math.min(deadlineMs, Date.now() + RETENTION_BUDGET_MS)
    });
  } catch (error) {
    logger.error(`[${label}] Market-depth retention failed`, error);
    refreshError ??= error;
  }
  if (refreshError !== null) throw refreshError;
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
