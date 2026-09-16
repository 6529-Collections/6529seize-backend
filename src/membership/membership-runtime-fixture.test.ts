import { DbPoolName, type DbQueryOptions } from '@/db-query.options';
import { SqlExecutor, type ConnectionWrapper } from '@/sql-executor';
import { MembershipRuntimeFixtureDb } from './membership-runtime-fixture.db';
import { withMembershipPrimaryTransaction } from './membership-primary';
import {
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_OWNER
} from './membership-runtime-policy';

class FixtureExecutor extends SqlExecutor {
  readonly connection = { connection: { selected: 'fixture' } };
  readonly queries: {
    sql: string;
    params?: Record<string, unknown>;
    options?: DbQueryOptions;
  }[] = [];
  constructor(private readonly results: unknown[][]) {
    super();
  }
  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    this.queries.push({ sql, params, options });
    return this.results.shift() as T[];
  }
  async executeNativeQueriesInTransaction<T>(
    callback: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    return callback(this.connection);
  }
}
const selected = [{ selected_database: MEMBERSHIP_FIXTURE_DATABASE }];
const marker = [{ id: MEMBERSHIP_FIXTURE_OWNER, protocol_version: 1 }];
const check = (db: FixtureExecutor) =>
  withMembershipPrimaryTransaction(db, (ctx) =>
    new MembershipRuntimeFixtureDb(db).assertOwnedDatabase(ctx)
  );

describe('isolated membership runtime ownership guard', () => {
  it.each([1, '1'])(
    'requires fixed DATABASE and exact marker on the same live primary context (protocol %s)',
    async (protocol_version) => {
      const db = new FixtureExecutor([
        selected,
        [{ ...marker[0], protocol_version }]
      ]);
      await expect(check(db)).resolves.toBeUndefined();
      expect(db.queries).toHaveLength(2);
      expect(db.queries[0].sql).toBe('SELECT DATABASE() AS selected_database');
      expect(db.queries[1]).toMatchObject({
        sql: 'SELECT id, protocol_version FROM membership_runtime_fixture_control WHERE id = :id LIMIT 2',
        params: { id: MEMBERSHIP_FIXTURE_OWNER }
      });
      for (const query of db.queries)
        expect(query.options).toEqual({
          wrappedConnection: db.connection,
          forcePool: DbPoolName.WRITE
        });
    }
  );
  it.each(
    [
      [],
      [{ selected_database: null }],
      [{ selected_database: 'application' }],
      [...selected, ...selected]
    ].map((rows) => ({ rows }))
  )(
    'rejects a missing, shared or ambiguous database before reading the marker %j',
    async ({ rows }) => {
      const db = new FixtureExecutor([rows, marker]);
      await expect(check(db)).rejects.toThrow('database selection mismatch');
      expect(db.queries).toHaveLength(1);
    }
  );
  it.each(
    [
      [],
      [{ id: 'other-owner', protocol_version: 1 }],
      [{ id: MEMBERSHIP_FIXTURE_OWNER, protocol_version: '01' }],
      [{ id: MEMBERSHIP_FIXTURE_OWNER, protocol_version: 2 }],
      [...marker, ...marker]
    ].map((rows) => ({ rows }))
  )('rejects absent or incompatible fixture ownership %j', async ({ rows }) => {
    await expect(check(new FixtureExecutor([selected, rows]))).rejects.toThrow(
      'ownership marker'
    );
  });
  it('rejects an unbound context before querying any database', async () => {
    const db = new FixtureExecutor([selected, marker]);
    await expect(
      new MembershipRuntimeFixtureDb(db).assertOwnedDatabase(
        {} as Parameters<MembershipRuntimeFixtureDb['assertOwnedDatabase']>[0]
      )
    ).rejects.toThrow('active primary');
    expect(db.queries).toHaveLength(0);
  });
});
