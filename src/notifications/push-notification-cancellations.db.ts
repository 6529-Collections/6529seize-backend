import {
  IDENTITY_NOTIFICATIONS_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';
export const CANCELLATION_RETENTION_DAYS = 30;
const BATCH_SIZE = 1000;
type NotificationReference =
  | 'related_drop_id'
  | 'related_drop_2_id'
  | 'wave_id';
export class PushNotificationCancellationsDb extends LazyDbAccessCompatibleService {
  async cancelAndDelete(
    reference: NotificationReference,
    values: string[],
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Notification cancellation requires a transaction');
    if (!values.length) return;
    const options = { wrappedConnection: ctx.connection };
    // Lock and delete exactly the recorded IDs. A second predicate-based DELETE
    // could remove a newly inserted notification without recording its cancellation.
    while (true) {
      const rows = await this.db.execute<{ id: number }>(
        `select id from ${IDENTITY_NOTIFICATIONS_TABLE} where ${reference} in (:values) order by id limit ${BATCH_SIZE} for update`,
        { values },
        options
      );
      if (!rows.length) return;
      const ids = rows.map((row) => row.id);
      await this.db.execute(
        `insert into ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} (notification_id, cancelled_at)
         select id, :now from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (:ids)
         on duplicate key update cancelled_at = values(cancelled_at)`,
        { ids, now: Time.currentMillis() },
        options
      );
      await this.db.execute(
        `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (:ids)`,
        { ids },
        options
      );
      if (rows.length < BATCH_SIZE) return;
    }
  }
  async findCancelledIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    // Use the writer: replica lag must not turn a committed deletion into an alert.
    const rows = await this.db.execute<{ notification_id: number }>(
      `select notification_id from ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} where notification_id in (:ids)`,
      { ids },
      { forcePool: DbPoolName.WRITE }
    );
    return new Set(rows.map((row) => Number(row.notification_id)));
  }
  async deleteExpired(): Promise<void> {
    const table = await this.db.oneOrNull<{ found: number }>(
      'select 1 as found from information_schema.tables where table_schema = database() and table_name = :table',
      { table: PUSH_NOTIFICATION_CANCELLATIONS_TABLE },
      { forcePool: DbPoolName.WRITE }
    );
    // Scheduled invocations do not sync schema; deployment may not have run yet.
    if (!table) return;
    for (let batch = 0; batch < 10; batch++) {
      const result = await this.db.execute(
        `delete from ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} where cancelled_at < :cutoff order by cancelled_at limit ${BATCH_SIZE}`,
        {
          cutoff:
            Time.currentMillis() -
            Time.days(CANCELLATION_RETENTION_DAYS).toMillis()
        }
      );
      if (this.db.getAffectedRows(result) < BATCH_SIZE) return;
    }
  }
}
export const pushNotificationCancellationsDb =
  new PushNotificationCancellationsDb(dbSupplier);
