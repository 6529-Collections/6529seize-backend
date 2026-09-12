import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ddb, normalDeliverySlot } from './aws.js';
import { DeliveryError } from './webhook.js';

test('normal-lane contention defers without being classified as a webhook failure', async () => {
  const originalTable = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test-receipts';
  const send = mock.method(ddb, 'send', async () => {
    throw Object.assign(new Error('test contention'), {
      name: 'ConditionalCheckFailedException'
    });
  });
  try {
    await assert.rejects(
      normalDeliverySlot,
      (error) =>
        error instanceof DeliveryError &&
        error.deferred &&
        error.retryAfterSeconds === 3
    );
    send.mock.mockImplementation(async () => {
      throw new Error('storage unavailable');
    });
    await assert.rejects(normalDeliverySlot, /storage unavailable/);
  } finally {
    send.mock.restore();
    if (originalTable === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = originalTable;
  }
});
