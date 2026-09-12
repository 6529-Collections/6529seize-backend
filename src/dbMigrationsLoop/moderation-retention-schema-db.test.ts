import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import {
  MODERATION_RETENTION_COLUMNS,
  ModerationRetentionSchemaDb
} from './moderation-retention-schema.db';

const allColumns = Object.entries(MODERATION_RETENTION_COLUMNS).flatMap(
  ([table_name, columns]) =>
    columns.map((column_name) => ({ table_name, column_name }))
);

describe('moderation retention schema readiness', () => {
  const execute = jest.fn();
  const repository = new ModerationRetentionSchemaDb(
    () => ({ execute }) as unknown as SqlExecutor
  );

  beforeEach(() => execute.mockReset());

  it('checks only metadata from the primary database once and accepts the complete schema', async () => {
    execute.mockResolvedValue(allColumns);
    await expect(repository.missingColumns({})).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('FROM INFORMATION_SCHEMA.COLUMNS'),
      { tables: Object.keys(MODERATION_RETENTION_COLUMNS) },
      { wrappedConnection: undefined, forcePool: DbPoolName.WRITE }
    );
    expect(execute.mock.calls[0][0]).toContain('MAX_EXECUTION_TIME(2000)');
    expect(execute.mock.calls[0][0]).toContain('TABLE_SCHEMA = DATABASE()');
  });

  it.each(Object.keys(MODERATION_RETENTION_COLUMNS))(
    'detects a missing %s table without querying its data',
    async (table) => {
      execute.mockResolvedValue(
        allColumns.filter((column) => column.table_name !== table)
      );
      await expect(repository.missingColumns({})).resolves.toEqual(
        MODERATION_RETENTION_COLUMNS[table].map(
          (column) => `${table}.${column}`
        )
      );
      expect(execute).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['content_moderation_audit_log', 'item_id'],
    ['content_moderation_reports', 'item_id'],
    ['content_moderation_evaluations', 'completed_at'],
    ['content_moderation_items', 'evidence_expires_at']
  ])('detects a partially deployed %s.%s column', async (table, name) => {
    execute.mockResolvedValue(
      allColumns.filter(
        (column) => column.table_name !== table || column.column_name !== name
      )
    );
    await expect(repository.missingColumns({})).resolves.toEqual([
      `${table}.${name}`
    ]);
  });

  it('propagates metadata errors', async () => {
    const failure = new Error('Synthetic database failure');
    execute.mockRejectedValue(failure);
    await expect(repository.missingColumns({})).rejects.toBe(failure);
  });
});
