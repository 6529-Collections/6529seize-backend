jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: jest.fn()
}));
import { randomInt } from 'node:crypto';
import type { SQSEvent } from 'aws-lambda';
import { processWebSocketBatch } from './processor';
import { retryDelaySeconds } from './retry';

const event = (...ids: string[]): SQSEvent =>
  ({
    Records: ids.map((id) => ({
      messageId: id,
      body: JSON.stringify({
        version: 1,
        id,
        connectionId: 'session',
        message: '{}',
        identityId: 'profile',
        jwtExpiry: 2000000000
      })
    }))
  }) as SQSEvent;

describe('durable outbound consumer', () => {
  it('retains a throttled frame and later FIFO records; acknowledges only successful sends', async () => {
    const deliver = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('429'));
    const report = jest.fn();
    const defer = jest.fn().mockResolvedValue(undefined);
    const batch = event('a', 'b', 'c');
    expect(await processWebSocketBatch(batch, deliver, report, defer)).toEqual({
      batchItemFailures: [{ itemIdentifier: 'b' }, { itemIdentifier: 'c' }]
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(defer).toHaveBeenCalledWith(batch.Records[1]);
    expect(report).toHaveBeenCalledTimes(1);
    deliver.mockResolvedValue(undefined);
    expect(
      await processWebSocketBatch(event('b', 'c'), deliver, report)
    ).toEqual({ batchItemFailures: [] });
    expect(deliver.mock.calls.map(([frame]) => frame.id)).toEqual([
      'a',
      'b',
      'b',
      'c'
    ]);
  });

  it('retains failures even when logging and visibility adjustment fail', async () => {
    const result = await processWebSocketBatch(
      event('a'),
      async () => {
        throw new Error('deadline');
      },
      () => {
        throw new Error('logger');
      },
      async () => {
        throw new Error('SQS');
      }
    );
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'a' }]);
  });

  it('retains malformed frames for investigation rather than acknowledging them', async () => {
    const batch = event('a');
    batch.Records[0]!.body = 'invalid';
    const deliver = jest.fn();
    expect(
      (await processWebSocketBatch(batch, deliver, jest.fn())).batchItemFailures
    ).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('caps randomized retry backoff and never retries immediately', () => {
    const random = randomInt as unknown as jest.MockedFunction<
      (min: number, max: number) => number
    >;
    random.mockReturnValueOnce(2).mockReturnValueOnce(60);
    expect(retryDelaySeconds('1')).toBe(2);
    expect(retryDelaySeconds('100')).toBe(60);
    random.mockReturnValue(1);
    expect(retryDelaySeconds('100')).toBe(1);
    expect(random.mock.calls).toEqual([
      [1, 3],
      [1, 61],
      [1, 61]
    ]);
    random.mockReset();
  });
});
