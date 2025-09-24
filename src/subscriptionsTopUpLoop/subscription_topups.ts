import { sepolia } from '@wagmi/chains';
import { Alchemy, Network } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { Logger } from '../logging';
import { getAllSubscriptionTopUps } from './alchemy.subscriptions';
import {
  getLatestSubscriptionTopUpBlock,
  getMaxSubscriptionTopUpBlock,
  persistLatestSubscriptionTopUpBlock,
  persistTopUps
} from './db.subscriptions_topup';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP');

const CHUNK_SIZE = 150;
const CHECKPOINT_EVERY_BLOCKS = CHUNK_SIZE * 50;

async function persistLatestBlockCheckpoint(
  alchemy: Alchemy,
  blockToPersist: number
) {
  let blockTimestamp: number | undefined;
  try {
    const blockDetails = await alchemy.core.getBlock(blockToPersist);
    blockTimestamp = blockDetails?.timestamp;
  } catch (error) {
    logger.warn(
      `Unable to fetch timestamp for block ${blockToPersist}: ${(error as Error).message}`
    );
  }

  await persistLatestSubscriptionTopUpBlock(blockToPersist, blockTimestamp);
  logger.info(`[CHECKPOINT] [LATEST BLOCK UPDATED TO ${blockToPersist}]`);
}

export function getSubscriptionsNetwork(): Network {
  const chain = process.env.SUBSCRIPTIONS_CHAIN_ID;
  if (chain === sepolia.id.toString()) {
    return Network.ETH_SEPOLIA;
  }
  return Network.ETH_MAINNET;
}

export async function discoverTopUps(reset?: boolean) {
  const network = getSubscriptionsNetwork();
  const alchemy: Alchemy = getAlchemyInstance(network);

  let fromBlock = 0;
  let latestPersistedBlock: number | null = null;

  if (reset) {
    logger.info('[RESET REQUESTED] : [STARTING FROM GENESIS]');
  } else {
    latestPersistedBlock = await getLatestSubscriptionTopUpBlock();

    if (latestPersistedBlock === null) {
      const fallbackBlock = await getMaxSubscriptionTopUpBlock();
      fromBlock = fallbackBlock ? fallbackBlock + 1 : 0;
      logger.info(
        `[NO LATEST BLOCK FOUND] : [FALLBACK TO MAX TOP UP BLOCK ${fallbackBlock}] : [STARTING FROM ${fromBlock}]`
      );
      latestPersistedBlock = fallbackBlock;
    } else {
      fromBlock = latestPersistedBlock + 1;
      logger.info(
        `[USING LATEST STORED BLOCK ${latestPersistedBlock}] : [STARTING FROM ${fromBlock}]`
      );
    }
  }

  const toBlock = await alchemy.core.getBlockNumber();

  logger.info(
    `[NETWORK: ${network}] : [FROM BLOCK ${fromBlock}] : [TO BLOCK ${toBlock}]`
  );

  let currentFromBlock = fromBlock;
  let lastProcessedBlock = fromBlock - 1;
  let lastCheckpointBlock = latestPersistedBlock ?? fromBlock - 1;

  while (currentFromBlock <= toBlock) {
    const currentToBlock = Math.min(currentFromBlock + CHUNK_SIZE - 1, toBlock);

    logger.info(
      `[NETWORK: ${network}] : [FROM BLOCK ${currentFromBlock}] : [TO BLOCK ${currentToBlock}]`
    );

    const subscriptions = await getAllSubscriptionTopUps(
      alchemy,
      currentFromBlock,
      currentToBlock
    );

    logger.info(
      `[FROM BLOCK ${currentFromBlock} TO BLOCK ${currentToBlock}] [FOUND ${subscriptions.length} NEW TOP UPS]`
    );

    await persistTopUps(subscriptions);

    lastProcessedBlock = currentToBlock;
    currentFromBlock = currentToBlock + 1;

    // Persist progress periodically, but not on every chunk
    if (currentToBlock - lastCheckpointBlock >= CHECKPOINT_EVERY_BLOCKS) {
      await persistLatestBlockCheckpoint(alchemy, currentToBlock);
      lastCheckpointBlock = currentToBlock;
    }
  }

  const blockCandidates = [lastProcessedBlock, 0];
  if (latestPersistedBlock !== null) {
    blockCandidates.push(latestPersistedBlock);
  }
  const blockToPersist = Math.max(...blockCandidates);

  // Final checkpoint after processing all chunks (ensures we persist even if we never hit an interval boundary)
  await persistLatestBlockCheckpoint(alchemy, blockToPersist);
}
