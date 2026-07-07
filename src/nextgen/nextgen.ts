import { Alchemy } from '@/alchemy-sdk';
import { EntityManager } from 'typeorm';
import { NextGenBlock } from '../entities/INextGen';
import { findCoreEvents } from './nextgen_core_events';
import { findCoreTransactions } from './nextgen_core_transactions';
import { findMinterTransactions } from './nextgen_minter';
import { processPendingMetadataTokens } from './nextgen_pending_metadata';
import { refreshNextgenTokens } from './nextgen_tokens';
import { fetchNextGenLatestBlock, persistNextGenBlock } from './nextgen.db';
import { getDataSource } from '../db';
import { getNextgenNetwork } from './nextgen_constants';
import { Logger } from '../logging';
import { processMissingMintData } from './nextgen_pending_mint_data';
import { processMissingThumbnails } from './nextgen_pending_thumbnails';
import { withNextgenDbLockRetry } from './nextgen-db-lock-retry';

const logger = Logger.get('NEXTGEN_CONTRACT');

const BLOCK_THRESHOLD = 100000;

export async function findNextGenTransactions() {
  const network = getNextgenNetwork();
  const alchemy = new Alchemy({
    network: network,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  let endBlock = await alchemy.core.getBlockNumber();
  const dataSource = getDataSource();
  const startBlock = await fetchNextGenLatestBlock(dataSource.manager);

  let blockAdjusted = false;
  const blockRange = endBlock - startBlock;
  if (blockRange > BLOCK_THRESHOLD) {
    endBlock = startBlock + BLOCK_THRESHOLD;
    logger.info(
      `[BLOCK RANGE TOO LARGE ${blockRange}] : [START BLOCK ${startBlock}] : [ADJUSTING TO ${endBlock} ] `
    );
    blockAdjusted = true;
  }

  const blockTimestamp = (await alchemy.core.getBlock(endBlock)).timestamp;

  await withNextgenDbLockRetry(
    async () =>
      await dataSource.transaction(async (entityManager) => {
        await findCoreTransactions(
          entityManager,
          alchemy,
          startBlock,
          endBlock
        );
        await findMinterTransactions(
          entityManager,
          alchemy,
          startBlock,
          endBlock
        );
        await findCoreEvents(entityManager, alchemy, startBlock, endBlock);

        const nextgenBlock: NextGenBlock = {
          block: endBlock,
          timestamp: blockTimestamp
        };
        await persistNextGenBlock(entityManager, nextgenBlock);
      }),
    {
      logger,
      operation: 'nextgen-contract-block-sync'
    }
  );

  if (!blockAdjusted) {
    await runPostProcessingTransaction(
      'nextgen-pending-metadata',
      processPendingMetadataTokens
    );
    await runPostProcessingTransaction(
      'nextgen-missing-mint-data',
      processMissingMintData
    );
    await runPostProcessingTransaction(
      'nextgen-token-score-refresh',
      refreshNextgenTokens
    );
    await runPostProcessingTransaction(
      'nextgen-missing-thumbnails',
      processMissingThumbnails
    );
  }
}

async function runPostProcessingTransaction(
  operation: string,
  processor: (entityManager: EntityManager) => Promise<void>
): Promise<void> {
  const dataSource = getDataSource();
  await withNextgenDbLockRetry(
    async () => {
      await dataSource.transaction(processor);
    },
    {
      logger,
      operation
    }
  );
}
