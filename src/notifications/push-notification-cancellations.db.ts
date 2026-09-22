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
type NotificationReference = 'drop' | 'wave';
export class PushNotificationCancellationsDb extends LazyDbAccessCompatibleService {
  /** Cancels existing rows atomically, locking both drop references in ID order. */
  async cancelAndDelete(
    reference: NotificationReference,
    values: string[],
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Notification cancellation requires a transaction');
    if (!values.length) return;
    const options = { wrappedConnection: ctx.connection };
    const predicate =
      reference === 'drop'
        ? '(related_drop_id in (:values) or related_drop_2_id in (:values))'
        : 'wave_id in (:values)';
    let afterId = 0;
    // Discover the union without locks, then acquire only primary-key locks in
    // ascending order. ORDER BY alone on a secondary-index scan can lock rows
    // before sorting. Keyset pagination also advances past concurrently deleted IDs.
    while (true) {
      const candidates = await this.db.execute<{ id: number }>(
        `select id from ${IDENTITY_NOTIFICATIONS_TABLE} where ${predicate} and id > :afterId order by id limit ${BATCH_SIZE}`,
        { values, afterId },
        options
      );
      if (!candidates.length) return;
      afterId = candidates[candidates.length - 1].id;
      const rows = await this.db.execute<{ id: number }>(
        `select id from ${IDENTITY_NOTIFICATIONS_TABLE} force index (PRIMARY)
         where id in (:ids) and ${predicate} order by id for update`,
        { ids: candidates.map((row) => row.id), values },
        options
      );
      if (!rows.length) continue;
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
      if (candidates.length < BATCH_SIZE) return;
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
        },
        { forcePool: DbPoolName.WRITE }
      );
      if (this.db.getAffectedRows(result) < BATCH_SIZE) return;
    }
  }
}
export const pushNotificationCancellationsDb =
  new PushNotificationCancellationsDb(dbSupplier);
