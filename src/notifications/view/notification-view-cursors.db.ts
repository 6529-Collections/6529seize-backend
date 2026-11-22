import { NOTIFICATION_VIEW_CURSORS_TABLE } from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

/**
 * Cursors of the notification feeds and of the one-off passes over old
 * rows. Ephemeral: a lost cursor replays from the start, and a replay
 * writes the same rows.
 */
export class NotificationViewCursorsDb extends LazyDbAccessCompatibleService {
  /**
   * The cursor, locked for the caller's transaction when it has one. An
   * empty value is the start, as is a missing row.
   */
  async get(
    source: string,
    connection?: ConnectionWrapper<any>
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ cursor_value: string }>(
      `select cursor_value from ${NOTIFICATION_VIEW_CURSORS_TABLE}
       where source = :source${connection ? ' for update' : ''}`,
      { source },
      connection ? { wrappedConnection: connection } : undefined
    );
    return row?.cursor_value || null;
  }

  /**
   * Creates the cursor's row at the start if it is missing, so runners
   * lock that row rather than the gap where it would be (two runners
   * holding the same gap lock deadlock when both insert).
   */
  async ensure(source: string): Promise<void> {
    await this.db.execute(
      `insert ignore into ${NOTIFICATION_VIEW_CURSORS_TABLE} (source, cursor_value, updated_at)
       values (:source, '', 0)`,
      { source }
    );
  }

  async set(
    source: string,
    cursor: string,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `insert into ${NOTIFICATION_VIEW_CURSORS_TABLE} (source, cursor_value, updated_at)
       values (:source, :cursor, :now)
       on duplicate key update cursor_value = values(cursor_value), updated_at = values(updated_at)`,
      { source, cursor, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
  }

  async clear(sources: readonly string[]): Promise<void> {
    if (!sources.length) return;
    await this.db.execute(
      `delete from ${NOTIFICATION_VIEW_CURSORS_TABLE} where source in (:sources)`,
      { sources }
    );
  }
}

export const notificationViewCursorsDb = new NotificationViewCursorsDb(
  dbSupplier
);
