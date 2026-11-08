import { DataSource } from 'typeorm';
import { applyProfileActivityLogWaveIndexSchema } from './profile-activity-log-wave-index-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const ddl =
  'ALTER TABLE `profile_activity_logs` ADD INDEX `idx_pal_wave_type_created_at` (`additional_data_2`, `type`, `created_at`), ALGORITHM=INPLACE, LOCK=NONE';

describe('profile activity log online wave index', () => {
  it('adds only the wave index online, under a short metadata lock wait', async () => {
    let columns: object[] = [];
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('information_schema.statistics')) return columns;
      if (sql.startsWith('SELECT @@SESSION'))
        return [{ lock_wait_timeout: '31536000' }];
      if (sql === ddl)
        columns = ['additional_data_2', 'type', 'created_at'].map(
          (column_name) => ({
            column_name,
            non_unique: 1,
            sub_part: null,
            index_type: 'BTREE',
            is_visible: 'YES',
            collation: 'A'
          })
        );
      return [];
    });
    const runner = {
      hasTable: jest.fn().mockResolvedValue(true),
      query,
      release: jest.fn().mockResolvedValue(undefined)
    };
    const source = {
      createQueryRunner: jest.fn(() => runner)
    } as unknown as DataSource;
    await expect(applyProfileActivityLogWaveIndexSchema(source)).resolves.toBe(
      1
    );
    expect(
      query.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => sql.startsWith('ALTER'))
    ).toEqual([ddl]);
    expect(query).toHaveBeenCalledWith('SET SESSION lock_wait_timeout = 2');
    await expect(applyProfileActivityLogWaveIndexSchema(source)).resolves.toBe(
      0
    );
  });
});
