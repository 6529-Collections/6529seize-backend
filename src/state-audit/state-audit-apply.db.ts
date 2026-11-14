import { STATE_AUDIT_JOBS_TABLE, TRANSACTIONS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import type { BaseTransaction } from '@/entities/ITransaction';
import type { StateAuditJobState } from '@/entities/IStateAuditJob';
import { refreshTransactionUsdAtWrite } from '@/eth-prices/transaction-usd';
import type { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { TRANSACTIONS_UPSERT_SQL } from '@/transactions/transactions.discovery.db';
import {
  compareLedgerRows,
  normalizeLedgerRow,
  RawLedgerRow
} from './state-audit.db';
import type { LedgerRow } from './state-audit.manifest';

const WRITE = { forcePool: DbPoolName.WRITE };

export interface StateAuditJobRow {
  job_id: string;
  plan_digest: string;
  contract: string;
  from_block: number;
  to_block: number;
  manifest_json: string;
  before_image_json: string;
  state: StateAuditJobState;
  next_index: number;
  applied_units: number;
  created_at: Date;
  updated_at: Date;
  last_error: string | null;
}

/** A ledger row to insert: the discovery column set with a decimal token id. */
export type LedgerInsert = Omit<BaseTransaction, 'token_id'> & {
  token_id: string;
};

const LEDGER_COLUMNS =
  'transaction, block, from_address, to_address, contract, token_id, token_count';
const LEDGER_KEY =
  'transaction = :transaction AND from_address = :from_address AND to_address = :to_address AND contract = :contract AND token_id = :token_id';

function keyParams(row: LedgerRow) {
  return {
    transaction: row.transaction,
    from_address: row.from_address,
    to_address: row.to_address,
    contract: row.contract,
    token_id: row.token_id
  };
}

function requireConnection(ctx: RequestContext): RequestContext {
  if (!ctx.connection) {
    throw new Error('State audit apply writes require a transaction');
  }
  return ctx;
}

/**
 * Every read here is on the write pool (the authoritative writer) and every
 * write requires the caller's transaction connection, so a unit's checks,
 * ledger corrections, reconciliation enqueue and job advance commit together.
 */
export class StateAuditApplyDb extends LazyDbAccessCompatibleService {
  async readLedgerRowsForWrite(
    contract: string,
    fromBlock: number,
    toBlock: number
  ): Promise<LedgerRow[]> {
    const rows = await this.db.execute<RawLedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM ${TRANSACTIONS_TABLE}
       WHERE contract = :contract AND block >= :fromBlock AND block <= :toBlock`,
      { contract, fromBlock, toBlock },
      WRITE
    );
    return rows.map(normalizeLedgerRow).sort(compareLedgerRows);
  }

  /** Locks the transaction's rows for the rest of the caller's transaction. */
  async lockLedgerRowsOfTransaction(
    contract: string,
    transaction: string,
    ctx: RequestContext
  ): Promise<LedgerRow[]> {
    const rows = await this.db.execute<RawLedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM ${TRANSACTIONS_TABLE}
       WHERE contract = :contract AND transaction = :transaction FOR UPDATE`,
      { contract, transaction },
      { ...WRITE, wrappedConnection: requireConnection(ctx).connection }
    );
    return rows.map(normalizeLedgerRow).sort(compareLedgerRows);
  }

  async findJob(jobId: string): Promise<StateAuditJobRow | null> {
    const rows = await this.db.execute<StateAuditJobRow>(
      `SELECT * FROM ${STATE_AUDIT_JOBS_TABLE} WHERE job_id = :jobId`,
      { jobId },
      WRITE
    );
    return rows[0] ?? null;
  }

  /** Plain insert: an existing job is never replaced or rewound. */
  async createJob(
    job: Omit<
      StateAuditJobRow,
      'state' | 'next_index' | 'applied_units' | 'last_error' | 'updated_at'
    >
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${STATE_AUDIT_JOBS_TABLE}
       (job_id, plan_digest, contract, from_block, to_block, manifest_json, before_image_json,
        state, next_index, applied_units, created_at, updated_at, last_error)
       VALUES (:job_id, :plan_digest, :contract, :from_block, :to_block, :manifest_json, :before_image_json,
        'pending', 0, 0, :created_at, :created_at, NULL)`,
      job,
      WRITE
    );
  }

  async lockJob(
    jobId: string,
    ctx: RequestContext
  ): Promise<StateAuditJobRow | null> {
    const rows = await this.db.execute<StateAuditJobRow>(
      `SELECT * FROM ${STATE_AUDIT_JOBS_TABLE} WHERE job_id = :jobId FOR UPDATE`,
      { jobId },
      { ...WRITE, wrappedConnection: requireConnection(ctx).connection }
    );
    return rows[0] ?? null;
  }

  /** Moves the cursor past `expectedIndex` in the caller's transaction. */
  async advanceJob(
    jobId: string,
    expectedIndex: number,
    state: StateAuditJobState,
    now: Date,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `UPDATE ${STATE_AUDIT_JOBS_TABLE}
       SET next_index = :nextIndex, applied_units = applied_units + 1,
           state = :state, last_error = NULL, updated_at = :now
       WHERE job_id = :jobId AND next_index = :expectedIndex AND state = 'pending'`,
      { jobId, expectedIndex, nextIndex: expectedIndex + 1, state, now },
      { ...WRITE, wrappedConnection: requireConnection(ctx).connection }
    );
  }

  /** Records a failure outside any unit transaction; never rewinds the cursor. */
  async recordJobOutcome(
    jobId: string,
    state: StateAuditJobState,
    lastError: string,
    now: Date
  ): Promise<void> {
    await this.db.execute(
      `UPDATE ${STATE_AUDIT_JOBS_TABLE}
       SET state = :state, last_error = :lastError, updated_at = :now
       WHERE job_id = :jobId AND state = 'pending'`,
      { jobId, state, lastError, now },
      WRITE
    );
  }

  /**
   * Inserts with the discovery column set and upsert statement. The USD
   * refresh mirrors discovery; the row's value, gas and royalty columns stay
   * at the discovery defaults because apply does not run value enrichment.
   */
  async insertLedgerRow(row: LedgerInsert, ctx: RequestContext): Promise<void> {
    const connection = requireConnection(ctx).connection;
    const transaction = { ...row, token_id: 0 } as BaseTransaction;
    await refreshTransactionUsdAtWrite(transaction, (query, parameters) =>
      this.db.execute(
        query.replace('?', ':timestamp'),
        { timestamp: parameters[0] },
        { ...WRITE, wrappedConnection: connection }
      )
    );
    await this.db.execute(
      TRANSACTIONS_UPSERT_SQL,
      { ...transaction, token_id: row.token_id },
      { ...WRITE, wrappedConnection: connection }
    );
  }

  async updateTokenCount(
    stored: LedgerRow,
    tokenCount: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `UPDATE ${TRANSACTIONS_TABLE} SET token_count = :tokenCount WHERE ${LEDGER_KEY}`,
      { ...keyParams(stored), tokenCount },
      { ...WRITE, wrappedConnection: requireConnection(ctx).connection }
    );
  }

  /**
   * token_id is part of the primary key, so a token id correction is a copy
   * of the stored row under the new id (keeping its value, gas and date
   * columns) followed by deletion of the old row.
   */
  async replaceTokenId(
    stored: LedgerRow,
    replacement: { token_id: string; token_count: number },
    ctx: RequestContext
  ): Promise<void> {
    const connection = requireConnection(ctx).connection;
    await this.db.execute(
      `INSERT INTO ${TRANSACTIONS_TABLE}
       (created_at, transaction, block, transaction_date, from_address, to_address, contract,
        token_id, token_count, value, royalties, gas_gwei, gas_price, gas_price_gwei, gas,
        primary_proceeds, eth_price_usd, value_usd, gas_usd)
       SELECT created_at, transaction, block, transaction_date, from_address, to_address, contract,
        :newTokenId, :newTokenCount, value, royalties, gas_gwei, gas_price, gas_price_gwei, gas,
        primary_proceeds, eth_price_usd, value_usd, gas_usd
       FROM ${TRANSACTIONS_TABLE} WHERE ${LEDGER_KEY}`,
      {
        ...keyParams(stored),
        newTokenId: replacement.token_id,
        newTokenCount: replacement.token_count
      },
      { ...WRITE, wrappedConnection: connection }
    );
    await this.deleteLedgerRow(stored, ctx);
  }

  async deleteLedgerRow(stored: LedgerRow, ctx: RequestContext): Promise<void> {
    await this.db.execute(
      `DELETE FROM ${TRANSACTIONS_TABLE} WHERE ${LEDGER_KEY}`,
      keyParams(stored),
      { ...WRITE, wrappedConnection: requireConnection(ctx).connection }
    );
  }
}

export const stateAuditApplyDb = new StateAuditApplyDb(dbSupplier);
