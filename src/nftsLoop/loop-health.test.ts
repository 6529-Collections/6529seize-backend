import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';
import { isS3UploaderEnabledForEnvironment } from '@/s3Uploader/s3-uploader.queue';
import { NftsLoopHealth, observeNftPublication } from './loop-health';

jest.mock('@/loop-health');
jest.mock('@/loop-health-read');
jest.mock('@/s3Uploader/s3-uploader.queue');
const report = jest.mocked(reportLoopHealth);
const read = jest.mocked(readLoopHealthRows);

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
  jest.mocked(isS3UploaderEnabledForEnvironment).mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

it('keeps mode completion separate and retains the next scheduled due time', () => {
  const audit = new NftsLoopHealth('audit');
  const discover = new NftsLoopHealth('discover');
  discover.verified();
  discover.completed();
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    operation: 'discovery',
    pending: false,
    nextDueAt: 2060
  });
  expect(report.mock.calls.filter(([v]) => v.operation === 'audit')).toEqual([
    [expect.objectContaining({ pending: true })]
  ]);
  audit.completed();
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    operation: 'audit',
    nextDueAt: 5600
  });
});

it('does not count a start or an incomplete unchanged pass as progress/recovery', () => {
  const health = new NftsLoopHealth('refresh');
  expect(report.mock.calls[0][0].progressAt).toBeUndefined();
  health.notCompleted();
  health.verified();
  health.completed();
  expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
    pending: true,
    recovery: 'unknown'
  });
  expect(report.mock.calls.at(-1)?.[0].progressAt).toBeUndefined();
});

it('bounds audit reporting without emitting progress on a timer', () => {
  const health = new NftsLoopHealth('audit');
  for (let i = 0; i < 100; i++) health.committed();
  expect(report).toHaveBeenCalledTimes(2);
  jest.spyOn(Date, 'now').mockReturnValue(2_031_000);
  health.committed();
  expect(report.mock.calls.at(-1)?.[0].progressAt).toBe(2031);
});

it('surveys durable unpublished work independently of mode completion', async () => {
  read.mockResolvedValueOnce([{ oldest: 1_000_000 }]);
  await observeNftPublication();
  expect(report).toHaveBeenLastCalledWith({
    operation: 'publication',
    pending: true,
    oldestPendingAt: 1000,
    recovery: 'automatic'
  });
  read.mockResolvedValueOnce([{ oldest: null }]);
  await observeNftPublication();
  expect(report.mock.calls.at(-1)?.[0].pending).toBe(false);
});

it('does not clear publication on a missing, invalid or failed diagnostic read', async () => {
  for (const rows of [[], [{ oldest: 'broken' }], [{ oldest: 9_000_000 }]]) {
    read.mockResolvedValueOnce(rows);
    await observeNftPublication();
  }
  read.mockRejectedValueOnce(new Error('diagnostic unavailable'));
  await expect(observeNftPublication()).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
});
