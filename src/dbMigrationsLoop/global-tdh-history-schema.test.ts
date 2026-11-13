import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { MetadataUtils } from 'typeorm/metadata-builder/MetadataUtils';
import {
  GlobalTDHHistory,
  LatestGlobalTDHHistory,
  TDHHistory
} from '@/entities/ITDHHistory';

type RunSql = (sql: string, params?: unknown[]) => Promise<unknown>;

const { widenGlobalTdhHistory } =
  require('../../migrations/20261113065624-widen-global-tdh-history-values.js') as {
    widenGlobalTdhHistory: (
      db: { runSql: RunSql },
      sleep: (delay: number) => Promise<void>
    ) => Promise<void>;
  };

function wideColumns(entity: typeof GlobalTDHHistory | typeof TDHHistory) {
  return getMetadataArgsStorage()
    .filterColumns(MetadataUtils.getInheritanceTree(entity))
    .filter((column) => column.options.type === 'bigint')
    .map((column) => column.propertyName)
    .sort((left, right) => left.localeCompare(right));
}

describe('global TDH history SQL migration', () => {
  it('widens exactly the global BIGINT columns and retries a transient lock timeout', async () => {
    const columns = wideColumns(GlobalTDHHistory);
    const sleep = jest.fn(async () => undefined);
    const lockTimeout = Object.assign(new Error('metadata lock timeout'), {
      code: 'ER_LOCK_WAIT_TIMEOUT'
    });
    let alterCount = 0;
    const runSql = jest.fn<ReturnType<RunSql>, Parameters<RunSql>>(
      async (sql) => {
        if (sql.includes('information_schema.columns')) {
          return columns.map((name) => ({
            name,
            data_type: 'int',
            column_type: 'int',
            is_nullable: 'NO'
          }));
        }
        if (sql.startsWith('SELECT @@SESSION')) {
          return [{ lock_wait_timeout: '31536000' }];
        }
        if (sql.startsWith('ALTER TABLE') && ++alterCount === 1) {
          throw lockTimeout;
        }
      }
    );

    await widenGlobalTdhHistory({ runSql }, sleep);

    const alters = runSql.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.startsWith('ALTER TABLE'));
    expect(alters).toHaveLength(3);
    expect(alters[0]).toBe(alters[1]);
    expect(alters[0]).toContain('ALTER TABLE tdh_global_history ');
    expect(alters[2]).toContain('ALTER TABLE latest_tdh_global_history ');
    for (const alter of alters) {
      const actual = Array.from(
        alter.matchAll(/MODIFY COLUMN (\w+) BIGINT NOT NULL/g),
        ([, name]) => name
      ).sort((left, right) => left.localeCompare(right));
      expect(actual).toEqual(columns);
    }
    expect(wideColumns(LatestGlobalTDHHistory)).toEqual(columns);
    expect(wideColumns(TDHHistory)).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(runSql).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
  });
});
