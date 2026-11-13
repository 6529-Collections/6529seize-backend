import { DataSource } from 'typeorm';
import { Logger } from '@/logging';
import {
  SCHEMA_SYNC_ATTEMPTS,
  SCHEMA_SYNC_LOCK_WAIT_SECONDS,
  SCHEMA_SYNC_RETRY_DELAYS_MS,
  SchemaSyncDestructivePlanRefusedError,
  SchemaSyncLockedError,
  synchronizeSchemaBounded
} from './bounded-schema-sync';
import {
  destructivePlanSha256,
  SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV,
  SchemaCatalog
} from './schema-sync-plan-check';

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
  failWith,
  sessionTimeoutRows = [{ timeout: SESSION_TIMEOUT }]
}: {
  plan?: { query: string; parameters?: unknown[] }[];
  lockedTimes?: Map<string, number>;
  failWith?: Map<string, unknown>;
  sessionTimeoutRows?: unknown[];
} = {}) {
  const statements: { sql: string; parameters?: unknown[] }[] = [];
  const queryRunner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      statements.push({ sql, parameters });
      if (sql.startsWith('select @@session.lock_wait_timeout'))
        return sessionTimeoutRows;
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
      // instanceof also selects the 'locked' metric outcome.
      expect(
        await synchronizeSchemaBounded(
          fakeDataSource({
            plan: [{ query: INDEX }],
            lockedTimes: new Map([[INDEX, 99]])
          }).dataSource,
          { sleep: noSleep }
        ).catch((e: unknown) => e)
      ).toBeInstanceOf(SchemaSyncLockedError);
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

  it.each([[[]], [[{ timeout: null }]], [[{ timeout: 'x' }]]])(
    "restores MySQL's default wait when the session value reads back as %j",
    async (rows) => {
      const fake = fakeDataSource({ sessionTimeoutRows: rows });
      await synchronizeSchemaBounded(fake.dataSource, { sleep: noSleep });
      expectSessionRestoredAndReleased(fake);
    }
  );
  describe('destructive plan guard', () => {
    const DROP_COLUMN = 'ALTER TABLE `ws_connections` DROP COLUMN `legacy`';
    const DROP_UNIQUE = 'DROP INDEX `uq_ws` ON `ws_connections`';
    const plainColumnCatalog: SchemaCatalog = {
      column: async () => ({ generated: false }),
      index: async () => ({ unique: true, columns: ['legacy'] })
    };
    const destructivePlan = [
      { query: ALTER },
      { query: DROP_UNIQUE },
      { query: DROP_COLUMN },
      { query: INDEX }
    ];
    const destructiveSha = destructivePlanSha256([
      { query: DROP_UNIQUE },
      { query: DROP_COLUMN }
    ])!;
    const originalMode = process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV];

    afterEach(() => {
      if (originalMode === undefined) {
        delete process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV];
      } else {
        process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV] = originalMode;
      }
    });

    it('in block mode applies none of a destructive plan and reports its hash', async () => {
      const warn = jest.spyOn(Logger.get('SCHEMA_SYNC'), 'warn');
      const fake = fakeDataSource({ plan: destructivePlan });
      try {
        const error = await synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'block',
          catalog: plainColumnCatalog
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SchemaSyncDestructivePlanRefusedError);
        expect(error).toMatchObject({
          destructivePlanSha256: destructiveSha,
          destructiveStatements: [DROP_UNIQUE, DROP_COLUMN]
        });
        expect((error as Error).message).toContain(destructiveSha);
        expect(fake.ddl()).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[SCHEMA_SYNC_DESTRUCTIVE_PLAN]',
          expect.objectContaining({
            mode: 'block',
            decision: 'refused',
            destructivePlanSha256: destructiveSha,
            destructive: 2,
            plan: [
              expect.objectContaining({ kind: 'additive', sql: ALTER }),
              expect.objectContaining({
                kind: 'destructive',
                sql: DROP_UNIQUE
              }),
              expect.objectContaining({
                kind: 'destructive',
                sql: DROP_COLUMN
              }),
              expect.objectContaining({ kind: 'additive', sql: INDEX })
            ]
          })
        );
        expectSessionRestoredAndReleased(fake);
      } finally {
        warn.mockRestore();
      }
    });

    it('in block mode applies a destructive plan whose hash was acknowledged', async () => {
      const fake = fakeDataSource({ plan: destructivePlan });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'block',
          acknowledgedDestructivePlanSha256: destructiveSha,
          catalog: plainColumnCatalog
        })
      ).resolves.toEqual({
        planned: 4,
        applied: 4,
        destructivePlanSha256: destructiveSha
      });
      expect(fake.ddl()).toEqual([ALTER, DROP_UNIQUE, DROP_COLUMN, INDEX]);
    });

    it('in block mode refuses an acknowledgement for a different plan', async () => {
      const fake = fakeDataSource({ plan: destructivePlan });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'block',
          acknowledgedDestructivePlanSha256: destructivePlanSha256([
            { query: DROP_COLUMN }
          ]),
          catalog: plainColumnCatalog
        })
      ).rejects.toBeInstanceOf(SchemaSyncDestructivePlanRefusedError);
      expect(fake.ddl()).toEqual([]);
    });

    it('by default reports a destructive plan and applies it as before', async () => {
      delete process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV];
      const warn = jest.spyOn(Logger.get('SCHEMA_SYNC'), 'warn');
      const fake = fakeDataSource({ plan: destructivePlan });
      try {
        await expect(
          synchronizeSchemaBounded(fake.dataSource, {
            sleep: noSleep,
            catalog: plainColumnCatalog
          })
        ).resolves.toEqual({
          planned: 4,
          applied: 4,
          destructivePlanSha256: destructiveSha
        });
        expect(fake.ddl()).toEqual([ALTER, DROP_UNIQUE, DROP_COLUMN, INDEX]);
        expect(warn).toHaveBeenCalledWith(
          '[SCHEMA_SYNC_DESTRUCTIVE_PLAN]',
          expect.objectContaining({ mode: 'report', decision: 'reported' })
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('turns blocking on from the environment', async () => {
      process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV] = 'block';
      const fake = fakeDataSource({ plan: destructivePlan });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          catalog: plainColumnCatalog
        })
      ).rejects.toBeInstanceOf(SchemaSyncDestructivePlanRefusedError);
      expect(fake.ddl()).toEqual([]);
    });

    it('fails on an unrecognised guard setting before connecting', async () => {
      process.env[SCHEMA_SYNC_DESTRUCTIVE_GUARD_ENV] = 'blocking';
      const fake = fakeDataSource({ plan: destructivePlan });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          catalog: plainColumnCatalog
        })
      ).rejects.toThrow(/must be "report" or "block"/);
      expect(fake.dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(fake.statements).toEqual([]);
    });

    it('applies a plan without destructive statements in block mode', async () => {
      const fake = fakeDataSource({
        plan: [
          { query: ALTER },
          { query: METADATA, parameters: ['expr', 'GENERATED_COLUMN', 'x'] },
          { query: INDEX }
        ]
      });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'block'
        })
      ).resolves.toEqual({ planned: 3, applied: 3 });
    });

    it('reads catalog facts on the sync connection when none is given', async () => {
      const fake = fakeDataSource({ plan: [{ query: DROP_COLUMN }] });
      const query = fake.queryRunner.query.getMockImplementation()!;
      fake.queryRunner.query.mockImplementation(async (sql, parameters) =>
        sql.includes('information_schema.COLUMNS')
          ? [{ generation_expression: 'a + 1' }]
          : query(sql, parameters)
      );
      // A generated column is derived, so dropping it is not destructive.
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'block'
        })
      ).resolves.toEqual({ planned: 1, applied: 1 });
      expect(fake.ddl()).toEqual([DROP_COLUMN]);
      expect(fake.queryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.COLUMNS'),
        [null, 'ws_connections', 'legacy']
      );
    });

    it('in report mode applies the plan even when the check itself fails', async () => {
      const fake = fakeDataSource({ plan: [{ query: DROP_COLUMN }] });
      await expect(
        synchronizeSchemaBounded(fake.dataSource, {
          sleep: noSleep,
          destructiveGuardMode: 'report',
          catalog: {
            column: async () => {
              throw new Error('catalog unavailable');
            },
            index: async () => null
          }
        })
      ).resolves.toEqual({ planned: 1, applied: 1 });
    });
  });
});
