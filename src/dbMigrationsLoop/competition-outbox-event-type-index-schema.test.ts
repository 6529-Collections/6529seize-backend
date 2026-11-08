import { DataSource } from 'typeorm';
import { applyCompetitionOutboxEventTypeIndexSchema } from './competition-outbox-event-type-index-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const ddl =
  'ALTER TABLE `competition_outbox` ADD INDEX `idx_competition_outbox_competition_event_type` (`competition_id`, `event_type`), ALGORITHM=INPLACE, LOCK=NONE';

function fixture(columnRows: object[]) {
  let indexColumns: object[] = [];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('information_schema.statistics')) return indexColumns;
    if (sql.startsWith('SELECT @@SESSION'))
      return [{ lock_wait_timeout: '31536000' }];
    if (sql === ddl)
      indexColumns = ['competition_id', 'event_type'].map((column_name) => ({
        column_name,
        non_unique: 1,
        sub_part: null,
        index_type: 'BTREE',
        is_visible: 'YES',
        collation: 'A'
      }));
    return [];
  });
  const runner = {
    hasTable: jest.fn().mockResolvedValue(true),
    query,
    release: jest.fn().mockResolvedValue(undefined)
  };
  const source = {
    query: jest.fn(async () => columnRows),
    createQueryRunner: jest.fn(() => runner)
  } as unknown as DataSource;
  return { source, query };
}

describe('competition outbox online event type index', () => {
  it('adds only the index, online, once the generated column exists', async () => {
    const f = fixture([
      {
        generated: "json_unquote(json_extract(`event`,_utf8mb4'$.event_type'))"
      }
    ]);
    await expect(
      applyCompetitionOutboxEventTypeIndexSchema(f.source)
    ).resolves.toBe(1);
    expect(
      f.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.startsWith('ALTER'))
    ).toEqual([ddl]);
    expect(f.query).toHaveBeenCalledWith('SET SESSION lock_wait_timeout = 2');
    await expect(
      applyCompetitionOutboxEventTypeIndexSchema(f.source)
    ).resolves.toBe(0);
  });

  it.each([[[]], [[{ expression: '' }]], [[{ expression: null }]]])(
    'refuses to run before a full-scope sync adds the column (%j)',
    async (rows) => {
      const f = fixture(rows);
      await expect(
        applyCompetitionOutboxEventTypeIndexSchema(f.source)
      ).rejects.toThrow('run a full-scope schema sync first');
      expect(f.query).not.toHaveBeenCalled();
    }
  );
});
