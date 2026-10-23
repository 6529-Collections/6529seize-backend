import { JsonRpcProvider } from 'ethers';
import { TRANSACTION_SCAN_CHECKPOINTS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import { transactionsDb } from './transactions.discovery.db';

export interface ScanCheckpoint {
  block: number;
  block_hash: string;
}

export async function readScanCheckpoint(
  chain: number,
  contract: string
): Promise<ScanCheckpoint | null> {
  return sqlExecutor.oneOrNull<ScanCheckpoint>(
    `SELECT block, block_hash FROM ${TRANSACTION_SCAN_CHECKPOINTS_TABLE} WHERE chain_id = :chain AND contract = :contract`,
    { chain, contract: contract.toLowerCase() },
    { forcePool: DbPoolName.WRITE }
  );
}

// Called only after the ordinary discovery pass succeeds. The bounded rescan
// covers quiet blocks too; a maximum stored transaction cannot prove that.
export async function checkpointTransactionScan(
  chain: number,
  contract: string,
  provider: JsonRpcProvider,
  scan: (start: number, end: number) => Promise<void>
): Promise<void> {
  const block = await provider.getBlock('finalized');
  if (!block?.hash) throw new Error('Finalized indexing block is unavailable');
  const previous = await readScanCheckpoint(chain, contract);
  if (previous && Number(previous.block) >= block.number) return;
  const start = previous
    ? Number(previous.block) + 1
    : Math.min(
        block.number,
        (await transactionsDb.getLatestTransactionsBlockForContract(contract)) +
          1
      );
  await scan(start, block.number);
  const canonical = await provider.getBlock(block.number);
  if (canonical?.hash !== block.hash)
    throw new Error('Finalized indexing block changed during the scan');
  await sqlExecutor.execute(
    `INSERT INTO ${TRANSACTION_SCAN_CHECKPOINTS_TABLE} (chain_id, contract, block, block_hash, updated_at) VALUES (:chain, :contract, :block, :hash, :now) ON DUPLICATE KEY UPDATE block_hash = IF(block <= VALUES(block), VALUES(block_hash), block_hash), updated_at = IF(block <= VALUES(block), VALUES(updated_at), updated_at), block = GREATEST(block, VALUES(block))`,
    {
      chain,
      contract: contract.toLowerCase(),
      block: block.number,
      hash: block.hash,
      now: Date.now()
    }
  );
}
