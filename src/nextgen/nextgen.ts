import { Alchemy } from 'alchemy-sdk';
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
  await dataSource.transaction(async (entityManager) => {
    const startBlock = await fetchNextGenLatestBlock(entityManager);

    let blockAdjusted = false;
    const blockRange = endBlock - startBlock;
    if (blockRange > BLOCK_THRESHOLD) {
      endBlock = startBlock + BLOCK_THRESHOLD;
      logger.info(
        `[BLOCK RANGE TOO LARGE ${blockRange}] : [START BLOCK ${startBlock}] : [ADJUSTING TO ${endBlock} ] `
      );
      blockAdjusted = true;
    }

    await findCoreTransactions(entityManager, alchemy, startBlock, endBlock);
    await findMinterTransactions(entityManager, alchemy, startBlock, endBlock);
    await findCoreEvents(entityManager, alchemy, startBlock, endBlock);

    const blockTimestamp = (await alchemy.core.getBlock(endBlock)).timestamp;

    const nextgenBlock: NextGenBlock = {
      block: endBlock,
      timestamp: blockTimestamp
    };
    await persistNextGenBlock(entityManager, nextgenBlock);

    if (!blockAdjusted) {
      await processPendingMetadataTokens(entityManager);
      await processMissingMintData(entityManager);
      await refreshNextgenTokens(entityManager);
      await processMissingThumbnails(entityManager);
    }
  });
}
