import { TDH_NFT_TABLE } from '@/constants';
import { fetchLatestNftHistoryBlockNumber, getDataSource } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Logger } from '@/logging';
import { fetchNextGenLatestBlock } from '@/nextgen/nextgen.db';
import { RebuildContext } from '@/rebuild/manifest.types';
import { sqlExecutor } from '@/sql-executor';
import { rebuildWalletTransferAnalysis } from '@/wallet-transfer-analysis/wallet-transfer-rebuild';
import { rebuildHoldings } from './holdings-seed';

const logger = Logger.get('HOLDINGS_CATCH_UP');

/**
 * The rebuild check's last seed for holdings (step `holdings.catch-up`),
 * run after every other seed. Seeds that run after holdings.seed may mine
 * blocks, and the rebuild later indexes to the block they leave, so the
 * seeded tables must reach it too. This runs holdings' own steps again to
 * the run's Ethereum mark (else the finalized block): transactions, NextGen,
 * NFT history and the wallet transfer analysis resume from their cursors, as
 * the live loops do on their next run, and the owners, the catalogue,
 * activity and balances are recomputed by reset, as in the seed.
 *
 * NFT history and NextGen record every block they scan, events or not, so
 * when both cursors are at the mark nothing is new and it writes nothing.
 *
 * It must run before TDH's seed, as holdings.ethereum runs before TDH's
 * rebuilder: the NFT catalogue ranks the Memes from tdh_nft when that table
 * has rows, and the rebuild's catalogue finds it empty. A catch-up that
 * finds tdh_nft filled fails instead of seeding ranks the rebuild can't
 * give.
 */
export async function catchUpHoldings(ctx: RebuildContext): Promise<void> {
  const mark =
    ctx.mark.ethBlock ??
    (await getEthereumRpcClient().getBlock('finalized')).number;
  const [history, nextGen] = await Promise.all([
    fetchLatestNftHistoryBlockNumber(),
    fetchNextGenLatestBlock(getDataSource().manager)
  ]);
  const behind = [history, nextGen].some(
    (cursor) => cursor === null || cursor === undefined || Number(cursor) < mark
  );
  if (!behind) {
    logger.info(`[NOTHING NEW] [CURSORS AT ${mark}]`);
    return;
  }
  const tdhRows = await sqlExecutor.execute<{ found: number }>(
    `SELECT 1 AS found FROM ${TDH_NFT_TABLE} LIMIT 1`
  );
  if (tdhRows.length) {
    throw new Error(
      `${TDH_NFT_TABLE} has rows: TDH's seed ran before holdings.catch-up, so the catalogue would rank by TDH where the rebuild, which runs before TDH's, can't`
    );
  }
  logger.info(
    `[CATCHING UP] [NFT HISTORY AT ${history}] [NEXTGEN AT ${nextGen}] [TO ${mark}]`
  );
  await rebuildHoldings(ctx);
  await rebuildWalletTransferAnalysis();
}
