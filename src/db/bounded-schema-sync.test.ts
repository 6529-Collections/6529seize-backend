import { DataSource } from 'typeorm';
import { Logger } from '@/logging';
import {
  SCHEMA_SYNC_ATTEMPTS,
  SCHEMA_SYNC_LOCK_WAIT_SECONDS,
  SCHEMA_SYNC_RETRY_DELAYS_MS,
  SchemaSyncLockedError,
  synchronizeSchemaBounded
} from './bounded-schema-sync';

const lockTimeout = () =>
  Object.assign(new Error('Lock wait timeout exceeded'), {
    code: 'ER_LOCK_WAIT_TIMEOUT',
    errno: 1205
  });

const SESSION_TIMEOUT = 31536000;

/**
 * A stand-in for TypeORM: the schema builder returns `plan`, and the query
 * runner records statements, failing chosen ones with lock timeouts.
 */
function fakeDataSource({
  plan = [],
  lockedTimes = new Map<string, number>(),
  failWith
}: {
  plan?: { query: string; parameters?: unknown[] }[];
  lockedTimes?: Map<string, number>;
  failWith?: Map<string, unknown>;
} = {}) {
  const statements: { sql: string; parameters?: unknown[] }[] = [];
  const queryRunner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, parameters });
      if (sql.startsWith('select @@session.lock_wait_timeout'))
        return [{ timeout: SESSION_TIMEOUT }];
      const remaining = lockedTimes.get(sql) ?? 0;
      if (remaining > 0) {
        lockedTimes.set(sql, remaining - 1);
        throw lockTimeout();
      }
      if (failWith?.has(sql)) throw failWith.get(sql);
      return [];
    })
  };
  const builder = {
    createMetadataTableIfNecessary: jest.fn(async () => undefined),
    log: jest.fn(async () => ({ upQueries: plan, downQueries: [] }))
  };
  const dataSource = {
    driver: { createSchemaBuilder: () => builder },
    createQueryRunner: jest.fn(() => queryRunner)
  } as unknown as DataSource;
  const ddl = () =>
    statements
      .map((it) => it.sql)
      .filter((sql) => !sql.includes('lock_wait_timeout'));
  return { dataSource, statements, queryRunner, builder, ddl };
}

const noSleep = jest.fn(async (_ms: number) => undefined);
const ALTER = 'ALTER TABLE `ws_connections` ADD `x` int NULL';
const INDEX = 'CREATE INDEX `idx_x` ON `ws_connections` (`x`)';
const METADATA =
  'UPDATE `db`.`typeorm_metadata` SET `value` = ? WHERE `type` = ? AND `name` = ?';

const expectSessionRestoredAndReleased = (
  fake: ReturnType<typeof fakeDataSource>
) => {
  const last = fake.statements.at(-1)!;
  expect(last.sql).toBe('set session lock_wait_timeout = ?');
  expect(last.parameters).toEqual([SESSION_TIMEOUT]);
  expect(fake.queryRunner.release).toHaveBeenCalledTimes(1);
};

