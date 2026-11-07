import { DataSource } from 'typeorm';
import { applyProfileGroupsCollationSchema } from './profile-groups-collation-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const legacy = { charset: 'utf8mb3', collation: 'utf8mb3_bin' };
const target = { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' };
type Charset = typeof legacy;

function columns(charset: Charset, overrides: Record<string, unknown> = {}) {
  return [
    { column_name: 'profile_group_id', column_type: 'varchar(50)' },
    { column_name: 'profile_id', column_type: 'varchar(100)' }
  ].map((column) => ({
    ...column,
    is_nullable: 'NO',
    character_set_name: charset.charset,
    collation_name: charset.collation,
    ...overrides
  }));
}

const indexes = [
  { index_name: 'IDX_aa049b9eb0c9f2b267e7298792', column_name: 'profile_id' },
  {
    index_name: 'IDX_e975b303135f176113eebeb658',
    column_name: 'profile_group_id'
  },
  { index_name: 'PRIMARY', column_name: 'profile_group_id' },
  { index_name: 'PRIMARY', column_name: 'profile_id' }
];

const convertDdl =
  'ALTER TABLE `profile_groups` MODIFY `profile_group_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL, MODIFY `profile_id` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL, ALGORITHM=COPY, LOCK=SHARED';
const revertDdl =
  'ALTER TABLE `profile_groups` MODIFY `profile_group_id` varchar(50) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin NOT NULL, MODIFY `profile_id` varchar(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin NOT NULL, ALGORITHM=COPY, LOCK=SHARED';

function lockTimeout() {
  return Object.assign(new Error('Lock wait timeout exceeded'), {
    errno: 1205,
    code: 'ER_LOCK_WAIT_TIMEOUT'
  });
}

function fixture({
  start = legacy,
  duplicates = 0,
  failures = [] as Error[]
}: { start?: Charset; duplicates?: number; failures?: Error[] } = {}) {
  let state = start;
  const pendingFailures = [...failures];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('information_schema.columns')) return columns(state);
    if (sql.includes('information_schema.statistics')) return indexes;
    if (sql.includes('AS duplicates')) return [{ duplicates }];
    if (sql.startsWith('SELECT @@SESSION'))
      return [{ lock_wait_timeout: '31536000' }];
    if (sql.startsWith('ALTER TABLE')) {
      const failure = pendingFailures.shift();
      if (failure) throw failure;
      state = sql === convertDdl ? target : legacy;
    }
    return [];
  });
  const runner = {
    hasTable: jest.fn().mockResolvedValue(true),
    query,
    release: jest.fn().mockResolvedValue(undefined)
  };
  const source = { createQueryRunner: jest.fn(() => runner) };
  const sleep = jest.fn().mockResolvedValue(undefined);
  const alters = () =>
    query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.startsWith('ALTER TABLE'));
  return {
    source: source as unknown as DataSource,
    runner,
    sleep,
    alters
  };
}

describe('profile_groups collation change', () => {
  it('converts both id columns with a short metadata lock wait, then restores it', async () => {
    const f = fixture();

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).resolves.toBe(1);

    expect(f.source.createQueryRunner).toHaveBeenCalledWith('master');
    expect(f.alters()).toEqual([convertDdl]);
    expect(f.runner.query).toHaveBeenCalledWith(
      'SET SESSION lock_wait_timeout = 2'
    );
    expect(f.runner.query).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.runner.release).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it('is a no-op once converted, and reverts with the same guards', async () => {
    const f = fixture({ start: target });

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).resolves.toBe(0);
    expect(f.alters()).toEqual([]);
    expect(f.runner.query).not.toHaveBeenCalledWith(
      'SET SESSION lock_wait_timeout = 2'
    );

    await expect(
      applyProfileGroupsCollationSchema('revert', f.source, f.sleep)
    ).resolves.toBe(1);
    expect(f.alters()).toEqual([revertDdl]);
    await expect(
      applyProfileGroupsCollationSchema('revert', f.source, f.sleep)
    ).resolves.toBe(0);
  });

  it('refuses keys that would collide under the target collation', async () => {
    const f = fixture({ duplicates: 3 });

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('3 keys that collide');
    expect(f.alters()).toEqual([]);
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a mixed collation', [columns(legacy)[0], columns(target)[1]]],
    ['a different type', columns(legacy, { column_type: 'varchar(255)' })],
    ['a nullable column', columns(legacy, { is_nullable: 'YES' })],
    ['a missing column', columns(legacy).slice(0, 1)]
  ])('refuses %s', async (_name, shape) => {
    const f = fixture();
    const query = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation(async (sql: string) =>
      sql.includes('information_schema.columns') ? shape : query(sql)
    );

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('incompatible');
    expect(f.alters()).toEqual([]);
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('refuses an unexpected primary key', async () => {
    const f = fixture();
    const query = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation(async (sql: string) =>
      sql.includes('information_schema.statistics')
        ? [{ index_name: 'PRIMARY', column_name: 'profile_id' }]
        : query(sql)
    );

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('primary key is incompatible');
    expect(f.alters()).toEqual([]);
  });

  it('retries metadata lock timeouts with backoff', async () => {
    const f = fixture({ failures: [lockTimeout(), lockTimeout()] });

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).resolves.toBe(1);

    expect(f.alters()).toEqual([convertDdl, convertDdl, convertDdl]);
    expect(f.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);
  });

  it('gives up after five lock timeouts and restores the session', async () => {
    const f = fixture({ failures: Array.from({ length: 5 }, lockTimeout) });

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('Lock wait timeout');

    expect(f.alters()).toHaveLength(5);
    expect(f.runner.query).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('does not retry other failures', async () => {
    const f = fixture({ failures: [new Error('copy failed')] });

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('copy failed');
    expect(f.alters()).toHaveLength(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it('requires a verified result before reporting success', async () => {
    const f = fixture();
    const query = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation(async (sql: string) =>
      sql.startsWith('ALTER TABLE') ? [] : query(sql)
    );

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('was not applied');
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('does not create a missing table', async () => {
    const f = fixture();
    f.runner.hasTable.mockResolvedValue(false);

    await expect(
      applyProfileGroupsCollationSchema('convert', f.source, f.sleep)
    ).rejects.toThrow('existing table');
    expect(f.runner.query).not.toHaveBeenCalled();
  });
});
