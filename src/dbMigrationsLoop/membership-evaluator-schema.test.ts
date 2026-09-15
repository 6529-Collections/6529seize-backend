import { DataSource, QueryRunner } from 'typeorm';
import { UserGroupEntity } from '@/entities/IUserGroup';
import {
  applyMembershipEvaluatorSchema,
  MEMBERSHIP_EVALUATOR_INDEX,
  MEMBERSHIP_EVALUATOR_INDEX_PLAN,
  MEMBERSHIP_EVALUATOR_INDEX_ONLINE
} from './membership-evaluator-schema';
import { executeMembershipOnlineIndex } from './membership-additive-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

function indexRows() {
  return MEMBERSHIP_EVALUATOR_INDEX.columns.map((column, i) => ({
    Key_name: MEMBERSHIP_EVALUATOR_INDEX.name,
    Non_unique: 1,
    Seq_in_index: i + 1,
    Column_name: column,
    Collation: 'A',
    Sub_part: null,
    Index_type: 'BTREE',
    Visible: 'YES',
    Expression: null
  }));
}

function fixture(
  exists = false,
  plan = exists ? [] : [MEMBERSHIP_EVALUATOR_INDEX_PLAN]
) {
  let present = exists;
  const physical = { destroy: jest.fn() };
  const runner = {
    connect: jest.fn().mockResolvedValue(physical),
    hasTable: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string): Promise<unknown> => {
      if (sql.startsWith('SHOW INDEX')) return present ? indexRows() : [];
      if (sql.startsWith('SELECT @@SESSION')) return [{ value: '31536000' }];
      if (sql === MEMBERSHIP_EVALUATOR_INDEX_ONLINE) present = true;
      return undefined;
    })
  };
  const log = jest
    .fn()
    .mockResolvedValue({ upQueries: [] })
    .mockResolvedValueOnce({ upQueries: plan.map((query) => ({ query })) });
  const source = {
    entityMetadatas: [{ target: UserGroupEntity }],
    createQueryRunner: jest.fn(() => runner),
    driver: { createSchemaBuilder: () => ({ log }) },
    synchronize: jest.fn()
  };
  return { source: source as unknown as DataSource, runner, physical, log };
}

