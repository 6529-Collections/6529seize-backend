import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { WebSocketOutboxEvent } from './events';
import { WEBSOCKET_OUTBOX_TABLE } from '@/constants';
import { resolveWebSocketEvent } from './resolve';
import { recordWebSocketEvents } from './outbox.db';
import { Logger } from '@/logging';

interface PendingEvent {
  id: number;
  event: WebSocketOutboxEvent | string;
  attempts: number;
  created_at: number;
}
const logger = Logger.get('WEBSOCKET_OUTBOX');

/** Retain events until every recipient enqueue succeeds; partial acceptance may replay safely. */
export async function publishWebSocketOutbox(
  publish: (event: WebSocketOutboxEvent, id: string) => Promise<void>,
  db: SqlExecutor = dbSupplier(),
  hasBudget: () => boolean = () => true
): Promise<number> {
  let published = 0;
  // Small transactions bound lock time. Failed rows remain observable and retryable.
  let count = 0;
  const worker = async () => {
    while (count++ < 100 && hasBudget()) {
      const found = await db.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          const row = await db.oneOrNull<PendingEvent>(
            `select pending.id, pending.event, pending.attempts, pending.created_at
         from ${WEBSOCKET_OUTBOX_TABLE} pending
         where pending.available_at <= :now
           and not exists (select 1 from ${WEBSOCKET_OUTBOX_TABLE} earlier
             where earlier.partition_key = pending.partition_key and earlier.id < pending.id)
         order by pending.id limit 1 for update skip locked`,
            { now: Date.now() },
            options
          );
          if (!row) return false;
          await db.execute('SAVEPOINT ws_outbox_publish', {}, options);
          try {
            const event: WebSocketOutboxEvent =
              typeof row.event === 'string' ? JSON.parse(row.event) : row.event;
            if (event.type === 'delivery') {
              await publish(event, String(row.id));
            } else {
              await recordWebSocketEvents(
                await resolveWebSocketEvent(event, { connection }),
                { connection },
                db,
                Number(row.created_at)
              );
            }
          } catch {
            await db.execute(
              'ROLLBACK TO SAVEPOINT ws_outbox_publish',
              {},
              options
            );
            const delay = Math.min(
              60_000,
              1000 * 2 ** Math.min(row.attempts, 6)
            );
            await db.execute(
              `update ${WEBSOCKET_OUTBOX_TABLE} set attempts = attempts + 1, available_at = :next where id = :id`,
              { id: row.id, next: Date.now() + delay },
              options
            );
            logger.error({
              code: 'WS_OUTBOX_PUBLISH_FAILED',
              event_id: String(row.id),
              attempt: Number(row.attempts) + 1,
              age_ms: Date.now() - Number(row.created_at)
            });
            return true;
          }
          await db.execute(
            `delete from ${WEBSOCKET_OUTBOX_TABLE} where id = :id`,
            { id: row.id },
            options
          );
          published++;
          return true;
        },
        { isolationLevel: 'READ COMMITTED' }
      );
      if (!found) break;
    }
  };
  const results = await Promise.allSettled(Array.from({ length: 4 }, worker));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return published;
}
