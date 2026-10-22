import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Alchemy } from '@/alchemy-sdk';
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
import type { NextgenLoopHealth } from '@/nextgenContractLoop/loop-health';

const logger = Logger.get('NEXTGEN_CONTRACT');

const BLOCK_THRESHOLD = 100000;

export async function findNextGenTransactions(health?: NextgenLoopHealth) {
  const network = getNextgenNetwork();
  const alchemy = new Alchemy({
    network: network,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const latestBlock = await getEthereumRpcClient(network).getBlockNumber();
  const dataSource = getDataSource();
  const checkpoint = await withNextgenDbLockRetry(
    async () =>
      await dataSource.transaction('REPEATABLE READ', async (entityManager) => {
        health?.beginAttempt();
        const startBlock = await fetchNextGenLatestBlock(entityManager);

        let endBlock = latestBlock;
        let blockAdjusted = false;
        const blockRange = endBlock - startBlock;
        if (blockRange > BLOCK_THRESHOLD) {
          endBlock = startBlock + BLOCK_THRESHOLD;
          logger.info(
            `[BLOCK RANGE TOO LARGE ${blockRange}] : [START BLOCK ${startBlock}] : [ADJUSTING TO ${endBlock} ] `
          );
          blockAdjusted = true;
        }

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
        await findCoreEvents(entityManager, startBlock, endBlock);

        const blockTimestamp = (
          await getEthereumRpcClient(network).getBlock(endBlock)
        ).timestamp;

        const nextgenBlock: NextGenBlock = {
          block: endBlock,
          timestamp: blockTimestamp
        };
        await persistNextGenBlock(entityManager, nextgenBlock);

        if (!blockAdjusted) {
          health?.startReconciliation();
          await processPendingMetadataTokens(entityManager, () =>
            health?.notCompleted()
          );
          await processMissingMintData(entityManager, () =>
            health?.notCompleted()
          );
          await refreshNextgenTokens(entityManager);
          await processMissingThumbnails(entityManager);
        }
        return { startBlock: Number(startBlock), endBlock, blockTimestamp };
      }),
    {
      logger,
      operation: 'nextgen-contract-block-sync'
    }
  );
  // The whole transaction (including its checkpoint) has committed. A rollback
  // or a retried transaction cannot manufacture business progress.
  health?.committed(
    checkpoint.startBlock,
    checkpoint.endBlock,
    latestBlock,
    checkpoint.blockTimestamp
  );
}
