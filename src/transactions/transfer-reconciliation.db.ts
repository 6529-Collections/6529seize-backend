import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  TRANSACTIONS_TABLE,
  TRANSFER_RECONCILIATIONS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import type { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { BaseTransaction, Transaction } from '@/entities/ITransaction';

export type TransferConsumer = 'owners' | 'activity' | 'balances';
export interface PendingTransferReconciliation {
  consumer: TransferConsumer;
  wallet: string;
  revision: string;
  requested_at: number;
}

const BATCH_SIZE = 250;
const PRIMARY = { forcePool: DbPoolName.WRITE };

function requests(wallets: string[], consumers: TransferConsumer[]) {
  const revision = randomUUID();
  const requested_at = Date.now();
  return Array.from(new Set(wallets.map((wallet) => wallet.toLowerCase())))
    .sort((a, b) => a.localeCompare(b))
    .flatMap((wallet) =>
      consumers.map((consumer) => ({
        consumer,
        wallet,
        revision,
        requested_at
      }))
    );
}

export function transferWallets(transactions: BaseTransaction[]): string[] {
  return transactions.flatMap((tx) => [tx.from_address, tx.to_address]);
}

/** Use the same transaction manager that writes the transfer, never a separate commit. */
export async function enqueueTransfersWithManager(
  manager: EntityManager,
  transactions: BaseTransaction[]
): Promise<void> {
  const rows = requests(transferWallets(transactions), ['owners', 'activity']);
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(TRANSFER_RECONCILIATIONS_TABLE)
      .values(rows.slice(offset, offset + BATCH_SIZE))
      .orUpdate(['revision'], ['consumer', 'wallet'])
      .execute();
  }
}

export class TransferReconciliationDb extends LazyDbAccessCompatibleService {
  async enqueue(
    wallets: string[],
    consumers: TransferConsumer[],
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Transfer reconciliation enqueue requires a transaction');
    const timerName = 'TransferReconciliationDb->enqueue';
    ctx.timer?.start(timerName);
    try {
      await this.db.bulkUpsert(
        TRANSFER_RECONCILIATIONS_TABLE,
        requests(wallets, consumers),
        ['consumer', 'wallet', 'revision', 'requested_at'],
        ['revision'],
        ctx,
        { chunkSize: BATCH_SIZE }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async pending(
    consumer: TransferConsumer,
    ctx: RequestContext = {}
  ): Promise<PendingTransferReconciliation[]> {
    return this.query<PendingTransferReconciliation>(
      'pending',
      `SELECT consumer, wallet, revision, requested_at FROM ${TRANSFER_RECONCILIATIONS_TABLE}
       WHERE consumer = :consumer ORDER BY requested_at, wallet LIMIT :limit`,
      { consumer, limit: BATCH_SIZE },
      ctx
    );
  }

  async acknowledge(
    rows: PendingTransferReconciliation[],
    ctx: RequestContext = {}
  ): Promise<void> {
    for (const row of rows) {
      await this.query(
        'acknowledge',
        `DELETE FROM ${TRANSFER_RECONCILIATIONS_TABLE}
        WHERE consumer = :consumer AND wallet = :wallet AND revision = :revision`,
        { ...row },
        ctx
      );
    }
  }

  async enqueueRepair(
    wallets: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    if (ctx.connection)
      return this.enqueue(wallets, ['owners', 'activity'], ctx);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      await this.enqueue(wallets, ['owners', 'activity'], {
        ...ctx,
        connection
      });
    });
  }

  async publishBalances(
    wallets: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    if (ctx.connection) return this.enqueue(wallets, ['balances'], ctx);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      await this.enqueue(wallets, ['balances'], { ...ctx, connection });
    });
  }

  async maxBlock(ctx: RequestContext = {}): Promise<number> {
    const rows = await this.query<{ block: number | null }>(
      'maxBlock',
      `SELECT MAX(block) AS block FROM ${TRANSACTIONS_TABLE}`,
      {},
      ctx
    );
    return Number(rows[0]?.block ?? 0);
  }

  async changes(
    contracts: string[],
    fromBlock: number,
    toBlock: number,
    ctx: RequestContext = {}
  ): Promise<Transaction[]> {
    return this.query<Transaction>(
      'changes',
      `SELECT * FROM ${TRANSACTIONS_TABLE}
      WHERE contract IN (:contracts) AND block > :fromBlock AND block <= :toBlock`,
      { contracts, fromBlock, toBlock },
      ctx
    );
  }

  async history(
    contracts: string[],
    wallets: string[],
    toBlock: number,
    ctx: RequestContext = {}
  ): Promise<Transaction[]> {
    const result: Transaction[] = [];
    for (let offset = 0; offset < wallets.length; offset += BATCH_SIZE) {
      result.push(
        ...(await this.query<Transaction>(
          'history',
          `SELECT * FROM ${TRANSACTIONS_TABLE}
        WHERE contract IN (:contracts) AND block <= :toBlock
        AND (from_address IN (:wallets) OR to_address IN (:wallets))`,
          {
            contracts,
            wallets: wallets.slice(offset, offset + BATCH_SIZE),
            toBlock
          },
          ctx
        ))
      );
    }
    return result;
  }
  private async query<T>(
    method: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const timerName = `TransferReconciliationDb->${method}`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.execute<T>(sql, params, {
        ...PRIMARY,
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const transferReconciliationDb = new TransferReconciliationDb(
  dbSupplier
);