describe('synchronizeSchemaBounded', () => {
  beforeEach(() => noSleep.mockClear());

  it('tries each statement once per retry delay plus once', () => {
    expect(SCHEMA_SYNC_ATTEMPTS).toBe(SCHEMA_SYNC_RETRY_DELAYS_MS.length + 1);
  });

  it('runs no DDL when the plan is empty', async () => {
    const fake = fakeDataSource();
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 0, applied: 0 });
    expect(fake.ddl()).toEqual([]);
    expectSessionRestoredAndReleased(fake);
  });

  it('applies the plan in order under the short lock wait, then restores it', async () => {
    const fake = fakeDataSource({
      plan: [
        { query: ALTER },
        { query: METADATA, parameters: ['expr', 'GENERATED_COLUMN', 'x'] },
        { query: INDEX }
      ]
    });
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 3, applied: 3 });
    expect(fake.statements.slice(0, 2)).toEqual([
      { sql: 'select @@session.lock_wait_timeout as timeout' },
      {
        sql: 'set session lock_wait_timeout = ?',
        parameters: [SCHEMA_SYNC_LOCK_WAIT_SECONDS]
      }
    ]);
    expect(fake.ddl()).toEqual([ALTER, METADATA, INDEX]);
    // TypeORM's bookkeeping statements keep their parameters.
    expect(
      fake.statements.find((it) => it.sql === METADATA)!.parameters
    ).toEqual(['expr', 'GENERATED_COLUMN', 'x']);
    // Its metadata table is ensured on the same bounded connection, first.
    expect(fake.builder.createMetadataTableIfNecessary).toHaveBeenCalledWith(
      fake.queryRunner
    );
    expectSessionRestoredAndReleased(fake);
  });

  it('retries a locked statement with backoff and then applies it', async () => {
    const fake = fakeDataSource({
      plan: [{ query: ALTER }, { query: INDEX }],
      lockedTimes: new Map([[INDEX, SCHEMA_SYNC_ATTEMPTS - 1]])
    });
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 2, applied: 2 });
    expect(fake.ddl()).toEqual([
      ALTER,
      ...Array(SCHEMA_SYNC_ATTEMPTS).fill(INDEX)
    ]);
    expect(noSleep.mock.calls.map(([ms]) => ms)).toEqual([
      ...SCHEMA_SYNC_RETRY_DELAYS_MS
    ]);
  });

  it('recognizes a lock timeout wrapped by TypeORM', async () => {
    const wrapped = Object.assign(new Error('QueryFailedError'), {
      driverError: lockTimeout()
    });
    let thrown = 0;
    const fake = fakeDataSource({ plan: [{ query: ALTER }] });
    const query = fake.queryRunner.query.getMockImplementation()!;
    fake.queryRunner.query.mockImplementation(async (sql, parameters) => {
      if (sql === ALTER && thrown++ === 0) throw wrapped;
      return query(sql, parameters);
    });
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 1, applied: 1 });
    expect(noSleep).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly when a table stays locked, naming applied and remaining statements', async () => {
    const error = jest.spyOn(Logger.get('SCHEMA_SYNC'), 'error');
    const fake = fakeDataSource({
      plan: [{ query: ALTER }, { query: INDEX }, { query: METADATA }],
      lockedTimes: new Map([[INDEX, 99]])
    });
    try {
      await expect(
        synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
      ).rejects.toThrow(
        new SchemaSyncLockedError(
          `Schema change on ws_connections stayed locked after ${SCHEMA_SYNC_ATTEMPTS} attempts of ${SCHEMA_SYNC_LOCK_WAIT_SECONDS}s; not applied`
        )
      );
      expect(fake.ddl()).toEqual([
        ALTER,
        ...Array(SCHEMA_SYNC_ATTEMPTS).fill(INDEX)
      ]);
      expect(error).toHaveBeenCalledWith('[SCHEMA_SYNC_FAILED]', {
        applied: [ALTER],
        remaining: [INDEX, METADATA],
        error: expect.stringContaining('stayed locked')
      });
      expectSessionRestoredAndReleased(fake);
    } finally {
      error.mockRestore();
    }
  });

  it('does not retry other errors', async () => {
    const failure = new Error('syntax');
    const fake = fakeDataSource({
      plan: [{ query: ALTER }, { query: INDEX }],
      failWith: new Map([[ALTER, failure]])
    });
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).rejects.toBe(failure);
    expect(fake.ddl()).toEqual([ALTER]);
    expect(noSleep).not.toHaveBeenCalled();
    expectSessionRestoredAndReleased(fake);
  });

  it('bounds the metadata-table check too', async () => {
    const fake = fakeDataSource({ plan: [{ query: ALTER }] });
    fake.builder.createMetadataTableIfNecessary
      .mockRejectedValueOnce(lockTimeout())
      .mockResolvedValue(undefined);
    await expect(
      synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 1, applied: 1 });
    expect(fake.builder.createMetadataTableIfNecessary).toHaveBeenCalledTimes(
      2
    );
  });
});
