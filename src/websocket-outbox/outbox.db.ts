import { webSocketOutboxPartition } from './partition';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { WebSocketOutboxEvent } from './events';
import { WEBSOCKET_OUTBOX_TABLE } from '@/constants';

/** The event insert must commit or roll back with the mutation, never in a later transaction. */
export async function recordWebSocketEvent(
  event: WebSocketOutboxEvent,
  ctx: RequestContext,
  db: SqlExecutor = dbSupplier(),
  createdAt = Date.now()
): Promise<void> {
  if (process.env.NODE_ENV === 'local') return;
  if (!ctx.connection)
    throw new Error('WebSocket outbox requires the mutation transaction');
  const now = Date.now();
  await db.execute(
    `insert into ${WEBSOCKET_OUTBOX_TABLE} (event, partition_key, created_at, available_at, attempts)
     values (:event, :partitionKey, :createdAt, :now, 0)`,
    {
      event: JSON.stringify(event),
      partitionKey: webSocketOutboxPartition(event),
      now,
      createdAt
    },
    { wrappedConnection: ctx.connection }
  );
}

/** Reuse caller-owned transactions; otherwise atomically wrap a mutation and its event. */
export async function withWebSocketMutation<T>(
  db: SqlExecutor,
  ctx: RequestContext,
  mutate: (
    ctx: RequestContext & { connection: ConnectionWrapper<unknown> }
  ) => Promise<T>
): Promise<T> {
  if (ctx.connection) return mutate({ ...ctx, connection: ctx.connection });
  return db.executeNativeQueriesInTransaction((connection) =>
    mutate({ ...ctx, connection })
  );
}

/** Insert recipient jobs together so a crash cannot leave half a fan-out committed. */
export async function recordWebSocketEvents(
  events: WebSocketOutboxEvent[],
  ctx: RequestContext,
  db: SqlExecutor = dbSupplier(),
  createdAt = Date.now()
): Promise<void> {
  if (process.env.NODE_ENV === 'local' || !events.length) return;
  if (!ctx.connection)
    throw new Error('WebSocket outbox requires a transaction');
  const now = Date.now();
  await db.bulkInsert(
    WEBSOCKET_OUTBOX_TABLE,
    events.map((event) => ({
      event: JSON.stringify(event),
      partition_key: webSocketOutboxPartition(event),
      created_at: createdAt,
      available_at: now,
      attempts: 0
    })),
    ['event', 'partition_key', 'created_at', 'available_at', 'attempts'],
    ctx,
    { connection: ctx.connection }
  );
}
