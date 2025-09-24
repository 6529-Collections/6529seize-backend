import { sepolia } from '@wagmi/chains';
import { Alchemy, Network } from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { SubscriptionTopUp } from '../entities/ISubscription';
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
const CONFIRMATIONS = 5;

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

function enforceBounds(subs: SubscriptionTopUp[], from: number, to: number) {
  const sorted = subs.slice().sort((a, b) => a.block - b.block);

  // filter to inclusive range
  const bounded = sorted.filter((s) => s.block >= from && s.block <= to);

  // dedupe by a composite key
  const seen = new Set<string>();
  const deduped: SubscriptionTopUp[] = [];

  for (const s of bounded) {
    const key = `${s.block}:${s.hash}:${s.from_wallet}:${s.amount}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(s);
    }
  }

  return deduped;
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

  const head = await alchemy.core.getBlockNumber();
  const toBlock = head - CONFIRMATIONS;

  logger.info(
    `[HEAD ${head}] [NETWORK: ${network}] : [FROM ${fromBlock}] : [TO ${toBlock}] (finality gap=${CONFIRMATIONS})`
  );

  if (toBlock <= fromBlock) {
    logger.info(
      `[NO NEW CONFIRMED BLOCKS] [FROM ${fromBlock}] [TO ${toBlock}]`
    );
    return;
  }

  let currentFromBlock = fromBlock;
  let lastProcessedBlock = fromBlock - 1;
  let lastCheckpointBlock = latestPersistedBlock ?? fromBlock - 1;

  while (currentFromBlock <= toBlock) {
    const currentToBlock = Math.min(currentFromBlock + CHUNK_SIZE - 1, toBlock);

    logger.info(
      `[NETWORK: ${network}] : [FROM BLOCK ${currentFromBlock}] : [TO BLOCK ${currentToBlock}]`
    );

    const subscriptions: SubscriptionTopUp[] = await getAllSubscriptionTopUps(
      alchemy,
      currentFromBlock,
      currentToBlock
    );

    const boundedSubscriptions = enforceBounds(
      subscriptions,
      currentFromBlock,
      currentToBlock
    );

    logger.info(
      `[FROM BLOCK ${currentFromBlock} TO BLOCK ${currentToBlock}] ` +
        `[FOUND ${boundedSubscriptions.length}] (raw=${subscriptions.length})`
    );

    await persistTopUps(boundedSubscriptions);

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
