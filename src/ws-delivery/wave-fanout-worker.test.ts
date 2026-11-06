const mockLoggerError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: mockLoggerError, info: jest.fn() }) }
}));

import type { SQSEvent } from 'aws-lambda';
import { processWaveFanoutBatch } from './wave-fanout-worker';
import { WAVE_FANOUT_JOB_VERSION } from './wave-fanout-job';

const frames = {
  v: WAVE_FANOUT_JOB_VERSION,
  kind: 'drop_frames',
  update_type: 'DROP_UPDATE',
  server_received_at: 1,
  enqueued_at: 2,
  chunk: 0,
  drop: { id: 'drop-1' },
  hidden_drop_ids: [],
  author_ids_by_drop_id: [],
  recipients: [{ c: 'c-1', p: 'p-1', e: 4102444800 }]
};
const effects = {
  v: WAVE_FANOUT_JOB_VERSION,
  kind: 'drop_created_effects',
  enqueued_at: 2,
  drop_id: 'drop-1',
  wave_id: 'wave-1',
  author_id: 'author-1',
  pending_push_notification_ids: [7],
  dm_unread_recipient_ids: ['p-2'],
  collaborator_ids: []
};

const event = (...bodies: string[]): SQSEvent =>
  ({
    Records: bodies.map((body, index) => ({
      messageId: `m-${index}`,
      body,
      attributes: { ApproximateReceiveCount: '1' }
    }))
  }) as never;

describe('processWaveFanoutBatch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes each job and acknowledges successes', async () => {
    const deps = {
      deliverQueuedDropFrames: jest.fn().mockResolvedValue(undefined),
      runDropCreatedEffects: jest.fn().mockResolvedValue(undefined)
    };

    await expect(
      processWaveFanoutBatch(
        event(JSON.stringify(frames), JSON.stringify(effects)),
        deps
      )
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(deps.deliverQueuedDropFrames).toHaveBeenCalledWith(frames);
    expect(deps.runDropCreatedEffects).toHaveBeenCalledWith(effects);
  });

  it('reports only the failed or malformed records for retry', async () => {
    const deps = {
      deliverQueuedDropFrames: jest
        .fn()
        .mockRejectedValue(new Error('viewer contexts unavailable')),
      runDropCreatedEffects: jest.fn().mockResolvedValue(undefined)
    };

    const result = await processWaveFanoutBatch(
      event(JSON.stringify(frames), JSON.stringify(effects), '{"v":9}'),
      deps
    );

    expect(result.batchItemFailures).toEqual(
      expect.arrayContaining([
        { itemIdentifier: 'm-0' },
        { itemIdentifier: 'm-2' }
      ])
    );
    expect(result.batchItemFailures).toHaveLength(2);
    expect(deps.runDropCreatedEffects).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'WAVE_FANOUT_JOB_FAILED',
        message_id: 'm-0',
        error_message: 'viewer contexts unavailable'
      })
    );
  });
});
