import { Alchemy } from 'alchemy-sdk';
import { NEXTGEN_NETWORK } from '../constants';
import { fetchNextGenLatestBlock, persistNextGenBlock } from '../db';
import { NextGenBlock } from '../entities/INextGen';
import { findCoreEvents } from './nextgen_core_events';
import { findCoreTransactions } from './nextgen_core_transactions';
import { findMinterTransactions } from './nextgen_minter';
import { processPendingTokens } from './nextgen_pending';

export async function findNextGenTransactions() {
  const alchemy = new Alchemy({
    network: NEXTGEN_NETWORK,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const startBlock = await fetchNextGenLatestBlock();
  const endBlock = await alchemy.core.getBlockNumber();

  await findCoreTransactions(alchemy, startBlock, endBlock, undefined);
  await findMinterTransactions(alchemy, startBlock, endBlock, undefined);
  await findCoreEvents(alchemy, startBlock, endBlock, undefined);

  const blockTimestamp = (await alchemy.core.getBlock(endBlock)).timestamp;

  const nextgenBlock: NextGenBlock = {
    block: endBlock,
    timestamp: blockTimestamp
  };
  await persistNextGenBlock(nextgenBlock);

  await processPendingTokens();
}
