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

export class SignedRecordHeadsDb
  extends LazyDbAccessCompatibleService
  implements RecordHeadStore
{
  async get(
    key: RecordHeadKey,
    ctx: RequestContext
  ): Promise<RecordOrderKey | null> {
    const rows = await this.db.execute<HeadRow>(
      `select anchor, claimed_time, event_id from ${SIGNED_RECORD_HEADS_TABLE}
       where owner = :owner and family = :family and rtype = :type and rkey = :key`,
      { ...key },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    const row = rows[0];
    return row
      ? {
          anchor: Number(row.anchor),
          claimedTime: Number(row.claimed_time),
          eventId: row.event_id
        }
      : null;
  }

  async put(
    key: RecordHeadKey,
    order: RecordOrderKey,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${SIGNED_RECORD_HEADS_TABLE}
         (owner, family, rtype, rkey, anchor, claimed_time, event_id)
       values (:owner, :family, :type, :key, :anchor, :claimedTime, :eventId)
       on duplicate key update
         anchor = values(anchor),
         claimed_time = values(claimed_time),
         event_id = values(event_id)`,
      { ...key, ...order },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
  }
}

export const signedRecordHeadsDb = new SignedRecordHeadsDb(dbSupplier);
