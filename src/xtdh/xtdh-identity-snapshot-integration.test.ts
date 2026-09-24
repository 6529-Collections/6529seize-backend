import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { XTdhIdentitySnapshotDb } from './xtdh-identity-snapshot.db';

const identity = anIdentity({
  produced_xtdh: 10,
  granted_xtdh: 3,
  rep: 10,
  tdh: 20,
  xtdh: 5,
  level_raw: 35
});
describeWithSeed(
  'xTDH snapshot concurrency',
  withIdentities([identity]),
  () => {
    const repo = new XTdhIdentitySnapshotDb(() => sqlExecutor);

    it('allows REP to commit during calculation and publishes without overwriting it', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          try {
            await repo.prepare(ctx);
            await repo.writeValues(
              [{ consolidation_key: identity.consolidation_key, xtdh: 40 }],
              'xtdh',
              ctx
            );
            // This separate transaction must finish while the calculation remains open.
            await sqlExecutor.executeNativeQueriesInTransaction(
              async (other) => {
                await sqlExecutor.execute(
                  'SET SESSION innodb_lock_wait_timeout = 2',
                  undefined,
                  { wrappedConnection: other }
                );
                try {
                  await sqlExecutor.execute(
                    'UPDATE identities SET rep = rep + 7, level_raw = level_raw + 7 WHERE consolidation_key = :key',
                    { key: identity.consolidation_key },
                    { wrappedConnection: other }
                  );
                } finally {
                  await sqlExecutor.execute(
                    'SET SESSION innodb_lock_wait_timeout = DEFAULT',
                    undefined,
                    { wrappedConnection: other }
                  );
                }
              }
            );
            const before = await sqlExecutor.oneOrNull<{ xtdh: number }>(
              'SELECT xtdh FROM identities WHERE consolidation_key = :key',
              { key: identity.consolidation_key }
            );
            expect(before?.xtdh).toBe(5);
            await repo.publish(ctx);
          } finally {
            await repo.discard(ctx);
          }
        },
        { isolationLevel: 'REPEATABLE READ' }
      );
      const result = await sqlExecutor.oneOrNull<{
        rep: number;
        tdh: number;
        xtdh: number;
        level_raw: number;
      }>(
        'SELECT rep, tdh, xtdh, level_raw FROM identities WHERE consolidation_key = :key',
        { key: identity.consolidation_key }
      );
      expect(result).toEqual({ rep: 17, tdh: 20, xtdh: 40, level_raw: 77 });
    });

    it('publishes zero when a prior nonzero contribution disappears', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          try {
            await repo.prepare({ connection });
            await repo.publish({ connection });
          } finally {
            await repo.discard({ connection });
          }
        },
        { isolationLevel: 'REPEATABLE READ' }
      );
      const result = await sqlExecutor.oneOrNull(
        'SELECT produced_xtdh, granted_xtdh, xtdh, xtdh_rate, level_raw FROM identities WHERE consolidation_key = :key',
        { key: identity.consolidation_key }
      );
      expect(result).toEqual({
        produced_xtdh: 0,
        granted_xtdh: 0,
        xtdh: 0,
        xtdh_rate: 0,
        level_raw: 30
      });
    });

    it('keeps the seed and calculation identity set stable across concurrent inserts', async () => {
      const added = anIdentity({ xtdh: 8 });
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          try {
            await repo.prepare({ connection });
            await sqlExecutor.executeNativeQueriesInTransaction((other) =>
              sqlExecutor.bulkInsert(
                'identities',
                [added],
                Object.keys(added),
                { connection: other }
              )
            );
            const calculated = await sqlExecutor.execute<{
              consolidation_key: string;
            }>('SELECT consolidation_key FROM identities', undefined, {
              wrappedConnection: connection
            });
            expect(calculated.map((row) => row.consolidation_key)).toEqual([
              identity.consolidation_key
            ]);
            await repo.writeValues(
              calculated.map((row) => ({ ...row, xtdh: 40 })),
              'xtdh',
              { connection }
            );
            await repo.publish({ connection });
          } finally {
            await repo.discard({ connection });
          }
        },
        { isolationLevel: 'REPEATABLE READ' }
      );
      expect(
        await sqlExecutor.oneOrNull(
          'SELECT xtdh FROM identities WHERE consolidation_key = :key',
          { key: added.consolidation_key }
        )
      ).toEqual({ xtdh: 8 });
    });

    it('leaves the live snapshot unchanged when calculation fails', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            try {
              await repo.prepare({ connection });
              await repo.writeValues(
                [{ consolidation_key: identity.consolidation_key, xtdh: 99 }],
                'xtdh',
                { connection }
              );
              throw new Error('calculation failed');
            } finally {
              await repo.discard({ connection });
            }
          },
          { isolationLevel: 'REPEATABLE READ' }
        )
      ).rejects.toThrow('calculation failed');
      const result = await sqlExecutor.oneOrNull<{ xtdh: number }>(
        'SELECT xtdh FROM identities WHERE consolidation_key = :key',
        { key: identity.consolidation_key }
      );
      expect(result?.xtdh).toBe(5);
    });
  }
);
