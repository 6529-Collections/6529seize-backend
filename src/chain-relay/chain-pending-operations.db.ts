import {
  CHAIN_PENDING_OPERATION_SIGNERS_TABLE,
  CHAIN_PENDING_OPERATIONS_TABLE
} from '@/constants';
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
  async find(txId: string, conn?: Conn): Promise<PendingOperation | null> {
    const opts = conn ? { wrappedConnection: conn } : undefined;
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

  async setStatus(
    txId: string,
    status: PendingStatus,
    fields: { result_json?: string | null; last_error?: string | null },
    now: number,
    conn?: Conn
  ) {
    await this.db.execute(
      `update ${CHAIN_PENDING_OPERATIONS_TABLE}
       set status = :status, result_json = :result_json, last_error = :last_error,
           updated_at = :now
       where tx_id = :txId`,
      {
        txId,
        status,
        result_json: fields.result_json ?? null,
        last_error: fields.last_error ?? null,
        now
      },
      conn ? { wrappedConnection: conn } : undefined
    );
  }

  /** Pending operations that still need this wallet's signature. */
  async awaiting(wallet: string, now: number): Promise<string[]> {
    const rows = await this.db.execute<{ tx_id: string }>(
      `select o.tx_id
       from ${CHAIN_PENDING_OPERATIONS_TABLE} o
       join ${CHAIN_PENDING_OPERATION_SIGNERS_TABLE} s on s.tx_id = o.tx_id
       where s.signer = :wallet and s.sig is null
         and o.status = 'PENDING' and o.expires_at > :now
       order by o.created_at desc
       limit 50`,
      { wallet, now }
    );
    return rows.map((it) => it.tx_id);
  }
}

export const chainPendingOperationsDb = new ChainPendingOperationsDb(
  dbSupplier
);
