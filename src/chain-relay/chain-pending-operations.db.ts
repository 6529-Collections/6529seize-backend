import {
  CHAIN_PENDING_OPERATION_SIGNERS_TABLE,
  CHAIN_PENDING_OPERATIONS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

type Conn = ConnectionWrapper<any>;

export type PendingStatus = 'PENDING' | 'SUBMITTED' | 'FAILED' | 'CANCELLED';

export interface PendingSigner {
  readonly role: number;
  readonly key_type: number;
  readonly signer: string;
  readonly sig: string | null;
  readonly signed_at: number | null;
}

export interface PendingOperation {
  readonly tx_id: string;
  readonly op_type: string;
  readonly principal: string | null;
  readonly unsigned_hex: string;
  readonly typed_data_json: string;
  readonly created_by: string;
  readonly expires_at: number;
  readonly status: PendingStatus;
  readonly result_json: string | null;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly signers: PendingSigner[];
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

export class ChainPendingOperationsDb extends LazyDbAccessCompatibleService {
  /**
   * An operation and its signers. In a transaction (`conn`) the operation's
   * row is locked until it ends. Outside one it is read from the primary,
   * not a replica, so a status change (a cancel) is seen at once.
   */
  async find(txId: string, conn?: Conn): Promise<PendingOperation | null> {
    const opts = conn
      ? { wrappedConnection: conn }
      : { forcePool: DbPoolName.WRITE };
    const op = await this.db.oneOrNull<Omit<PendingOperation, 'signers'>>(
      `select * from ${CHAIN_PENDING_OPERATIONS_TABLE} where tx_id = :txId${conn ? ' for update' : ''}`,
      { txId },
      opts
    );
    if (!op) return null;
    const signers = await this.db.execute<PendingSigner>(
      `select role, key_type, signer, sig, signed_at
       from ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE}
       where tx_id = :txId order by role`,
      { txId },
      opts
    );
    return {
      ...op,
      expires_at: toNumber(op.expires_at),
      created_at: toNumber(op.created_at),
      updated_at: toNumber(op.updated_at),
      signers: signers.map((it) => ({
        ...it,
        role: toNumber(it.role),
        key_type: toNumber(it.key_type),
        signed_at: it.signed_at === null ? null : toNumber(it.signed_at)
      }))
    };
  }

  async insert(op: PendingOperation, conn: Conn) {
    await this.db.execute(
      `insert into ${CHAIN_PENDING_OPERATIONS_TABLE}
         (tx_id, op_type, principal, unsigned_hex, typed_data_json, created_by,
          expires_at, status, result_json, last_error, created_at, updated_at)
       values (:tx_id, :op_type, :principal, :unsigned_hex, :typed_data_json,
          :created_by, :expires_at, :status, :result_json, :last_error,
          :created_at, :updated_at)`,
      { ...op },
      { wrappedConnection: conn }
    );
    for (const signer of op.signers) {
      await this.db.execute(
        `insert into ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE}
           (tx_id, role, key_type, signer, sig, signed_at)
         values (:txId, :role, :key_type, :signer, :sig, :signed_at)`,
        { txId: op.tx_id, ...signer },
        { wrappedConnection: conn }
      );
    }
  }

  async setSignature(
    txId: string,
    role: number,
    sig: string,
    now: number,
    conn: Conn
  ) {
    await this.db.execute(
      `update ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE}
       set sig = :sig, signed_at = :now
       where tx_id = :txId and role = :role`,
      { txId, role, sig, now },
      { wrappedConnection: conn }
    );
  }

  /**
   * Drops the signatures an operation holds, keeping when each was given:
   * once it is withdrawn they are gone, not just hidden.
   */
  async clearSignatures(txId: string, conn: Conn) {
    await this.db.execute(
      `update ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE}
       set sig = null
       where tx_id = :txId`,
      { txId },
      { wrappedConnection: conn }
    );
  }

  /**
   * Moves an operation from status `from` to `to`. With `ifOutcome`, only
   * while its result's outcome is still that one. Returns false, changing
   * nothing, otherwise (another request moved it first).
   */
  async setStatus(
    txId: string,
    change: {
      readonly from: PendingStatus;
      readonly to: PendingStatus;
      readonly ifOutcome?: 'unknown' | 'accepted';
    },
    fields: { result_json?: string | null; last_error?: string | null },
    now: number,
    conn?: Conn
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${CHAIN_PENDING_OPERATIONS_TABLE}
       set status = :to, result_json = :result_json, last_error = :last_error,
           updated_at = :now
       where tx_id = :txId and status = :from${
         change.ifOutcome
           ? ` and json_unquote(json_extract(result_json, '$.outcome')) = :ifOutcome`
           : ''
       }`,
      {
        txId,
        from: change.from,
        to: change.to,
        ifOutcome: change.ifOutcome ?? null,
        result_json: fields.result_json ?? null,
        last_error: fields.last_error ?? null,
        now
      },
      conn ? { wrappedConnection: conn } : undefined
    );
    return this.db.getAffectedRows(result) === 1;
  }

  /** How many joins this wallet created are pending and unexpired. */
  async countOpenCreatedBy(
    wallet: string,
    now: number,
    conn: Conn
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ n: number }>(
      `select count(*) as n from ${CHAIN_PENDING_OPERATIONS_TABLE}
       where created_by = :wallet and status = 'PENDING' and expires_at > :now`,
      { wallet, now },
      { wrappedConnection: conn }
    );
    return toNumber(row?.n);
  }

  /**
   * Pending operations that still need this wallet's signature, newest
   * first, at most 50, in one query: each with its signers.
   */
  async awaiting(wallet: string, now: number): Promise<PendingOperation[]> {
    const rows = await this.db.execute<
      Omit<PendingOperation, 'signers'> & PendingSigner
    >(
      `select o.tx_id, o.op_type, o.principal, o.unsigned_hex,
              o.typed_data_json, o.created_by, o.expires_at, o.status,
              o.result_json, o.last_error, o.created_at, o.updated_at,
              s.role, s.key_type, s.signer, s.sig, s.signed_at
       from (
         select w.tx_id, w.created_at
         from ${CHAIN_PENDING_OPERATIONS_TABLE} w
         join ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE} mine
           on mine.tx_id = w.tx_id
         where mine.signer = :wallet and mine.sig is null
           and w.status = 'PENDING' and w.expires_at > :now
         order by w.created_at desc, w.tx_id
         limit 50
       ) picked
       join ${CHAIN_PENDING_OPERATIONS_TABLE} o on o.tx_id = picked.tx_id
       join ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE} s on s.tx_id = o.tx_id
       order by picked.created_at desc, picked.tx_id, s.role`,
      { wallet, now },
      { forcePool: DbPoolName.WRITE }
    );
    const ops = new Map<string, PendingOperation>();
    for (const row of rows) {
      const signer: PendingSigner = {
        role: toNumber(row.role),
        key_type: toNumber(row.key_type),
        signer: row.signer,
        sig: row.sig,
        signed_at: row.signed_at === null ? null : toNumber(row.signed_at)
      };
      const held = ops.get(row.tx_id);
      if (held) {
        held.signers.push(signer);
        continue;
      }
      ops.set(row.tx_id, {
        tx_id: row.tx_id,
        op_type: row.op_type,
        principal: row.principal,
        unsigned_hex: row.unsigned_hex,
        typed_data_json: row.typed_data_json,
        created_by: row.created_by,
        expires_at: toNumber(row.expires_at),
        status: row.status,
        result_json: row.result_json,
        last_error: row.last_error,
        created_at: toNumber(row.created_at),
        updated_at: toNumber(row.updated_at),
        signers: [signer]
      });
    }
    return Array.from(ops.values());
  }
}

export const chainPendingOperationsDb = new ChainPendingOperationsDb(
  dbSupplier
);
