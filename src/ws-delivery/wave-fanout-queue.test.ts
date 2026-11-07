const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => {
  const actual = jest.requireActual('@aws-sdk/client-sqs');
  return {
    ...actual,
    SQSClient: jest.fn().mockImplementation(() => ({ send: mockSend }))
  };
});
const mockLoggerError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: mockLoggerError, info: jest.fn() }) }
}));

import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  fanoutChunkSize,
  inlineFanoutLimit,
  isAsyncFanoutEnabled,
  SqsWaveFanoutQueue
} from './wave-fanout-queue';
import { WaveFanoutJob } from './wave-fanout-job';

const job = (id: string): WaveFanoutJob =>
  ({
    v: 1,
    kind: 'drop_created_effects',
    enqueued_at: 1,
    drop_id: id,
    wave_id: 'wave-1',
    author_id: 'author-1',
    pending_push_notification_ids: [],
    dm_unread_recipient_ids: [],
    collaborator_ids: []
  }) as WaveFanoutJob;

describe('wave fan-out queue', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WAVE_FANOUT_QUEUE_URL = 'https://sqs.example/123/wave-fanout';
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('reads the flag and bounded tunables', () => {
    delete process.env.WS_ASYNC_FANOUT;
    expect(isAsyncFanoutEnabled()).toBe(false);
    process.env.WS_ASYNC_FANOUT = 'TRUE';
    expect(isAsyncFanoutEnabled()).toBe(false);
    process.env.WS_ASYNC_FANOUT = 'true';
    expect(isAsyncFanoutEnabled()).toBe(true);
    delete process.env.WS_INLINE_FANOUT_MAX;
    expect(inlineFanoutLimit()).toBe(64);
    process.env.WS_INLINE_FANOUT_MAX = '10';
    expect(inlineFanoutLimit()).toBe(10);
    process.env.WS_INLINE_FANOUT_MAX = '-5';
    expect(inlineFanoutLimit()).toBe(64);
    process.env.WS_FANOUT_CHUNK_SIZE = '99999';
    expect(fanoutChunkSize()).toBe(1000);
  });

  it('awaits every send and returns only the jobs SQS did not accept', async () => {
    mockSend
      .mockResolvedValueOnce({ MessageId: 'a' })
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ MessageId: 'c' });
    const queue = new SqsWaveFanoutQueue();

    const rejected = await queue.enqueue([job('a'), job('b'), job('c')]);

    expect(rejected).toEqual([job('b')]);
    expect(mockSend).toHaveBeenCalledTimes(3);
    const command = mockSend.mock.calls[0][0] as SendMessageCommand;
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input.QueueUrl).toBe('https://sqs.example/123/wave-fanout');
    expect(JSON.parse(command.input.MessageBody!)).toEqual(job('a'));
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WAVE_FANOUT_ENQUEUE_FAILED', failed: 1 })
    );
  });

  it('returns every job when the queue cannot be resolved, and retries resolution later', async () => {
    delete process.env.WAVE_FANOUT_QUEUE_URL;
    mockSend.mockRejectedValueOnce(new Error('no queue'));
    const queue = new SqsWaveFanoutQueue();

    expect(await queue.enqueue([job('a')])).toEqual([job('a')]);

    mockSend
      .mockResolvedValueOnce({ QueueUrl: 'https://sqs.example/q' })
      .mockResolvedValueOnce({ MessageId: 'a' });
    expect(await queue.enqueue([job('a')])).toEqual([]);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(GetQueueUrlCommand);
  });

  it('sends nothing for an empty hand-off', async () => {
    expect(await new SqsWaveFanoutQueue().enqueue([])).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
