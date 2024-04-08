import { ObjectLiteral, Repository } from 'typeorm';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '../db';
import { TRANSACTIONS_TABLE, NULL_ADDRESS, MANIFOLD } from '../constants';
import { Transaction } from '../entities/ITransaction';
import { sqlExecutor } from '../sql-executor';

export async function getLastProcessingBlock<T extends ObjectLiteral>(
  repo: Repository<T>,
  reset?: boolean
): Promise<number> {
  if (reset) {
    return 0;
  }
  const result = await repo
    .createQueryBuilder('trxDistributionBlock')
    .select('MAX(trxDistributionBlock.block)', 'max_block')
    .getRawOne();
  return result?.max_block ?? 0;
}

export async function persistBlock<T extends ObjectLiteral>(
  repo: Repository<T>,
  tx: Transaction
) {
  const obj: any = {
    created_at: new Date(),
    block: tx.block,
    timestamp: new Date(tx.transaction_date).getTime()
  };
  await repo.save(obj);
}
