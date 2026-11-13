jest.mock('@/loop-health-read', () => ({ readLoopHealthRows: jest.fn() }));
jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { readLoopHealthRows } from '@/loop-health-read';
import { reportLoopHealth } from '@/loop-health';
import { DelegationsLoopHealth } from './delegations-loop-health';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readLoopHealthRows).mockResolvedValue([{ timestamp: 100 }]);
});
it('tracks committed stages and releases maintenance without claiming the scheduled scan caught up', async () => {
  const health = await DelegationsLoopHealth.start(true);
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'indexing',
      pending: true,
      progressAt: undefined
    })
  );
  health.committedStage();
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: 'recalculation',
      pending: true,
      progressAt: expect.any(Number)
    })
  );
  health.completed();
  const calls = jest
    .mocked(reportLoopHealth)
    .mock.calls.map(([value]) => value);
  expect(calls).toContainEqual(
    expect.objectContaining({ operation: 'recalculation', pending: false })
  );
  expect(
    calls
      .filter((value) => value.operation === 'indexing')
      .every((value) => value.pending)
  ).toBe(true);
});
it('reports the actual committed scan watermark instead of the handler finish time', async () => {
  const health = await DelegationsLoopHealth.start(false);
  health.completed(200);
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: 'indexing',
      pending: false,
      watermarkAt: 200
    })
  );
});

it('does not promise automatic replay after synchronous maintenance fails', async () => {
  const health = await DelegationsLoopHealth.start(true);
  health.failed();
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: 'recalculation',
      pending: true,
      recovery: 'unavailable'
    })
  );
});
it('keeps missing checkpoint evidence unknown and does not fail business work', async () => {
  jest.mocked(readLoopHealthRows).mockImplementation(() => {
    throw new Error('read failed');
  });
  const health = await DelegationsLoopHealth.start(false);
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ pending: true, recovery: 'unknown' })
  );
  health.committedStage();
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ recovery: 'unknown' })
  );
});
