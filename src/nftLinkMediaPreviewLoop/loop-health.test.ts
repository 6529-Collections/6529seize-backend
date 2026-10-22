import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';
import { observePreviewBacklog } from './loop-health';

jest.mock('@/loop-health');
jest.mock('@/loop-health-read');
const read = jest.mocked(readLoopHealthRows);
const report = jest.mocked(reportLoopHealth);
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
});
afterEach(() => jest.restoreAllMocks());

it('uses original queued age and saved successes, without claiming all DB rows have a deliverable retry', async () => {
  read.mockResolvedValueOnce([
    { pending: '2', unknown_age: 0, oldest: 1_000_000, progress: 1_900_000 }
  ]);
  await observePreviewBacklog();
  expect(report).toHaveBeenCalledWith({
    operation: 'processing',
    pending: true,
    oldestPendingAt: 1000,
    progressAt: 1900,
    recovery: 'unknown'
  });
  const sql = read.mock.calls[0][0];
  expect(sql).not.toContain('last_tried_at');
  expect(sql).not.toContain('locked_since');
});

it('accepts a verified empty active backlog, independent of individual asset errors', async () => {
  read.mockResolvedValueOnce([
    { pending: 0, unknown_age: 0, oldest: null, progress: null }
  ]);
  await observePreviewBacklog();
  expect(report.mock.calls[0][0]).toMatchObject({
    pending: false,
    recovery: 'automatic'
  });
});

it.each(
  [
    [],
    [{ pending: 1, unknown_age: 1, oldest: null, progress: null }],
    [{ pending: 1, unknown_age: 0, oldest: null, progress: null }],
    [{ pending: 0, unknown_age: 0, oldest: null, progress: 3_000_000 }]
  ].map((rows) => ({ rows }))
)(
  'does not claim recovery from incomplete/invalid evidence %p',
  async ({ rows }) => {
    read.mockResolvedValueOnce(rows);
    await observePreviewBacklog();
    expect(report).not.toHaveBeenCalled();
  }
);

it('leaves evidence unchanged on diagnostic failure', async () => {
  read.mockRejectedValueOnce(new Error('budget expired'));
  await expect(observePreviewBacklog()).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
});
