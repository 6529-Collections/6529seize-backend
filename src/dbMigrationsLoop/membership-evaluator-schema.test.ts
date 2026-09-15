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
      expect.stringMatching(/^SHOW INDEX/)
    );
    expect(f.runner.query).toHaveBeenCalledWith(
      'SET SESSION lock_wait_timeout = ?',
      [31536000]
    );
    expect(f.source.synchronize).not.toHaveBeenCalled();
    expect(f.physical.destroy).not.toHaveBeenCalled();
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });
  it('reconciles an already present exact index without repeating the DDL', async () => {
    const f = fixture(true);
    await expect(applyMembershipEvaluatorSchema(f.source)).resolves.toEqual({
      added_indexes: 0,
      verified_indexes: 1
    });
    expect(f.runner.connect).not.toHaveBeenCalled();
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
      expect(f.runner.connect).not.toHaveBeenCalled();
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
    f.runner.query.mockResolvedValueOnce(
      indexRows().map((row) => ({ ...row, ...overrides }))
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
    expect(params.runner.connect).not.toHaveBeenCalled();
  });
  it('settles a suppressed DDL callback at its deadline and discards the connection', async () => {
    const f = fixture();
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
  });
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
