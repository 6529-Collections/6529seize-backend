import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { recordWebSocketEvents } from './outbox.db';

/** Retain invalidations carried by push SQS records from producers predating the rollout. */
export async function retainQueuedNotificationInvalidations(
  profileIds: string[],
  db: SqlExecutor = dbSupplier()
): Promise<void> {
  const unique = Array.from(new Set(profileIds));
  if (!unique.length || process.env.NODE_ENV === 'local') return;
  await db.executeNativeQueriesInTransaction((connection) =>
    recordWebSocketEvents(
      unique.map((profileId) => ({ type: 'identity', profileId })),
      { connection },
      db,
      Date.now()
    )
  );
}
