import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ddb, normalDeliverySlot, store } from './aws.js';
import { DeliveryError } from './webhook.js';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { Alert, EVENT_TYPE } from './contract.js';
import { processWork } from './pipeline.js';

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

const repeat: Alert = {
  _type: EVENT_TYPE,
  eventId: 'repeat-event',
  occurredAt: '2026-09-12T00:00:00Z',
  environment: 'prod',
  service: 'api',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'same-error'
};
const cancellation = (codes?: string[]) =>
  Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    ...(codes ? { CancellationReasons: codes.map((Code) => ({ Code })) } : {})
  });

for (const codes of [
  ['TransactionConflict', 'None'],
  ['None', 'ProvisionedThroughputExceeded'],
  ['None', 'ThrottlingError'],
  ['ConditionalCheckFailed', 'ThrottlingError'],
  undefined
]) {
  test(`transaction ${codes?.join('/') ?? 'without reasons'} retries without acknowledging or losing a repeat`, async () => {
    const originalTable = process.env.RECEIPTS_TABLE;
    process.env.RECEIPTS_TABLE = 'test-receipts';
    const receipt: { groupKey?: string; outcome?: string } = {};
    const group = { count: 1, firstEventId: 'earlier-event', alert: repeat };
    const error = cancellation(codes);
    let fail = true;
    let releases = 0;
    const send = mock.method(
      ddb,
      'send',
      async (command: GetCommand | TransactWriteCommand | UpdateCommand) => {
        if (command instanceof GetCommand) {
          return {
            Item: String(command.input.Key?.pk).startsWith('receipt:')
              ? { ...receipt }
              : { ...group }
          };
        }
        if (command instanceof TransactWriteCommand) {
          if (fail) throw error;
          receipt.groupKey = command.input.TransactItems?.[0]?.Update
            ?.ExpressionAttributeValues?.[':key'] as string;
          group.count++;
        } else if (command instanceof UpdateCommand) {
          const expression = command.input.UpdateExpression ?? '';
          if (expression.startsWith('SET leaseOwner') && receipt.outcome) {
            throw Object.assign(new Error('completed receipt'), {
              name: 'ConditionalCheckFailedException'
            });
          }
          if (expression.startsWith('SET outcome'))
            receipt.outcome = command.input.ExpressionAttributeValues?.[
              ':outcome'
            ] as string;
          if (expression.startsWith('REMOVE leaseOwner')) releases++;
        }
        return {};
      }
    );
    const transport = {
      async schedule() {},
      async archive() {},
      async deliver() {
        throw new Error('Repeats must group');
      }
    };
    try {
      await assert.rejects(
        () =>
          processWork(
            { kind: 'alert', alert: repeat },
            'attempt-1',
            store,
            transport,
            301
          ),
        error
      );
      assert.equal(receipt.outcome, undefined);
      assert.equal(group.count, 1);
      assert.equal(releases, 1);
      fail = false;
      await processWork(
        { kind: 'alert', alert: repeat },
        'attempt-2',
        store,
        transport,
        302
      );
      assert.equal(group.count, 2);
      assert.equal(receipt.outcome, 'grouped');
      await processWork(
        { kind: 'alert', alert: repeat },
        'duplicate-delivery',
        store,
        transport,
        303
      );
      assert.equal(group.count, 2);
    } finally {
      send.mock.restore();
      if (originalTable === undefined) delete process.env.RECEIPTS_TABLE;
      else process.env.RECEIPTS_TABLE = originalTable;
    }
  });
}

test('a proven duplicate grouping transaction reads the persisted original bucket', async () => {
  const originalTable = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test-receipts';
  const originalKey = 'group:prod:same-error:1';
  let transactionAttempted = false;
  let proofPresent = true;
  const error = cancellation(['ConditionalCheckFailed', 'None']);
  const send = mock.method(
    ddb,
    'send',
    async (command: GetCommand | TransactWriteCommand) => {
      if (command instanceof TransactWriteCommand) {
        transactionAttempted = true;
        throw error;
      }
      if (String(command.input.Key?.pk).startsWith('receipt:')) {
        return {
          Item:
            transactionAttempted && proofPresent
              ? { groupKey: originalKey }
              : {}
        };
      }
      assert.equal(command.input.Key?.pk, originalKey);
      return {
        Item: { count: 2, firstEventId: 'earlier-event', alert: repeat }
      };
    }
  );
  try {
    const group = await store.group(
      'group:prod:same-error:2',
      'receipt-id',
      repeat
    );
    assert.equal(group.key, originalKey);
    assert.equal(group.count, 2);
    transactionAttempted = false;
    proofPresent = false;
    await assert.rejects(
      () => store.group('group:prod:same-error:2', 'receipt-id', repeat),
      error
    );
  } finally {
    send.mock.restore();
    if (originalTable === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = originalTable;
  }
});
