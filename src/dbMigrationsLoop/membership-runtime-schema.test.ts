import { DataSource } from 'typeorm';
import { MembershipRefreshRunEntity } from '@/entities/IMembershipRefreshRun';
import { MembershipRuntimeCheckpointEntity } from '@/entities/IMembershipRuntimeCheckpoint';
import { applyMembershipRuntimeSchema } from './membership-runtime-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

describe('Membership runtime schema preflight deadline', () => {
  it('discards a stalled inspection lease before either approved DDL statement', async () => {
    const physical = { destroy: jest.fn() };
    const runner = {
      connect: jest.fn().mockResolvedValue(physical),
      release: jest.fn().mockResolvedValue(undefined),
      hasTable: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT @@SESSION')) return [{ value: '31536000' }];
        if (sql.startsWith('SHOW INDEX')) return new Promise(() => undefined);
        return undefined;
      })
    };
    const log = jest.fn();
    const source = {
      entityMetadatas: [
        { target: MembershipRefreshRunEntity },
        { target: MembershipRuntimeCheckpointEntity }
      ],
      createQueryRunner: () => runner,
      driver: { createSchemaBuilder: () => ({ log }) }
    } as unknown as DataSource;
    await expect(
      applyMembershipRuntimeSchema(source, {
        deadlineMillis: 100,
        statementMillis: 20
      })
    ).rejects.toThrow('inspection deadline');
    expect(log).not.toHaveBeenCalled();
    expect(
      runner.query.mock.calls.some(([sql]) => /^(CREATE|ALTER)\b/.test(sql))
    ).toBe(false);
    expect(physical.destroy).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
