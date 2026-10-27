import { DataSource } from 'typeorm';
import { applyWaveScoreInputIndexSchema } from './wave-score-input-index-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const indexColumns = ['wave_id', 'author_id', 'created_at'].map(
  (column_name) => ({
    column_name,
    non_unique: 1,
    sub_part: null,
    index_type: 'BTREE',
    is_visible: 'YES',
    collation: 'A'
  })
);
const ddl =
  'ALTER TABLE `drops` ADD INDEX `idx_drop_wave_author_created` (`wave_id`, `author_id`, `created_at`), ALGORITHM=INPLACE, LOCK=NONE';

function fixture(
  existing: object[] = [],
  timeout: number | string = '31536000'
) {
  let columns = existing;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('information_schema.statistics')) return columns;
    if (sql.startsWith('SELECT @@SESSION'))
      return [{ lock_wait_timeout: timeout }];
    if (sql === ddl) columns = indexColumns;
    return [];
  });
  const runner = {
    hasTable: jest.fn().mockResolvedValue(true),
    query,
    release: jest.fn().mockResolvedValue(undefined)
  };
  const source = { createQueryRunner: jest.fn(() => runner) };
  return { source: source as unknown as DataSource, runner };
}

describe('wave score online input index', () => {
  it('adds only the covering index online and restores the metadata lock timeout', async () => {
    const f = fixture();
    await expect(applyWaveScoreInputIndexSchema(f.source)).resolves.toBe(1);
    expect(f.source.createQueryRunner).toHaveBeenCalledWith('master');
    expect(
      f.runner.query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.startsWith('ALTER'))
    ).toEqual([ddl]);
    expect(f.runner.query).toHaveBeenCalledWith(
      'SET SESSION lock_wait_timeout = 2'
    );
    expect(f.runner.query).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.runner.release).toHaveBeenCalledTimes(1);
    await expect(applyWaveScoreInputIndexSchema(f.source)).resolves.toBe(0);
    expect(
      f.runner.query.mock.calls.filter(([sql]) => sql === ddl)
    ).toHaveLength(1);
  });

  it.each([
    [indexColumns[1], indexColumns[0], indexColumns[2]],
    indexColumns.slice(0, 2),
    indexColumns.map((column) => ({ ...column, non_unique: 0 })),
    indexColumns.map((column) => ({ ...column, sub_part: 20 })),
    indexColumns.map((column) => ({ ...column, is_visible: 'NO' })),
    indexColumns.map((column) => ({ ...column, collation: 'D' }))
  ])(
    'refuses incompatible existing index definition %j',
    async (...columns) => {
      const f = fixture(columns);
      await expect(applyWaveScoreInputIndexSchema(f.source)).rejects.toThrow(
        'incompatible'
      );
      expect(
        f.runner.query.mock.calls.some(([sql]) => sql.startsWith('ALTER'))
      ).toBe(false);
      expect(f.runner.release).toHaveBeenCalledTimes(1);
    }
  );

  it('does not create or synchronize a missing table', async () => {
    const f = fixture();
    f.runner.hasTable.mockResolvedValue(false);
    await expect(applyWaveScoreInputIndexSchema(f.source)).rejects.toThrow(
      'existing drops table'
    );
    expect(f.runner.query).not.toHaveBeenCalled();
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('propagates unsupported online DDL or lock contention without a blocking fallback', async () => {
    const f = fixture();
    const query = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation(async (sql) => {
      if (sql === ddl) throw new Error('online index unavailable');
      return query(sql);
    });
    await expect(applyWaveScoreInputIndexSchema(f.source)).rejects.toThrow(
      'online index unavailable'
    );
    expect(f.runner.query).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('requires a verified complete index before reporting success', async () => {
    const f = fixture();
    const query = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation(async (sql) =>
      sql.includes('information_schema.statistics') ? [] : query(sql)
    );
    await expect(applyWaveScoreInputIndexSchema(f.source)).rejects.toThrow(
      'was not created'
    );
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });
});
