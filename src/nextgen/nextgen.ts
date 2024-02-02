import { Alchemy } from 'alchemy-sdk';
import { NextGenBlock } from '../entities/INextGen';
import { findCoreEvents } from './nextgen_core_events';
import { findCoreTransactions } from './nextgen_core_transactions';
import { findMinterTransactions } from './nextgen_minter';
import { processPendingTokens } from './nextgen_pending';
import { refreshNextgenTokens } from './nextgen_tokens';
import { fetchNextGenLatestBlock, persistNextGenBlock } from './nextgen.db';
import { getDataSource } from '../db';
import { getNextgenNetwork } from './nextgen_constants';

export async function findNextGenTransactions() {
  const alchemy = new Alchemy({
    network: getNextgenNetwork(),
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const endBlock = await alchemy.core.getBlockNumber();
  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const startBlock = await fetchNextGenLatestBlock(entityManager);

    await findCoreTransactions(entityManager, alchemy, startBlock, endBlock);
    await findMinterTransactions(entityManager, alchemy, startBlock, endBlock);
    await findCoreEvents(entityManager, alchemy, startBlock, endBlock);

    const blockTimestamp = (await alchemy.core.getBlock(endBlock)).timestamp;

    const nextgenBlock: NextGenBlock = {
      block: endBlock,
      timestamp: blockTimestamp
    };
    await persistNextGenBlock(entityManager, nextgenBlock);

    await processPendingTokens(entityManager);
    await refreshNextgenTokens(entityManager);
  });
}
