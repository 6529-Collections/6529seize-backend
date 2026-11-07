const mockLoggerError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: mockLoggerError, info: jest.fn() }) }
}));

import type { SQSEvent } from 'aws-lambda';
import { processWaveFanoutBatch, WaveJobRegistry } from './wave-fanout-worker';

const event = (...bodies: string[]): SQSEvent =>
  ({
    Records: bodies.map((body, index) => ({
      messageId: `m-${index}`,
      body,
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: String(Date.now() - 25)
      }
    }))
  }) as never;

describe('processWaveFanoutBatch', () => {
  const lambda = process.env.AWS_LAMBDA_FUNCTION_NAME;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'waveFanoutWorker';
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    if (lambda === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambda;
  });

  const jobRecords = () =>
    stdout.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((record) => record.event === 'WAVE_JOB');

  it('treats a body without kind as a drop fan-out chunk', async () => {
    const registry = new WaveJobRegistry();
    const frames = jest.fn().mockResolvedValue(undefined);
    registry.register('drop_frames', frames);

    await expect(
      processWaveFanoutBatch(event('{"v":1,"drop":{"id":"d"}}'), registry)
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(frames).toHaveBeenCalledWith({ v: 1, drop: { id: 'd' } });
    expect(jobRecords()[0]).toMatchObject({
      JobKind: 'drop_frames',
      wave_job_processed: 1,
      wave_job_failed: 0
    });
    expect(jobRecords()[0].wave_job_queue_age_ms).toBeGreaterThanOrEqual(25);
  });

  it('runs a kind registered by another module', async () => {
    const registry = new WaveJobRegistry();
    registry.register('drop_frames', jest.fn());
    const outbox = jest.fn().mockResolvedValue(undefined);
    registry.register('drop_write_outbox', outbox);

    await expect(
      processWaveFanoutBatch(
        event('{"kind":"drop_write_outbox","drop_id":"d-1"}'),
        registry
      )
    ).resolves.toEqual({ batchItemFailures: [] });

    expect(outbox).toHaveBeenCalledWith({
      kind: 'drop_write_outbox',
      drop_id: 'd-1'
    });
    expect(() => registry.register('drop_write_outbox', jest.fn())).toThrow(
      'already registered'
    );
  });

  it('fails only the unknown, malformed or throwing items', async () => {
    const registry = new WaveJobRegistry();
    const frames = jest.fn().mockResolvedValue(undefined);
    registry.register('drop_frames', frames);
    registry.register(
      'flaky',
      jest.fn().mockRejectedValue(new Error('viewer contexts unavailable'))
    );

    const result = await processWaveFanoutBatch(
      event(
        '{"kind":"drop_frames","v":1}',
        '{"kind":"not_registered"}',
        'not json',
        '{"kind":"flaky"}'
      ),
      registry
    );

    expect(result.batchItemFailures).toEqual(
      expect.arrayContaining([
        { itemIdentifier: 'm-1' },
        { itemIdentifier: 'm-2' },
        { itemIdentifier: 'm-3' }
      ])
    );
    expect(result.batchItemFailures).toHaveLength(3);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'WAVE_FANOUT_JOB_FAILED',
        kind: 'not_registered',
        message_id: 'm-1',
        error_message: 'Unknown wave job kind not_registered'
      })
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unparsed', message_id: 'm-2' })
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'flaky',
        error_message: 'viewer contexts unavailable'
      })
    );
    expect(
      jobRecords()
        .filter((record) => record.wave_job_failed === 1)
        .map((record) => record.JobKind)
        .sort((a: string, b: string) => a.localeCompare(b))
    ).toEqual(['flaky', 'not_registered', 'unparsed']);
  });
});
