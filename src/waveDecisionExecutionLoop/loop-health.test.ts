jest.mock('@/loop-health-read', () => ({ readLoopHealthRows: jest.fn() }));
jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { readLoopHealthRows } from '@/loop-health-read';
import { reportLoopHealth } from '@/loop-health';
import { observeDecisionBacklogs } from './loop-health';

beforeEach(() => jest.resetAllMocks());
it('monitors the oldest overdue decision and incomplete publication independently', async () => {
  const execute = jest
    .fn()
    .mockResolvedValueOnce([{ oldest: 1_000_000 }])
    .mockResolvedValueOnce([{ oldest: 2_000_000 }]);
  jest.mocked(readLoopHealthRows).mockImplementation(execute);
  await observeDecisionBacklogs();
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'decisions',
      pending: true,
      oldestPendingAt: 1000,
      deadlineAt: 1300
    })
  );
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'publication',
      pending: true,
      oldestPendingAt: 2000
    })
  );
  expect(execute.mock.calls[1][0]).toContain('delivered_at is null');
  expect(execute.mock.calls[1][0]).not.toContain('next_attempt_at <=');
});
it('reports verified empty work without requiring decisions to exist', async () => {
  jest.mocked(readLoopHealthRows).mockResolvedValue([{ oldest: null }]);
  await observeDecisionBacklogs();
  expect(reportLoopHealth).toHaveBeenCalledTimes(2);
  for (const [value] of jest.mocked(reportLoopHealth).mock.calls)
    expect(value.pending).toBe(false);
});

it('exports the next future obligation without pretending it is already overdue', async () => {
  const dueAt = Date.now() + 60_000;
  jest
    .mocked(readLoopHealthRows)
    .mockResolvedValueOnce([{ oldest: dueAt }])
    .mockResolvedValueOnce([{ oldest: null }]);
  await observeDecisionBacklogs();
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'decisions',
      pending: false,
      nextDueAt: Math.floor(dueAt / 1000),
      deadlineAt: Math.floor(dueAt / 1000) + 300
    })
  );
});
it.each([undefined, 'invalid', 0])(
  'does not manufacture healthy observations from malformed oldest=%s',
  async (oldest) => {
    jest.mocked(readLoopHealthRows).mockResolvedValue([{ oldest }]);
    await observeDecisionBacklogs();
    expect(reportLoopHealth).not.toHaveBeenCalled();
  }
);
it('keeps telemetry unavailable when queries fail and does not replace worker failures', async () => {
  jest.mocked(readLoopHealthRows).mockRejectedValue(new Error('read failed'));
  await expect(observeDecisionBacklogs()).resolves.toBeUndefined();
  expect(reportLoopHealth).not.toHaveBeenCalled();
});
