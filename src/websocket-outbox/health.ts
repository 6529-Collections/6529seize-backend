import { WEBSOCKET_OUTBOX_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier } from '@/sql-executor';

/** Emit backlog health even when no queue wakeup was accepted. */
export async function reportWebSocketOutboxHealth(): Promise<void> {
  const row = await dbSupplier().oneOrNull<{
    oldest: number | null;
    pending: number;
  }>(
    `select min(created_at) as oldest, count(*) as pending from ${WEBSOCKET_OUTBOX_TABLE}`,
    {},
    { forcePool: DbPoolName.WRITE }
  );
  const now = Date.now();
  // CloudWatch Embedded Metric Format must be a standalone JSON log message.
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: now,
        CloudWatchMetrics: [
          {
            Namespace: '6529/WebSocketOutbox',
            Dimensions: [[]],
            Metrics: [
              { Name: 'AgeSeconds', Unit: 'Seconds' },
              { Name: 'Pending', Unit: 'Count' }
            ]
          }
        ]
      },
      AgeSeconds:
        row?.oldest == null
          ? 0
          : Math.max(0, (now - Number(row.oldest)) / 1000),
      Pending: Number(row?.pending ?? 0)
    }) + '\n'
  );
}
