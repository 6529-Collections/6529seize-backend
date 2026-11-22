import { ethers } from 'ethers';
import { SIGNED_RECORD_HEADS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { RecordHeadKey, RecordHeadStore } from './record-index';
import type { RecordOrderKey } from './record-order';

interface HeadRow {
  readonly anchor: number | string;
  readonly claimed_time: number | string;
  readonly event_id: string;
}

const KEY_WHERE =
  'owner = :owner and family = :family and rtype = :type and rkey = :key';

export class SignedRecordHeadsDb
  extends LazyDbAccessCompatibleService
  implements RecordHeadStore
{
  private savepoints = 0;

  /**
   * In the caller's transaction, fn runs after a savepoint and, when it
   * throws, its writes are rolled back to it: a record refused part way
   * (a rule) leaves nothing, and the caller may still commit the rest.
   */
  async inTransaction<T>(
    ctx: RequestContext,
    fn: (ctx: RequestContext) => Promise<T>
  ): Promise<T> {
    if (!ctx.connection) {
      return this.executeNativeQueriesInTransaction((connection) =>
        fn({ ...ctx, connection })
      );
    }
    const options = { wrappedConnection: ctx.connection };
    const savepoint = `signed_record_${++this.savepoints}`;
    await this.db.execute(`savepoint ${savepoint}`, undefined, options);
    let result: T;
    try {
      result = await fn(ctx);
    } catch (error) {
      try {
        await this.db.execute(
          `rollback to savepoint ${savepoint}`,
          undefined,
          options
        );
      } catch {
        // The caller's transaction is failing too; its error is fn's.
      }
      throw error;
    }
    await this.db.execute(`release savepoint ${savepoint}`, undefined, options);
    return result;
  }

  /**
   * Makes sure the head row exists (a zero row below any real order key),
   * then reads it with `for update`. The insert takes the row's exclusive
   * lock even when the row exists (`on duplicate key update`, a no-op
   * there): `insert ignore` would take a shared lock, and two submits
   * holding it would deadlock at `for update`. The row lock, not a gap
   * lock, is what serializes concurrent submits for one key.
   */
  async lock(
    key: RecordHeadKey,
    ctx: RequestContext
  ): Promise<RecordOrderKey | null> {
    if (!ctx.connection) {
      throw new Error('Locking a record head needs a transaction');
    }
    const options = { wrappedConnection: ctx.connection };
    await this.db.execute(
      `insert into ${SIGNED_RECORD_HEADS_TABLE}
         (owner, family, rtype, rkey, anchor, claimed_time, event_id)
       values (:owner, :family, :type, :key, 0, 0, :zero)
       on duplicate key update anchor = anchor`,
      { ...key, zero: ethers.ZeroHash },
      options
    );
    const rows = await this.db.execute<HeadRow>(
      `select anchor, claimed_time, event_id from ${SIGNED_RECORD_HEADS_TABLE}
       where ${KEY_WHERE} for update`,
      { ...key },
      options
    );
    const row = rows[0];
    if (!row || Number(row.anchor) === 0) {
      return null;
    }
    return {
      anchor: Number(row.anchor),
      claimedTime: Number(row.claimed_time),
      eventId: row.event_id
    };
  }

  async put(
    key: RecordHeadKey,
    order: RecordOrderKey,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${SIGNED_RECORD_HEADS_TABLE}
       set anchor = :anchor, claimed_time = :claimedTime, event_id = :eventId
       where ${KEY_WHERE}`,
      { ...key, ...order },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
  }
}

export const signedRecordHeadsDb = new SignedRecordHeadsDb(dbSupplier);
