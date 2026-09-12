import {
  ADDRESS_CONSOLIDATION_KEY,
  TRANSACTIONS_TABLE,
  WALLET_TRANSFER_ANALYSIS_STATES_TABLE,
  WALLET_TRANSFER_PAIR_DAYS_TABLE,
  WALLET_TRANSFER_WALLET_DAYS_TABLE
} from '@/constants';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { WalletTransferAnalysisStateEntity } from '@/entities/IWalletTransferAnalysis';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  CANDIDATE_SCAN_LIMIT,
  MAX_SOURCE_ROWS,
  PairDailySummary,
  PairMetrics,
  REPORT_QUERY_BUDGET_MS,
  SourceTransfer,
  TransferAnalysisStore,
  WalletTransferAnalysisError,
  WalletDailySummary
} from './types';

const PAIR_COLUMNS = [
  'contract',
  'bucket_start',
  'day_start',
  'from_address',
  'to_address',
  'transfer_count',
  'token_count',
  'first_transfer_at',
  'last_transfer_at',
  'sample_transaction'
];
const WALLET_COLUMNS = [
  'contract',
  'bucket_start',
  'day_start',
  'wallet',
  'outbound_count',
  'inbound_count',
  'outbound_token_count',
  'inbound_token_count'
];
const SOURCE_COLUMNS = `transaction, block,
  CAST(transaction_date AS CHAR) AS transaction_date, from_address,
  to_address, contract, token_id, token_count, value`;

const METRIC_NUMBER_COLUMNS = [
  'a_to_b_count',
  'b_to_a_count',
  'a_to_b_token_count',
  'b_to_a_token_count',
  'a_to_b_days',
  'b_to_a_days',
  'active_days',
  'first_transfer_at',
  'last_transfer_at',
  'a_outbound_count',
  'a_inbound_count',
  'b_outbound_count',
  'b_inbound_count'
] as const;
type MetricNumberColumn = (typeof METRIC_NUMBER_COLUMNS)[number];
type PairMetricsRow = Omit<PairMetrics, MetricNumberColumn> &
  Record<MetricNumberColumn, number | string | bigint>;
type StateRow = {
  contract: string;
  last_block: number | string;
  updated_at: number | string | bigint;
};

function normalizeState(row: StateRow): WalletTransferAnalysisStateEntity {
  const lastBlock = Number(row.last_block);
  const updatedAt = Number(row.updated_at);
  if (
    !Number.isSafeInteger(lastBlock) ||
    lastBlock < -1 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0
  ) {
    throw new Error('Invalid wallet transfer analysis state');
  }
  return {
    contract: row.contract,
    last_block: lastBlock,
    updated_at: updatedAt
  };
}

