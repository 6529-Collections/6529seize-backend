import { DbPoolName, type DbQueryOptions } from '@/db-query.options';
import { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { type ConnectionWrapper, SqlExecutor } from '@/sql-executor';

class RecordingSqlExecutor extends SqlExecutor {
  public readonly calls: {
    readonly sql: string;
    readonly params?: Record<string, unknown>;
    readonly options?: DbQueryOptions;
  }[] = [];

  public async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    this.calls.push({ sql, params, options });
    if (sql.trimStart().startsWith('update'))
      return { affectedRows: 1 } as unknown as T[];
    return [
      {
        name: 'scheduler',
        lease_token: 'writer-visible-token'
      }
    ] as T[];
  }

  public async executeNativeQueriesInTransaction<T>(
    _executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    throw new Error('Not used by this test');
  }
}

describe('ReleaseBusV2Repository', () => {
  it('reads an acquired lock back from the write pool', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);

    await expect(
      repository.acquireLock('scheduler', null, 'selection', 300_000, {})
    ).resolves.toEqual(
      expect.objectContaining({ lease_token: 'writer-visible-token' })
    );

    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]?.options).toEqual({ forcePool: DbPoolName.WRITE });
  });

  it('drains nonterminal operations by exact lane even under terminal trains', async () => {
    const db = new RecordingSqlExecutor();
    const repository = new ReleaseBusV2Repository(() => db);

    await repository.listNonterminalOperationsForLanes(
      ['STAGING', 'PRODUCTION_QUALIFICATION'],
      {}
    );

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.sql).toContain(
      "operations.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED')"
    );
    expect(db.calls[0]?.sql).toContain(
      'inner join release_bus_v2_trains trains'
    );
    expect(db.calls[0]?.sql).toContain('trains.lane in (:lanes)');
    expect(db.calls[0]?.params).toEqual({
      lanes: ['STAGING', 'PRODUCTION_QUALIFICATION']
    });
  });
});
