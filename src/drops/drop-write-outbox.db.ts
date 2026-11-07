import { DROP_WRITE_OUTBOX_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';

export type DropWriteOperation = 'CREATE' | 'UPDATE';

/**
 * A row claimed this many times without finishing is quarantined: the
 * sweeper stops retrying it and reports it once, for an operator.
 */
export const DROP_WRITE_OUTBOX_MAX_ATTEMPTS = 10;

export interface DropWriteOutboxRow {
  readonly id: number;
  readonly drop_id: string;
  readonly wave_id: string;
  readonly author_id: string;
  readonly operation: DropWriteOperation;
  readonly payload: unknown;
  readonly created_at: number;
  readonly attempts: number;
}

function toRow(raw: Record<string, unknown>): DropWriteOutboxRow {
  const payload =
    typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload;
  return {
    id: Number(raw.id),
    drop_id: String(raw.drop_id),
    wave_id: String(raw.wave_id),
    author_id: String(raw.author_id),
    operation: raw.operation as DropWriteOperation,
    payload,
    created_at: Number(raw.created_at),
    attempts: Number(raw.attempts ?? 0)
  };
}

/**
 * Storage for the post outbox (waves plan 1.8). Claims are short leases with
 * a fencing token: whoever deletes the row with its token in the same
 * transaction as the work is the one run that counts.
 */
export class DropWriteOutboxDb extends LazyDbAccessCompatibleService {
  /** Written inside the drop's own transaction; returns the row id. */
  async insert(
    row: {
      drop_id: string;
      wave_id: string;
      author_id: string;
      operation: DropWriteOperation;
      payload: unknown;
    },
    ctx: RequestContext
  ): Promise<number> {
    if (!ctx.connection) {
      throw new Error('The post outbox row must be written in the drop write');
    }
    await this.db.execute(
      `insert into ${DROP_WRITE_OUTBOX_TABLE}
         (drop_id, wave_id, author_id, operation, payload, created_at, attempts)
       values
         (:drop_id, :wave_id, :author_id, :operation, :payload, :created_at, 0)`,
      {
        ...row,
        payload: JSON.stringify(row.payload),
        created_at: Time.currentMillis()
      },
      { wrappedConnection: ctx.connection }
    );
    return this.getLastInsertId(ctx.connection);
  }

  /**
   * Takes a lease on one row in a single statement. False when the row is
   * gone (already done) or another processor holds an unexpired lease.
   */
  async claim(
    { id, token, leaseMs }: { id: number; token: string; leaseMs: number },
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const now = Time.currentMillis();
    const result = await this.db.execute(
      `update ${DROP_WRITE_OUTBOX_TABLE}
       set claimed_at = :now, claim_token = :token, attempts = attempts + 1
       where id = :id
         and (claimed_at is null or claimed_at < :expiredBefore)`,
      { id, token, now, expiredBefore: now - leaseMs },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return this.db.getAffectedRows(result) === 1;
  }

  async findById(
    id: number,
    ctx: RequestContext
  ): Promise<DropWriteOutboxRow | null> {
    const raw = await this.db.oneOrNull<Record<string, unknown>>(
      `select * from ${DROP_WRITE_OUTBOX_TABLE} where id = :id`,
      { id },
      ctx.connection
        ? { wrappedConnection: ctx.connection }
        : { forcePool: DbPoolName.WRITE }
    );
    return raw ? toRow(raw) : null;
  }

  /**
   * Ends the work: deletes the row only while `token` still holds it. Run
   * inside the work's transaction; false means the lease was lost, and the
   * caller must roll the work back.
   */
  async deleteClaimed(
    { id, token }: { id: number; token: string },
    ctx: RequestContext
  ): Promise<boolean> {
    const result = await this.db.execute(
      `delete from ${DROP_WRITE_OUTBOX_TABLE}
       where id = :id and claim_token = :token`,
      { id, token },
      { wrappedConnection: ctx.connection }
    );
    return this.db.getAffectedRows(result) === 1;
  }

  /** Gives a failed lease back early and records why, for the sweeper. */
  async releaseFailed(
    { id, token, error }: { id: number; token: string; error: string },
    ctx: RequestContext = {}
  ): Promise<void> {
    await this.db.execute(
      `update ${DROP_WRITE_OUTBOX_TABLE}
       set claimed_at = null, claim_token = null, last_error = :error
       where id = :id and claim_token = :token`,
      { id, token, error: error.slice(0, 500) },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
  }

  /** Rows the fast path has not finished: older than `olderThanMs`, unleased. */
  async findDue(
    {
      olderThanMs,
      leaseMs,
      limit
    }: { olderThanMs: number; leaseMs: number; limit: number },
    ctx: RequestContext = {}
  ): Promise<number[]> {
    const now = Time.currentMillis();
    const rows = await this.db.execute<{ id: number | string }>(
      `select id from ${DROP_WRITE_OUTBOX_TABLE}
       where created_at < :createdBefore
         and (claimed_at is null or claimed_at < :expiredBefore)
         and attempts < :maxAttempts
       order by id asc
       limit ${Math.max(1, Math.floor(limit))}`,
      {
        createdBefore: now - olderThanMs,
        expiredBefore: now - leaseMs,
        maxAttempts: DROP_WRITE_OUTBOX_MAX_ATTEMPTS
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows.map((row) => Number(row.id));
  }

  /**
   * The oldest row that is waiting on the sweeper: not leased by a live
   * processor and not quarantined. In-flight work does not count.
   */
  async oldestPendingAt(
    { leaseMs }: { leaseMs: number },
    ctx: RequestContext = {}
  ): Promise<number | null> {
    const row = await this.db.oneOrNull<{ created_at: number | null }>(
      `select min(created_at) as created_at from ${DROP_WRITE_OUTBOX_TABLE}
       where (claimed_at is null or claimed_at < :expiredBefore)
         and attempts < :maxAttempts`,
      {
        expiredBefore: Time.currentMillis() - leaseMs,
        maxAttempts: DROP_WRITE_OUTBOX_MAX_ATTEMPTS
      },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    return row?.created_at == null ? null : Number(row.created_at);
  }

  /**
   * Marks rows that used up their attempts, once their last lease is over,
   * and returns how many were newly marked, so each is reported once.
   */
  async quarantineExhausted(
    { leaseMs }: { leaseMs: number },
    ctx: RequestContext = {}
  ): Promise<number> {
    const now = Time.currentMillis();
    const result = await this.db.execute(
      `update ${DROP_WRITE_OUTBOX_TABLE}
       set quarantined_at = :now
       where attempts >= :maxAttempts
         and quarantined_at is null
         and (claimed_at is null or claimed_at < :expiredBefore)`,
      {
        now,
        expiredBefore: now - leaseMs,
        maxAttempts: DROP_WRITE_OUTBOX_MAX_ATTEMPTS
      },
      { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
    );
    return this.db.getAffectedRows(result);
  }
}

export const dropWriteOutboxDb = new DropWriteOutboxDb(dbSupplier);