function normalizeMetrics(row: PairMetricsRow): PairMetrics {
  const result = { ...row } as PairMetrics;
  for (const column of METRIC_NUMBER_COLUMNS) {
    const value = Number(row[column]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid or unsafe wallet transfer metric: ${column}`);
    }
    result[column] = value;
  }
  return result;
}

function reportQueryFailure(error: unknown): never {
  if (
    error !== null &&
    typeof error === 'object' &&
    (('code' in error && error.code === 'ER_QUERY_TIMEOUT') ||
      ('errno' in error && error.errno === 3024))
  ) {
    throw new WalletTransferAnalysisError(
      `Report exceeded its ${REPORT_QUERY_BUDGET_MS} ms database budget; try a narrower report window`
    );
  }
  throw error;
}

function primaryOptions(ctx: RequestContext): DbQueryOptions {
  return { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE };
}

function requireTransaction(ctx: RequestContext): void {
  if (!ctx.connection) {
    throw new Error('Wallet transfer analysis writes require a transaction');
  }
}

function validateSourceRowLimit(maxRows: number): void {
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > MAX_SOURCE_ROWS
  ) {
    throw new Error('Source bucket row limit must be between 1 and 100000');
  }
}

const SOURCE_BUCKET_QUERY = `SELECT ${SOURCE_COLUMNS} FROM ${TRANSACTIONS_TABLE}
  WHERE contract = :contract AND block BETWEEN :start AND :end
  ORDER BY block LIMIT :limit`;

export class WalletTransferAnalysisDb
  extends LazyDbAccessCompatibleService
  implements TransferAnalysisStore
{
  private async timed<T>(
    method: string,
    ctx: RequestContext,
    work: () => Promise<T>
  ): Promise<T> {
    const timerName = `${this.constructor.name}->${method}`;
    try {
      ctx.timer?.start(timerName);
      return await work();
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async inTransaction<T>(
    work: (ctx: RequestContext) => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    return this.timed('inTransaction', ctx, async () => {
      if (ctx.connection) return work(ctx);
      return this.db.executeNativeQueriesInTransaction((connection) =>
        work({ ...ctx, connection })
      );
    });
  }

  async getState(
    contract: string,
    ctx: RequestContext
  ): Promise<WalletTransferAnalysisStateEntity | null> {
    return this.timed('getState', ctx, async () => {
      const state = await this.db.oneOrNull<StateRow>(
        `SELECT contract, last_block, updated_at
         FROM ${WALLET_TRANSFER_ANALYSIS_STATES_TABLE}
         WHERE contract = :contract`,
        { contract },
        primaryOptions(ctx)
      );
      return state ? normalizeState(state) : null;
    });
  }

  async lockState(
    contract: string,
    ctx: RequestContext
  ): Promise<WalletTransferAnalysisStateEntity> {
    return this.timed('lockState', ctx, async () => {
      requireTransaction(ctx);
      await this.db.execute(
        `INSERT INTO ${WALLET_TRANSFER_ANALYSIS_STATES_TABLE}
           (contract, last_block, updated_at)
         VALUES (:contract, -1, :updatedAt)
         ON DUPLICATE KEY UPDATE contract = :contract`,
        { contract, updatedAt: Date.now() },
        primaryOptions(ctx)
      );
      const state = await this.db.oneOrNull<StateRow>(
        `SELECT contract, last_block, updated_at
         FROM ${WALLET_TRANSFER_ANALYSIS_STATES_TABLE}
         WHERE contract = :contract FOR UPDATE`,
        { contract },
        primaryOptions(ctx)
      );
      if (!state) throw new Error('Wallet transfer analysis state is missing');
      return normalizeState(state);
    });
  }

  async getSourceBounds(
    contract: string,
    ctx: RequestContext
  ): Promise<{ minBlock: number | null; maxBlock: number | null }> {
    return this.timed('getSourceBounds', ctx, async () => {
      const bounds = await this.db.oneOrNull<{
        minBlock: number | null;
        maxBlock: number | null;
      }>(
        `SELECT MIN(block) AS minBlock, MAX(block) AS maxBlock
         FROM ${TRANSACTIONS_TABLE} WHERE contract = :contract`,
        { contract },
        primaryOptions(ctx)
      );
      return bounds ?? { minBlock: null, maxBlock: null };
    });
  }

  async findNextBlock(
    contract: string,
    afterBlock: number,
    toBlock: number,
    ctx: RequestContext
  ): Promise<number | null> {
    return this.timed('findNextBlock', ctx, async () => {
      const row = await this.db.oneOrNull<{ block: number }>(
        `SELECT block FROM ${TRANSACTIONS_TABLE}
         WHERE contract = :contract
           AND block > :afterBlock AND block <= :toBlock
         ORDER BY block ASC LIMIT 1`,
        { contract, afterBlock, toBlock },
        primaryOptions(ctx)
      );
      return row?.block ?? null;
    });
  }

  async loadBucket(
    contract: string,
    start: number,
    end: number,
    maxRows: number,
    ctx: RequestContext
  ): Promise<SourceTransfer[]> {
    return this.timed('loadBucket', ctx, async () => {
      validateSourceRowLimit(maxRows);
      return this.db.execute<SourceTransfer>(
        SOURCE_BUCKET_QUERY,
        { contract, start, end, limit: maxRows + 1 },
        primaryOptions(ctx)
      );
    });
  }

  async replaceBucket(
    contract: string,
    bucketStart: number,
    pairs: PairDailySummary[],
    wallets: WalletDailySummary[],
    advanceToBlock: number | null,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('replaceBucket', ctx, async () => {
      requireTransaction(ctx);
      if (
        [...pairs, ...wallets].some(
          (row) => row.contract !== contract || row.bucket_start !== bucketStart
        )
      ) {
        throw new Error('Derived summary does not belong to this bucket');
      }
      for (const table of [
        WALLET_TRANSFER_PAIR_DAYS_TABLE,
        WALLET_TRANSFER_WALLET_DAYS_TABLE
      ]) {
        await this.db.execute(
          `DELETE FROM ${table}
           WHERE contract = :contract AND bucket_start = :bucketStart`,
          { contract, bucketStart },
          primaryOptions(ctx)
        );
      }
      await this.db.bulkInsert(
        WALLET_TRANSFER_PAIR_DAYS_TABLE,
        pairs,
        PAIR_COLUMNS,
        ctx
      );
      await this.db.bulkInsert(
        WALLET_TRANSFER_WALLET_DAYS_TABLE,
        wallets,
        WALLET_COLUMNS,
        ctx
      );
      await this.db.execute(
        `UPDATE ${WALLET_TRANSFER_ANALYSIS_STATES_TABLE}
           SET last_block = GREATEST(last_block,
                 COALESCE(:advanceToBlock, last_block)),
               updated_at = :updatedAt
           WHERE contract = :contract`,
        { contract, advanceToBlock, updatedAt: Date.now() },
        primaryOptions(ctx)
      );
    });
  }

  async listPairMetrics(
    contract: string,
    fromDay: number | null,
    toDayExclusive: number,
    limit: number,
    ctx: RequestContext
  ): Promise<PairMetrics[]> {
    return this.timed('listPairMetrics', ctx, async () => {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > CANDIDATE_SCAN_LIMIT + 1
      ) {
        throw new Error('Pair metric limit is outside the bounded report size');
      }
      const dateFilter = `day_start < :toDayExclusive${
        fromDay === null ? '' : ' AND day_start >= :fromDay'
      }`;
      // Aggregate both directions before limiting. Wallet denominators retain
      // transfers to every counterparty, including currently consolidated ones.
      const rows = await this.db
        .execute<PairMetricsRow>(
          `WITH pair_totals AS (
           SELECT LEAST(from_address, to_address) AS wallet_a,
                  GREATEST(from_address, to_address) AS wallet_b,
                  SUM(CASE WHEN from_address < to_address
                    THEN transfer_count ELSE 0 END) AS a_to_b_count,
                  SUM(CASE WHEN from_address > to_address
                    THEN transfer_count ELSE 0 END) AS b_to_a_count,
                  SUM(CASE WHEN from_address < to_address
                    THEN token_count ELSE 0 END) AS a_to_b_token_count,
                  SUM(CASE WHEN from_address > to_address
                    THEN token_count ELSE 0 END) AS b_to_a_token_count,
                  COUNT(DISTINCT CASE WHEN from_address < to_address
                    THEN day_start END) AS a_to_b_days,
                  COUNT(DISTINCT CASE WHEN from_address > to_address
                    THEN day_start END) AS b_to_a_days,
                  COUNT(DISTINCT day_start) AS active_days,
                  MIN(first_transfer_at) AS first_transfer_at,
                  MAX(last_transfer_at) AS last_transfer_at,
                  MIN(CASE WHEN from_address < to_address
                    THEN sample_transaction END) AS sample_transaction_a_to_b,
                  MIN(CASE WHEN from_address > to_address
                    THEN sample_transaction END) AS sample_transaction_b_to_a
           FROM ${WALLET_TRANSFER_PAIR_DAYS_TABLE}
           WHERE contract = :contract AND ${dateFilter}
           GROUP BY wallet_a, wallet_b
         ), wallet_totals AS (
           SELECT wallet, SUM(outbound_count) AS outbound_count,
                  SUM(inbound_count) AS inbound_count
           FROM ${WALLET_TRANSFER_WALLET_DAYS_TABLE}
           WHERE contract = :contract AND ${dateFilter}
           GROUP BY wallet
         )
         SELECT /*+ MAX_EXECUTION_TIME(${REPORT_QUERY_BUDGET_MS}) */ p.*,
                COALESCE(a.outbound_count, 0) AS a_outbound_count,
                COALESCE(a.inbound_count, 0) AS a_inbound_count,
                COALESCE(b.outbound_count, 0) AS b_outbound_count,
                COALESCE(b.inbound_count, 0) AS b_inbound_count
         FROM pair_totals p
         LEFT JOIN wallet_totals a ON a.wallet = p.wallet_a
         LEFT JOIN wallet_totals b ON b.wallet = p.wallet_b
         LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ca ON ca.address = p.wallet_a
         LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} cb ON cb.address = p.wallet_b
         WHERE ca.consolidation_key IS NULL
            OR cb.consolidation_key IS NULL
            OR ca.consolidation_key = ''
            OR cb.consolidation_key = ''
            OR ca.consolidation_key <> cb.consolidation_key
         ORDER BY (p.a_to_b_count + p.b_to_a_count) DESC,
                  p.wallet_a ASC, p.wallet_b ASC
         LIMIT :limit`,
          { contract, fromDay, toDayExclusive, limit },
          primaryOptions(ctx)
        )
        .catch(reportQueryFailure);
      return rows.map(normalizeMetrics);
    });
  }

  async explainSourceBucket(
    contract: string,
    start: number,
    end: number,
    maxRows: number,
    ctx: RequestContext
  ): Promise<Record<string, unknown>[]> {
    return this.timed('explainSourceBucket', ctx, () => {
      validateSourceRowLimit(maxRows);
      return this.db.execute<Record<string, unknown>>(
        `EXPLAIN ${SOURCE_BUCKET_QUERY}`,
        { contract, start, end, limit: maxRows + 1 },
        primaryOptions(ctx)
      );
    });
  }
}

export const walletTransferAnalysisDb = new WalletTransferAnalysisDb(
  dbSupplier
);
