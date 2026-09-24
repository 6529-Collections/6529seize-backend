import { PUSH_NOTIFICATION_OUTBOX_TABLE } from '@/constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { DbPoolName } from '@/db-query.options';

export class PushNotificationOutboxDb extends LazyDbAccessCompatibleService {
  async enqueue(notificationId: number, ctx: RequestContext): Promise<void> {
    if (!ctx.connection) throw new Error('Push outbox requires a transaction');
    const timer = `${this.constructor.name}->enqueue`;
    ctx.timer?.start(timer);
    try {
      await this.db.execute(
        `insert into ${PUSH_NOTIFICATION_OUTBOX_TABLE} (notification_id, created_at)
         values (:notificationId, :now)`,
        { notificationId, now: Time.currentMillis() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async oldestPendingAt(): Promise<number | null> {
    const row = await this.db.oneOrNull<{ created_at: number }>(
      `select min(created_at) as created_at from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return row?.created_at == null ? null : Number(row.created_at);
  }

  async publishBatch(send: (ids: number[]) => Promise<void>): Promise<number> {
    return this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const rows = await this.db.execute<{ notification_id: number }>(
          `select notification_id from ${PUSH_NOTIFICATION_OUTBOX_TABLE}
         order by notification_id limit 10 for update skip locked`,
          undefined,
          { wrappedConnection: connection }
        );
        if (!rows.length) return 0;
        const ids = rows.map((row) => Number(row.notification_id));
        // Delete only after SQS accepts the batch. An ambiguous send/commit can
        // replay messages; the push worker's existing receipts handle duplicates.
        await send(ids);
        await this.db.execute(
          `delete from ${PUSH_NOTIFICATION_OUTBOX_TABLE} where notification_id in (:ids)`,
          { ids },
          { wrappedConnection: connection }
        );
        return ids.length;
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }
}

export const pushNotificationOutboxDb = new PushNotificationOutboxDb(
  dbSupplier
);
