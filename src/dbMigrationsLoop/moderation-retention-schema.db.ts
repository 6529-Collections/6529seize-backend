import {
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_EVALUATIONS_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

// Columns used by ModerationReviewDb.retain(). A scoped schema deployment may
// precede the separate moderation schema rollout in an environment.
export const MODERATION_RETENTION_COLUMNS: Record<string, readonly string[]> = {
  [CONTENT_MODERATION_ITEMS_TABLE]: [
    'id',
    'operation',
    'outcome',
    'review_status',
    'override',
    'suppressed',
    'updated_at',
    'version',
    'evidence_expires_at',
    'evidence'
  ],
  [CONTENT_MODERATION_EVALUATIONS_TABLE]: [
    'id',
    'item_id',
    'outcome',
    'fallback',
    'completed_at',
    'started_at',
    'result'
  ],
  [CONTENT_MODERATION_AUDIT_LOG_TABLE]: ['item_id', 'action', 'created_at'],
  [CONTENT_MODERATION_REPORTS_TABLE]: [
    'item_id',
    'resolved_at',
    'status',
    'content_snapshot',
    'notes',
    'ai_rationale',
    'ai_evidence'
  ]
};

export class ModerationRetentionSchemaDb extends LazyDbAccessCompatibleService {
  async missingColumns(ctx: RequestContext): Promise<string[]> {
    const timerName = `${this.constructor.name}->missingColumns`;
    ctx.timer?.start(timerName);
    try {
      const columns = await this.db.execute<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT /*+ MAX_EXECUTION_TIME(2000) */
           TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:tables)`,
        { tables: Object.keys(MODERATION_RETENTION_COLUMNS) },
        {
          wrappedConnection: ctx.connection,
          forcePool: DbPoolName.WRITE
        }
      );
      const available = new Set(
        columns.map((column) => `${column.table_name}.${column.column_name}`)
      );
      return Object.entries(MODERATION_RETENTION_COLUMNS).flatMap(
        ([table, required]) =>
          required
            .map((column) => `${table}.${column}`)
            .filter((column) => !available.has(column))
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const moderationRetentionSchemaDb = new ModerationRetentionSchemaDb(
  dbSupplier
);
