import { getDataSource } from '@/db';
import { withBackfillRunnerLock } from './backfill-runner.db';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const identity = {
  server_uuid: '00000000-1111-2222-3333-444444444444',
  database_name: 'analysis_test'
};

function fakeRunner() {
  const physical = { destroy: jest.fn() };
  return {
    physical,
    connect: jest.fn().mockResolvedValue(physical),
    release: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(),
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('@@server_uuid')) return [identity];
      if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
      if (sql.includes('IS_USED_LOCK')) return [{ held: 1 }];
      if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
      throw new Error('Unexpected test query');
    })
  };
}

describe('backfill runner database lease', () => {
  let runner: ReturnType<typeof fakeRunner>;

  beforeEach(() => {
    runner = fakeRunner();
    jest.mocked(getDataSource).mockReturnValue({
      createQueryRunner: () => runner
    } as unknown as ReturnType<typeof getDataSource>);
  });

  it('holds and checks one connection without an idle transaction, then releases the same 64-character lock', async () => {
    await expect(
      withBackfillRunnerLock(identity, async (lease) => {
        expect(runner.release).not.toHaveBeenCalled();
        await lease.assertHeld();
        await lease.assertHeld();
        return 'finished';
      })
    ).resolves.toBe('finished');
    expect(runner.connect).toHaveBeenCalledTimes(1);
    expect(runner.startTransaction).not.toHaveBeenCalled();
    const lockCalls = runner.query.mock.calls.filter(([sql]) =>
      sql.includes('_LOCK')
    );
    expect(lockCalls).toHaveLength(4);
    const names = lockCalls.map(([, parameters]) => parameters[0]);
    expect(names[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(names).size).toBe(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(runner.physical.destroy).not.toHaveBeenCalled();
  });

  it('does not run work or acquire a lock on an unexpected database', async () => {
    const work = jest.fn();
    await expect(
      withBackfillRunnerLock({ ...identity, database_name: 'different' }, work)
    ).rejects.toThrow('database identity changed');
    expect(work).not.toHaveBeenCalled();
    expect(runner.query).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a second runner without releasing another connection's lock", async () => {
    runner.query
      .mockResolvedValueOnce([identity])
      .mockResolvedValueOnce([{ acquired: 0 }]);
    const work = jest.fn();
    await expect(withBackfillRunnerLock(identity, work)).rejects.toThrow(
      'Another backfill runner'
    );
    expect(work).not.toHaveBeenCalled();
    expect(runner.query).toHaveBeenCalledTimes(2);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease after callback failure', async () => {
    const failure = new Error('Synthetic work failure');
    await expect(
      withBackfillRunnerLock(identity, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(runner.query).toHaveBeenLastCalledWith(
      'SELECT RELEASE_LOCK(?) AS released',
      [expect.any(String)]
    );
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it.each(['lost', 'disconnect'])(
    'latches %s lease failure and rejects every later assertion',
    async (mode) => {
      await withBackfillRunnerLock(identity, async (lease) => {
        if (mode === 'lost') runner.query.mockResolvedValueOnce([{ held: 0 }]);
        else
          runner.query.mockRejectedValueOnce(new Error('Synthetic disconnect'));
        await expect(lease.assertHeld()).rejects.toThrow('lease was lost');
        const calls = runner.query.mock.calls.length;
        await expect(lease.assertHeld()).rejects.toThrow('lease was lost');
        expect(runner.query).toHaveBeenCalledTimes(calls);
      });
    }
  );

  it('discards only the lease connection when release fails', async () => {
    await expect(
      withBackfillRunnerLock(identity, async () => {
        runner.query.mockRejectedValueOnce(
          new Error('Synthetic release failure')
        );
      })
    ).rejects.toThrow('connection discarded');
    expect(runner.physical.destroy).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
