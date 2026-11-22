import { Alchemy, AssetTransfersCategory, SortingOrder } from '@/alchemy-sdk';
import { ALCHEMY_SETTINGS } from '@/constants';
import { fetchLatestNftHistoryBlockNumber, persistNftHistoryBlock } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { whileRebuildingEthereumIndexes } from '@/holdings/rebuild-mode';
import { Logger } from '@/logging';
import { HISTORY_CREATORS, historyLogFilters } from './history-transactions';
import { ingestHistorySources } from './source-replay';

const logger = Logger.get('NFT_HISTORY_REBUILD');

// The widest block range one log query asks for. A provider that refuses a
// range (too many results) gets it in halves.
const LOG_RANGE_BLOCKS = 1_000_000;
// Halving stops here: one block that still fails is a real error.
const MAX_SPLITS = 24;

const hex = (block: number) => `0x${block.toString(16)}`;

async function addLogBlocks(
  filter: ReturnType<typeof historyLogFilters>[number],
  fromBlock: number,
  toBlock: number,
  blocks: Set<number>,
  splits = 0
): Promise<void> {
  try {
    const logs = await getEthereumRpcClient().getLogs({
      ...filter,
      fromBlock: hex(fromBlock),
      toBlock: hex(toBlock)
    });
    for (const log of logs) {
      if (log.removed) throw new Error('Noncanonical history source log');
      blocks.add(Number(log.blockNumber));
    }
  } catch (error) {
    if (fromBlock === toBlock || splits >= MAX_SPLITS) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    await addLogBlocks(filter, fromBlock, middle, blocks, splits + 1);
    await addLogBlocks(filter, middle + 1, toBlock, blocks, splits + 1);
  }
}

/** Blocks with a top-level call to a creator contract (setTokenURI emits no event). */
async function addCreatorCallBlocks(
  fromBlock: number,
  toBlock: number,
  blocks: Set<number>
): Promise<void> {
  const alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });
  for (const contract of HISTORY_CREATORS) {
    let pageKey: string | undefined;
    const seenPages = new Set<string>();
    do {
      const page = await alchemy.core.getAssetTransfers({
        fromBlock: hex(fromBlock),
        toBlock: hex(toBlock),
        toAddress: contract,
        category: [AssetTransfersCategory.EXTERNAL],
        excludeZeroValue: false,
        maxCount: 1000,
        order: SortingOrder.ASCENDING,
        ...(pageKey ? { pageKey } : {})
      });
      for (const transfer of page.transfers) {
        blocks.add(Number(transfer.blockNum));
      }
      pageKey = page.pageKey;
      if (pageKey && seenPages.has(pageKey))
        throw new Error('Creator call discovery returned a repeated page');
      if (pageKey) seenPages.add(pageKey);
    } while (pageKey);
  }
}

/**
 * Every block from `fromBlock` to `toBlock` that holds a history source: the
 * same logs and creator calls the loop discovers, asked for in wide ranges
 * rather than 20 blocks at a time. Ascending.
 */
export async function findHistoryBlocks(
  fromBlock: number,
  toBlock: number
): Promise<number[]> {
  const blocks = new Set<number>();
  for (const filter of historyLogFilters()) {
    for (let from = fromBlock; from <= toBlock; from += LOG_RANGE_BLOCKS) {
      const to = Math.min(from + LOG_RANGE_BLOCKS - 1, toBlock);
      await addLogBlocks(filter, from, to, blocks);
    }
  }
  await addCreatorCallBlocks(fromBlock, toBlock, blocks);
  return Array.from(blocks)
    .filter((block) => block >= fromBlock && block <= toBlock)
    .sort((a, b) => a - b);
}

export interface NftHistoryRebuildResult {
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly sourceBlocks: number;
}

/**
 * Rebuilds the NFT history tables from empty up to `toBlock`. The live loop
 * walks 1,000 blocks every 30 minutes, which from the first Meme would take
 * months; this finds the blocks that hold sources first and runs the loop's
 * own ingestion on each of them, in order, so it writes what the loop would.
 * The checkpoint ends at `toBlock`, where the live loop takes over.
 */
export async function rebuildNftHistory({
  fromBlock = 0,
  toBlock
}: {
  fromBlock?: number;
  toBlock: number;
}): Promise<NftHistoryRebuildResult> {
  const blocks = await findHistoryBlocks(fromBlock, toBlock);
  logger.info(
    `[REBUILD] [BLOCKS ${fromBlock}-${toBlock}] [${blocks.length} WITH SOURCES]`
  );
  // No Lambda deadline here; each block's ingestion still checks the budget.
  const noDeadline = () => Number.MAX_SAFE_INTEGER;
  for (const block of blocks) {
    await ingestHistorySources(
      block,
      block,
      noDeadline,
      persistNftHistoryBlock
    );
  }
  await persistNftHistoryBlock(toBlock);
  return { fromBlock, toBlock, sourceBlocks: blocks.length };
}

/**
 * The rebuild harness's step, in rebuild mode: rebuilds to the run's
 * Ethereum mark, or to the finalized block when the run names none. It
 * starts after the stored checkpoint, so a step that stopped part way (each
 * source block moves the checkpoint once it is complete) resumes where it
 * stopped instead of writing its blocks again.
 */
export async function rebuildNftHistoryStep(ctx: {
  readonly mark: { readonly ethBlock: number | null };
}): Promise<void> {
  const toBlock =
    ctx.mark.ethBlock ??
    (await getEthereumRpcClient().getBlock('finalized')).number;
  const stored = await fetchLatestNftHistoryBlockNumber();
  const fromBlock =
    stored === null || stored === undefined ? 0 : Number(stored) + 1;
  if (fromBlock > toBlock) {
    logger.info(`[REBUILD] [ALREADY AT BLOCK ${stored}] [MARK ${toBlock}]`);
    return;
  }
  await whileRebuildingEthereumIndexes(() =>
    rebuildNftHistory({ fromBlock, toBlock })
  );
}
