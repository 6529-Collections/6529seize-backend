import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import {
  CdnInvalidator,
  CloudFrontInvalidator,
  InvalidationQueue
} from './cdn-invalidation';

class RecordingInvalidator implements CdnInvalidator {
  readonly batches: string[][] = [];
  async invalidate(paths: string[]) {
    this.batches.push(paths);
  }
}

describe('InvalidationQueue', () => {
  it('submits full batches, then the remainder, without duplicates', async () => {
    const invalidator = new RecordingInvalidator();
    const queue = new InvalidationQueue(invalidator, 2);
    queue.add(['/a', '/b', '/c']);
    await queue.flushFullBatches();
    expect(invalidator.batches).toEqual([['/a', '/b']]);
    expect(queue.pendingCount).toBe(1);
    queue.add(['/c']);
    await queue.flush();
    expect(invalidator.batches).toEqual([['/a', '/b'], ['/c']]);
    expect(queue.submitted).toBe(3);
    expect(queue.batches).toBe(2);
    await queue.flush();
    expect(invalidator.batches).toHaveLength(2);
  });

  it('keeps paths pending when submission fails', async () => {
    const queue = new InvalidationQueue({
      invalidate: async () => {
        throw new Error('AccessDenied');
      }
    });
    queue.add(['/a']);
    await expect(queue.flush()).rejects.toThrow('AccessDenied');
    expect(queue.pendingCount).toBe(1);
  });
});

describe('CloudFrontInvalidator', () => {
  it('sends one invalidation per batch and retries throttling', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), {
          name: 'TooManyInvalidationsInProgress'
        })
      )
      .mockResolvedValueOnce({});
    const sleeps: number[] = [];
    const invalidator = new CloudFrontInvalidator(
      'DIST',
      { send } as never,
      async (millis) => {
        sleeps.push(millis);
      }
    );
    await invalidator.invalidate(['/drops/a.jpg']);
    expect(send).toHaveBeenCalledTimes(2);
    const command = send.mock.calls[1][0] as CreateInvalidationCommand;
    expect(command.input).toMatchObject({
      DistributionId: 'DIST',
      InvalidationBatch: { Paths: { Quantity: 1, Items: ['/drops/a.jpg'] } }
    });
    expect(sleeps).toEqual([15_000]);
  });

  it('does not retry other errors', async () => {
    const send = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const invalidator = new CloudFrontInvalidator(
      'DIST',
      { send } as never,
      async () => undefined
    );
    await expect(invalidator.invalidate(['/x'])).rejects.toThrow(
      'AccessDenied'
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
