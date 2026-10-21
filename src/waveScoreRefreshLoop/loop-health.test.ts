jest.mock('@/loop-health-read', () => ({ readLoopHealthRows: jest.fn() }));
jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { readLoopHealthRows } from '@/loop-health-read';
import { reportLoopHealth } from '@/loop-health';
import { FullRefreshHealth, observeDirtyRefreshBacklog } from './loop-health';

const now = 2_000_000;
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
});
afterEach(() => jest.restoreAllMocks());

it('keeps the oldest dirty version pending across handled failures and retries', async () => {
  jest
    .mocked(readLoopHealthRows)
    .mockResolvedValue([{ dirty_at: '1900000000' }]);
  await observeDirtyRefreshBacklog();
  await observeDirtyRefreshBacklog();
  for (const [observation] of jest.mocked(reportLoopHealth).mock.calls) {
    expect(observation).toEqual({
      operation: 'dirty_refresh',
      pending: true,
      oldestPendingAt: 1_900_000,
      recovery: 'automatic'
    });
    expect(observation.progressAt).toBeUndefined();
  }
});

it('verifies dirty catch-up only from an empty persisted request backlog', async () => {
  jest.mocked(readLoopHealthRows).mockResolvedValue([]);
  await observeDirtyRefreshBacklog();
  expect(reportLoopHealth).toHaveBeenCalledWith({
    operation: 'dirty_refresh',
    pending: false,
    recovery: 'automatic'
  });
});

it.each(['invalid', '0', '2000001000'])(
  'leaves invalid/future dirty evidence %s unconfirmed',
  async (dirty_at) => {
    jest.mocked(readLoopHealthRows).mockResolvedValue([{ dirty_at }]);
    await observeDirtyRefreshBacklog();
    expect(reportLoopHealth).not.toHaveBeenCalled();
  }
);

it('cannot manufacture catch-up or interrupt business processing when diagnostics fail', async () => {
  jest.mocked(readLoopHealthRows).mockRejectedValue(new Error('unavailable'));
  await expect(observeDirtyRefreshBacklog()).resolves.toBeUndefined();
  expect(reportLoopHealth).not.toHaveBeenCalled();
});

it('records committed full-scan progress without clearing an outstanding continuation', () => {
  const health = new FullRefreshHealth(now - 120, true);
  health.committed(1000);
  health.continued();
  expect(reportLoopHealth).toHaveBeenLastCalledWith({
    operation: 'full_refresh',
    pending: true,
    oldestPendingAt: now - 120,
    progressAt: now,
    recovery: 'automatic'
  });
  health.completed();
  expect(reportLoopHealth).toHaveBeenLastCalledWith({
    operation: 'full_refresh',
    pending: false,
    progressAt: now,
    recovery: 'automatic'
  });
});

it('does not promise replay of a direct full invocation until its continuation is accepted', () => {
  const health = new FullRefreshHealth(now, false);
  health.committed(0);
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ pending: true, recovery: 'unknown' })
  );
  expect(
    jest.mocked(reportLoopHealth).mock.calls[1][0].progressAt
  ).toBeUndefined();
  health.continued();
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ pending: true, recovery: 'automatic' })
  );
});

it('does not clear full refreshes when a dirty survey catches up', async () => {
  new FullRefreshHealth(now - 900, true);
  jest.mocked(readLoopHealthRows).mockResolvedValue([]);
  await observeDirtyRefreshBacklog();
  expect(
    jest
      .mocked(reportLoopHealth)
      .mock.calls.map(([value]) => [value.operation, value.pending])
  ).toEqual([
    ['full_refresh', true],
    ['dirty_refresh', false]
  ]);
});

it.each([true, false])(
  'reports whether a failed full invocation has automatic replay: %s',
  (automaticRetry) => {
    const health = new FullRefreshHealth(now, automaticRetry);
    health.failed();
    expect(reportLoopHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pending: true,
        recovery: automaticRetry ? 'automatic' : 'unavailable'
      })
    );
  }
);