describe('Membership evaluator explicit online schema scope', () => {
  it('applies the inspected shape with pinned online DDL and numeric session restoration', async () => {
    const f = fixture();
    await expect(applyMembershipEvaluatorSchema(f.source)).resolves.toEqual({
      added_indexes: 1,
      verified_indexes: 1
    });
    expect(f.runner.query).toHaveBeenCalledWith(
      MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
      []
    );
    expect(f.runner.query).toHaveBeenLastCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.runner.query).toHaveBeenCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.source.synchronize).not.toHaveBeenCalled();
    expect(f.physical.destroy).not.toHaveBeenCalled();
    expect(f.runner.release).toHaveBeenCalledTimes(3);
  });
  it('reconciles an already present exact index without repeating the DDL', async () => {
    const f = fixture(true);
    await expect(applyMembershipEvaluatorSchema(f.source)).resolves.toEqual({
      added_indexes: 0,
      verified_indexes: 1
    });
    expect(f.runner.query).not.toHaveBeenCalledWith(
      MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
      []
    );
  });
  it.each(
    [
      [],
      [MEMBERSHIP_EVALUATOR_INDEX_PLAN, 'DROP TABLE x'],
      [MEMBERSHIP_EVALUATOR_INDEX_PLAN, MEMBERSHIP_EVALUATOR_INDEX_PLAN],
      ['ALTER TABLE community_groups DROP COLUMN id']
    ].map((plan) => ({ plan }))
  )(
    'rejects incomplete, extra or destructive plans before changes: %j',
    async ({ plan }) => {
      const f = fixture(false, plan);
      await expect(applyMembershipEvaluatorSchema(f.source)).rejects.toThrow(
        'unapproved or missing'
      );
      expect(f.runner.query).not.toHaveBeenCalledWith(
        MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
        []
      );
    }
  );
  it.each([
    { Visible: 'NO' },
    { Sub_part: 3 },
    { Collation: 'D' },
    { Non_unique: 0 },
    { Expression: 'id + 1' }
  ])('rejects incompatible actual index attributes: %j', async (overrides) => {
    const f = fixture(true);
    const original = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation((sql) =>
      sql.startsWith('SHOW INDEX')
        ? Promise.resolve(indexRows().map((row) => ({ ...row, ...overrides })))
        : original(sql)
    );
    await expect(applyMembershipEvaluatorSchema(f.source)).rejects.toThrow(
      'incompatible'
    );
    expect(f.log).not.toHaveBeenCalled();
  });
  it('rejects absent table, nonisolated metadata and parameterized plans before DDL', async () => {
    const absent = fixture();
    absent.runner.hasTable.mockResolvedValue(false);
    await expect(applyMembershipEvaluatorSchema(absent.source)).rejects.toThrow(
      'existing group table'
    );
    const mixed = fixture();
    Object.assign(mixed.source, { entityMetadatas: [] });
    await expect(applyMembershipEvaluatorSchema(mixed.source)).rejects.toThrow(
      'isolated'
    );
    const params = fixture();
    params.log.mockReset().mockResolvedValue({
      upQueries: [{ query: MEMBERSHIP_EVALUATOR_INDEX_PLAN, parameters: [1] }]
    });
    await expect(applyMembershipEvaluatorSchema(params.source)).rejects.toThrow(
      'unapproved'
    );
    expect(params.runner.query).not.toHaveBeenCalledWith(
      MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
      []
    );
  });
  it('bounds SHOW INDEX before DDL and settles even when physical disposal throws', async () => {
    const f = fixture();
    const original = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation((sql) =>
      sql.startsWith('SHOW INDEX')
        ? new Promise(() => undefined)
        : original(sql)
    );
    f.physical.destroy.mockImplementation(() => {
      throw new Error('dispose failed');
    });
    await expect(
      applyMembershipEvaluatorSchema(f.source, {
        deadlineMillis: 50,
        statementMillis: 10
      })
    ).rejects.toThrow('inspection deadline');
    expect(f.physical.destroy).toHaveBeenCalledTimes(1);
    expect(f.runner.query).not.toHaveBeenCalledWith(
      MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
      []
    );
  });
  it('confines builder-created runners, rejects queued/late reads after revocation and preserves the real factory', async () => {
    const f = fixture();
    const factory = f.source.createQueryRunner;
    let complete: (value: unknown) => void = () => undefined;
    let abandoned: QueryRunner | undefined;
    const original = f.runner.query.getMockImplementation()!;
    f.runner.query.mockImplementation((sql) =>
      sql === 'SELECT blocked'
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : original(sql)
    );
    f.log.mockReset().mockImplementation(async function (this: {
      connection: DataSource;
    }) {
      const borrowed = this.connection.createQueryRunner();
      abandoned = borrowed;
      await Promise.all([
        borrowed.query('SELECT blocked'),
        borrowed.query('SELECT queued')
      ]);
      await borrowed.query('SELECT late');
      return { upQueries: [] };
    });
    await expect(
      applyMembershipEvaluatorSchema(f.source, {
        deadlineMillis: 50,
        statementMillis: 10
      })
    ).rejects.toThrow('inspection deadline');
    complete([]);
    await expect(abandoned!.query('SELECT late')).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const forbidden of [
      'SELECT queued',
      'SELECT late',
      MEMBERSHIP_EVALUATOR_INDEX_ONLINE
    ])
      expect(f.runner.query.mock.calls.map(([sql]) => sql)).not.toContain(
        forbidden
      );
    expect(f.source.createQueryRunner).toBe(factory);
    expect(f.physical.destroy).toHaveBeenCalledTimes(1);
  });
  it('does not allow a builder log to execute uninspected writes', async () => {
    const f = fixture();
    f.log.mockReset().mockImplementation(async function (this: {
      connection: DataSource;
    }) {
      await this.connection
        .createQueryRunner()
        .query('CREATE TABLE uninspected(id int)');
      return { upQueries: [] };
    });
    await expect(applyMembershipEvaluatorSchema(f.source)).rejects.toThrow(
      'attempted a write'
    );
    expect(f.runner.query.mock.calls.map(([sql]) => sql)).not.toContain(
      'CREATE TABLE uninspected(id int)'
    );
  });
  it('bounds post-DDL verification independently and leaves reconciliation to a later invocation', async () => {
    const f = fixture();
    const original = f.runner.query.getMockImplementation()!;
    let inspections = 0;
    f.runner.query.mockImplementation((sql) => {
      if (sql.startsWith('SHOW INDEX') && ++inspections === 2)
        return new Promise(() => undefined);
      return original(sql);
    });
    await expect(
      applyMembershipEvaluatorSchema(f.source, {
        deadlineMillis: 50,
        statementMillis: 10
      })
    ).rejects.toThrow('inspection deadline');
    expect(
      f.runner.query.mock.calls.filter(
        ([sql]) => sql === MEMBERSHIP_EVALUATOR_INDEX_ONLINE
      )
    ).toHaveLength(1);
    expect(f.physical.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'settles a suppressed DDL callback even if disposal throws: %s',
    async (throwOnDispose) => {
      const f = fixture();
      if (throwOnDispose)
        f.physical.destroy.mockImplementation(() => {
          throw new Error('synthetic disposal failure');
        });
      const original = f.runner.query.getMockImplementation()!;
      f.runner.query.mockImplementation((sql) =>
        sql === MEMBERSHIP_EVALUATOR_INDEX_ONLINE
          ? new Promise(() => undefined)
          : original(sql)
      );
      await expect(
        executeMembershipOnlineIndex(
          f.runner as unknown as QueryRunner,
          MEMBERSHIP_EVALUATOR_INDEX_ONLINE,
          10
        )
      ).rejects.toThrow('unknown after deadline');
      expect(f.physical.destroy).toHaveBeenCalledTimes(1);
      expect(f.runner.query).not.toHaveBeenCalledWith(
        'SET SESSION lock_wait_timeout = ?',
        [31536000]
      );
    }
  );
  it('discards an unconfirmed restoration and preserves the first DDL error', async () => {
    const f = fixture();
    const failure = new Error('DDL failed');
    f.runner.query
      .mockReset()
      .mockResolvedValueOnce([{ value: '31536000' }])
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('restore failed'));
    await expect(
      executeMembershipOnlineIndex(
        f.runner as unknown as QueryRunner,
        MEMBERSHIP_EVALUATOR_INDEX_ONLINE
      )
    ).rejects.toBe(failure);
    expect(f.physical.destroy).toHaveBeenCalledTimes(1);
  });
});
