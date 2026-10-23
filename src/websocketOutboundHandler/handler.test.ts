import type { Context, Handler, ScheduledEvent, SQSEvent } from 'aws-lambda';

jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: Handler) => handler
}));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<unknown>) => work())
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: jest.fn() }) }
}));
jest.mock('@/api/ws/ws', () => ({
  appWebSockets: { send: jest.fn(), deliverQueued: jest.fn() }
}));
jest.mock('@/websocket-outbox/health', () => ({
  reportWebSocketOutboxHealth: jest.fn()
}));
jest.mock('@/websocket-outbox/publisher', () => ({
  publishWebSocketOutbox: jest.fn()
}));
jest.mock('@/websocket-outbox/wakeup', () => ({
  wakeWebSocketOutbox: jest.fn()
}));
jest.mock('./processor', () => ({ processWebSocketBatch: jest.fn() }));
jest.mock('./retry', () => ({ deferWebSocketRetry: jest.fn() }));

import { handler } from './index';
import { doInDbContext } from '@/secrets';
import { appWebSockets } from '@/api/ws/ws';
import { reportWebSocketOutboxHealth } from '@/websocket-outbox/health';
import { publishWebSocketOutbox } from '@/websocket-outbox/publisher';
import { wakeWebSocketOutbox } from '@/websocket-outbox/wakeup';
import { processWebSocketBatch } from './processor';

const scheduled: ScheduledEvent = {
  version: '0',
  id: 'scheduled',
  'detail-type': 'Scheduled Event',
  source: 'aws.events',
  account: 'synthetic',
  time: '2026-01-01T00:00:00Z',
  region: 'us-east-1',
  resources: [],
  detail: {}
};
const remaining = jest.fn(() => 30_000);
const context = { getRemainingTimeInMillis: remaining } as unknown as Context;
const invoke = (event: ScheduledEvent | SQSEvent) =>
  handler(event, context, () => undefined);

beforeEach(() => {
  jest.clearAllMocks();
  remaining.mockReturnValue(30_000);
  jest.mocked(publishWebSocketOutbox).mockReset().mockResolvedValue(0);
  jest
    .mocked(processWebSocketBatch)
    .mockReset()
    .mockResolvedValue({ batchItemFailures: [] });
});

it('drains an EventBridge event without Records and queues resolved recipient jobs', async () => {
  jest.mocked(publishWebSocketOutbox).mockImplementation(async (publish) => {
    await publish(
      { type: 'delivery', connectionId: 'session', message: '{}' },
      '123'
    );
    return 1;
  });
  await invoke(scheduled);
  expect(doInDbContext).toHaveBeenCalledTimes(1);
  expect(reportWebSocketOutboxHealth).toHaveBeenCalledTimes(1);
  expect(processWebSocketBatch).not.toHaveBeenCalled();
  expect(appWebSockets.send).toHaveBeenCalledWith({
    type: 'delivery',
    connectionId: 'session',
    message: '{}',
    outboxId: 'outbox:123',
    abortSignal: expect.any(AbortSignal)
  });
  expect(wakeWebSocketOutbox).toHaveBeenCalledTimes(1);
});

it('supplies the deadline admission gate and does not wake another empty drain', async () => {
  await invoke(scheduled);
  const hasBudget = jest.mocked(publishWebSocketOutbox).mock.calls[0]![2]!;
  remaining.mockReturnValue(5000);
  expect(hasBudget()).toBe(false);
  remaining.mockReturnValue(5001);
  expect(hasBudget()).toBe(true);
  expect(wakeWebSocketOutbox).not.toHaveBeenCalled();
});

it('propagates scheduled publication failure for invocation recovery', async () => {
  jest
    .mocked(publishWebSocketOutbox)
    .mockRejectedValue(new Error('database unavailable'));
  await expect(invoke(scheduled)).rejects.toThrow('database unavailable');
  expect(processWebSocketBatch).not.toHaveBeenCalled();
  expect(wakeWebSocketOutbox).not.toHaveBeenCalled();
});

it('routes SQS invocations to the batch consumer and preserves partial failure', async () => {
  const batch: SQSEvent = { Records: [] };
  const result = { batchItemFailures: [{ itemIdentifier: 'retry' }] };
  jest.mocked(processWebSocketBatch).mockResolvedValue(result);
  await expect(invoke(batch)).resolves.toEqual(result);
  expect(processWebSocketBatch).toHaveBeenCalledWith(
    batch,
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    expect.any(Function)
  );
  expect(reportWebSocketOutboxHealth).not.toHaveBeenCalled();
  expect(publishWebSocketOutbox).not.toHaveBeenCalled();
});
