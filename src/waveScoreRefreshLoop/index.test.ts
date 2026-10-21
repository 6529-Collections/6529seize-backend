jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('../secrets', () => ({
  doInDbContext: (work: () => Promise<void>) => work()
}));
jest.mock('../logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), warn: jest.fn() }) }
}));
jest.mock('../time', () => ({
  Timer: class {
    getReport() {
      return '';
    }
  }
}));
jest.mock('../sqs', () => ({ sqs: { sendToQueueName: jest.fn() } }));
jest.mock('@/loop-health-read', () => ({ readLoopHealthRows: jest.fn() }));
jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
jest.mock('../api-serverless/src/waves/wave-score.service', () => ({
  WAVE_SCORE_DIRTY_REFRESH_MESSAGE_GROUP_ID: 'dirty',
  WAVE_SCORE_DIRTY_REFRESH_QUEUE_NAME: 'wave-score-refresh-dirty.fifo',
  waveScoreService: {
    refreshDirtyWaveScores: jest.fn(),
    refreshAllWaveScores: jest.fn()
  }
}));

import { Context } from 'aws-lambda';
import { readLoopHealthRows } from '@/loop-health-read';
import { reportLoopHealth } from '@/loop-health';
import { waveScoreService } from '../api-serverless/src/waves/wave-score.service';
import { sqs } from '../sqs';
import { handler } from './index';

const now = 2_000_000;
const context = { getRemainingTimeInMillis: () => 60_000 } as Context;
const run = (event: unknown, ctx = context) => handler(event, ctx, jest.fn());
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
  jest.mocked(readLoopHealthRows).mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

it('does not turn a successful dirty return or attempted-wave count into recovery', async () => {
  jest
    .mocked(readLoopHealthRows)
    .mockResolvedValue([{ dirty_at: (now - 900) * 1000 }]);
  jest
    .mocked(waveScoreService.refreshDirtyWaveScores)
    .mockResolvedValue({ waves: 10, batches: 1, hasMore: false });
  await run({ mode: 'DIRTY' });
  expect(reportLoopHealth).toHaveBeenCalledTimes(2);
  for (const [value] of jest.mocked(reportLoopHealth).mock.calls) {
    expect(value).toMatchObject({
      operation: 'dirty_refresh',
      pending: true,
      oldestPendingAt: now - 900
    });
    expect(value.progressAt).toBeUndefined();
  }
});

it('surveys remaining dirty work even after a business failure, without masking the failure', async () => {
  const error = new Error('business failed');
  jest.mocked(waveScoreService.refreshDirtyWaveScores).mockRejectedValue(error);
  jest
    .mocked(readLoopHealthRows)
    .mockResolvedValue([{ dirty_at: (now - 900) * 1000 }]);
  await expect(run({ mode: 'DIRTY' })).rejects.toBe(error);
  expect(reportLoopHealth).toHaveBeenCalledTimes(2);
  expect(reportLoopHealth).toHaveBeenLastCalledWith(
    expect.objectContaining({ pending: true })
  );
});

it('retains the original full-refresh obligation across confirmed continuation handoffs', async () => {
  jest
    .mocked(waveScoreService.refreshAllWaveScores)
    .mockResolvedValueOnce({
      waves: 1000,
      batches: 10,
      hasMore: true,
      lastWaveId: 'cursor',
      startedAfterWaveId: null
    })
    .mockResolvedValueOnce({
      waves: 0,
      batches: 0,
      hasMore: false,
      lastWaveId: 'cursor',
      startedAfterWaveId: 'cursor'
    });
  await run({
    Records: [
      {
        eventSource: 'aws:sqs',
        body: '{}',
        attributes: { SentTimestamp: String((now - 120) * 1000) }
      }
    ]
  });
  const continuation = jest.mocked(sqs.sendToQueueName).mock.calls[0][0];
  expect(continuation).toMatchObject({
    message: {
      mode: 'FULL',
      startAfterWaveId: 'cursor'
    },
    messageAttributes: {
      LoopHealthStartedAt: {
        DataType: 'Number',
        StringValue: String((now - 120) * 1000)
      }
    }
  });
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'full_refresh',
      pending: true,
      progressAt: now,
      oldestPendingAt: now - 120,
      recovery: 'automatic'
    })
  );
  expect(
    jest
      .mocked(reportLoopHealth)
      .mock.calls.some(([v]) => v.operation === 'full_refresh' && !v.pending)
  ).toBe(false);
  jest.mocked(reportLoopHealth).mockClear();
  await run({
    Records: [
      {
        eventSource: 'aws:sqs',
        body: JSON.stringify(continuation.message),
        messageAttributes: {
          LoopHealthStartedAt: {
            stringValue:
              continuation.messageAttributes?.LoopHealthStartedAt.StringValue
          }
        },
        attributes: { SentTimestamp: String(now * 1000) }
      }
    ]
  });
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'full_refresh',
      pending: true,
      oldestPendingAt: now - 120
    })
  );
  expect(reportLoopHealth).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'full_refresh', pending: false })
  );
});

it('cannot clear or promise recovery for a direct full refresh whose continuation failed', async () => {
  jest.mocked(waveScoreService.refreshAllWaveScores).mockResolvedValue({
    waves: 1000,
    batches: 10,
    hasMore: true,
    lastWaveId: 'cursor',
    startedAfterWaveId: null
  });
  const error = new Error('enqueue failed');
  jest.mocked(sqs.sendToQueueName).mockRejectedValue(error);
  await expect(run({ mode: 'FULL' })).rejects.toBe(error);
  const full = jest
    .mocked(reportLoopHealth)
    .mock.calls.map(([v]) => v)
    .filter((v) => v.operation === 'full_refresh');
  expect(full).toHaveLength(3);
  expect(full.every((v) => v.pending)).toBe(true);
  expect(full[1].progressAt).toBe(now);
  expect(full[2]).toMatchObject({ pending: true, recovery: 'unavailable' });
});

it('skips diagnostic reads near the unchanged Lambda timeout', async () => {
  jest
    .mocked(waveScoreService.refreshDirtyWaveScores)
    .mockResolvedValue({ waves: 0, batches: 0, hasMore: false });
  await run({ mode: 'DIRTY' }, {
    getRemainingTimeInMillis: () => 4000
  } as Context);
  expect(readLoopHealthRows).not.toHaveBeenCalled();
  expect(waveScoreService.refreshDirtyWaveScores).toHaveBeenCalled();
});
