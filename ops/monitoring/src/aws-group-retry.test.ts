import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { ddb, store } from './aws.js';
import { EVENT_TYPE, hash, type Alert } from './contract.js';
import { processWork } from './pipeline.js';

const alert: Alert = {
  _type: EVENT_TYPE,
  eventId: 'repeated-event',
  occurredAt: '2026-09-14T00:00:00Z',
  environment: 'prod',
  service: 'test-service',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'test-fingerprint'
};
const key = 'group:prod:test-fingerprint:1';
const cancellation = (codes?: (string | undefined)[]) =>
  Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    ...(codes ? { CancellationReasons: codes.map((Code) => ({ Code })) } : {})
  });
type Transaction = TransactWriteCommand['input'];

function harness(t: TestContext) {
  const originalTable = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test-receipts';
  t.after(() => {
    if (originalTable === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = originalTable;
  });
  const receipt: { groupKey?: string; outcome?: string } = {};
  const group = { count: 1, firstEventId: 'earlier-event', alert };
  const signals: (AbortSignal | undefined)[] = [];
  let calls = 0;
  let releases = 0;
  let onTransaction = async (input: Transaction) => commit(input);
  function commit(input: Transaction) {
    assert.equal(input.TransactItems?.length, 2);
    const receiptWrite = input.TransactItems?.[0]?.Update;
    const countWrite = input.TransactItems?.[1]?.Update;
    assert.equal(
      receiptWrite?.ConditionExpression,
      'attribute_not_exists(groupKey)'
    );
    assert.equal(countWrite?.ExpressionAttributeValues?.[':one'], 1);
    if (receipt.groupKey)
      throw cancellation(['ConditionalCheckFailed', 'None']);
    receipt.groupKey = receiptWrite?.ExpressionAttributeValues?.[
      ':key'
    ] as string;
    group.count++;
  }
  t.mock.method(
    ddb,
    'send',
    async (
      command: GetCommand | TransactWriteCommand | UpdateCommand,
      options?: { abortSignal?: AbortSignal }
    ) => {
      if (command instanceof GetCommand) {
        return {
          Item: String(command.input.Key?.pk).startsWith('receipt:')
            ? { ...receipt }
            : { ...group }
        };
      }
      if (command instanceof TransactWriteCommand) {
        calls++;
        signals.push(options?.abortSignal);
        await onTransaction(command.input);
      } else {
        const expression = command.input.UpdateExpression ?? '';
        if (expression.startsWith('SET leaseOwner') && receipt.outcome) {
          throw Object.assign(new Error('completed'), {
            name: 'ConditionalCheckFailedException'
          });
        }
        if (expression.startsWith('SET outcome')) {
          receipt.outcome = command.input.ExpressionAttributeValues?.[
            ':outcome'
          ] as string;
        }
        if (expression.startsWith('REMOVE leaseOwner')) releases++;
      }
      return {};
    }
  );
  const transport = {
    async schedule() {
      assert.fail('a repeat must not schedule a digest');
    },
    async archive() {
      assert.fail('a transient conflict must not archive');
    },
    async deliver() {
      assert.fail('a repeat must group without sending');
    }
  };
  return {
    receipt,
    group,
    signals,
    commit,
    calls: () => calls,
    releases: () => releases,
    transaction: (fn: typeof onTransaction) => {
      onTransaction = fn;
    },
    run: () =>
      processWork({ kind: 'alert', alert }, 'owner', store, transport, 301)
  };
}

for (const codes of [
  ['TransactionConflict', 'None'],
  ['None', 'TransactionConflict'],
  ['TransactionConflict', 'TransactionConflict']
]) {
  test(`confirmed ${codes.join('/')} retries in the same invocation and counts once`, async (t) => {
    const h = harness(t);
    const error = cancellation(codes);
    h.transaction(async (input) => {
      assert.equal(h.receipt.outcome, undefined);
      assert.equal(h.group.count, 1);
      if (h.calls() < 3) throw error;
      h.commit(input);
    });
    await h.run();
    assert.equal(h.calls(), 3);
    assert.equal(h.group.count, 2);
    assert.equal(h.receipt.outcome, 'grouped');
    assert.equal(h.releases(), 0);
    assert.ok(h.signals[0] instanceof AbortSignal);
    assert.ok(h.signals.every((signal) => signal === h.signals[0]));
    await h.run();
    assert.equal(h.calls(), 3);
    assert.equal(h.group.count, 2);
  });
}

test('exhausted conflicts preserve the original failure, release the lease and never acknowledge', async (t) => {
  const h = harness(t);
  const error = cancellation(['None', 'TransactionConflict']);
  h.transaction(async () => {
    throw error;
  });
  await assert.rejects(h.run, (caught) => caught === error);
  assert.equal(h.calls(), 3);
  assert.equal(h.receipt.outcome, undefined);
  assert.equal(h.receipt.groupKey, undefined);
  assert.equal(h.group.count, 1);
  assert.equal(h.releases(), 1);
});

for (const codes of [
  ['TransactionConflict', 'ThrottlingError'],
  ['ConditionalCheckFailed', 'TransactionConflict'],
  ['None', 'ProvisionedThroughputExceeded'],
  ['None', 'ValidationError'],
  ['None', 'None'],
  ['TransactionConflict'],
  ['TransactionConflict', 'None', 'None'],
  ['TransactionConflict', undefined],
  undefined
]) {
  test(`unproven cancellation ${codes?.join('/') ?? 'missing reasons'} is not retried locally`, async (t) => {
    const h = harness(t);
    const error = cancellation(codes);
    h.transaction(async () => {
      throw error;
    });
    await assert.rejects(h.run, (caught) => caught === error);
    assert.equal(h.calls(), 1);
    assert.equal(h.receipt.outcome, undefined);
    assert.equal(h.group.count, 1);
    assert.equal(h.releases(), 1);
  });
}

test('all transaction attempts share a three-second abort budget and stop after expiry', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds);
    return controller.signal;
  });
  const error = cancellation(['None', 'TransactionConflict']);
  h.transaction(async () => {
    if (h.calls() === 2) controller.abort();
    throw error;
  });
  await assert.rejects(h.run, (caught) => caught === error);
  assert.deepEqual(timeouts, [3000]);
  assert.equal(h.calls(), 2);
  assert.equal(h.receipt.outcome, undefined);
  assert.equal(h.releases(), 1);
});

test('deadline expiry during backoff preserves the conflict without starting another transaction', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const error = cancellation(['None', 'TransactionConflict']);
  h.transaction(async () => {
    const timer = setTimeout(() => controller.abort(), 5);
    t.after(() => clearTimeout(timer));
    throw error;
  });
  await assert.rejects(h.run, (caught) => caught === error);
  assert.equal(h.calls(), 1);
  assert.equal(h.receipt.outcome, undefined);
  assert.equal(h.releases(), 1);
});

test('deadline abort of an in-flight transaction remains unacknowledged and is not retried locally', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const error = new DOMException('aborted', 'AbortError');
  h.transaction(async () => {
    const signal = h.signals[0];
    assert.ok(signal);
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(error), { once: true });
      controller.abort();
    });
  });
  await assert.rejects(h.run, (caught) => caught === error);
  assert.equal(h.calls(), 1);
  assert.equal(h.receipt.outcome, undefined);
  assert.equal(h.releases(), 1);
});

test('concurrent processing of the same event preserves the winning original bucket and one count', async (t) => {
  const h = harness(t);
  let releaseFirst!: () => void;
  const concurrent = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  h.transaction(async (input) => {
    if (h.calls() === 1) {
      await concurrent;
      throw cancellation(['None', 'TransactionConflict']);
    }
    h.commit(input);
    releaseFirst();
  });
  const [first, second] = await Promise.all([
    store.group('group:prod:test-fingerprint:2', hash(alert.eventId), alert),
    store.group(key, hash(alert.eventId), alert)
  ]);
  assert.equal(h.calls(), 3);
  assert.equal(h.group.count, 2);
  assert.equal(first.key, key);
  assert.equal(second.key, key);
  assert.equal(h.receipt.groupKey, key);
});

test('an ambiguous committed transaction remains failed until redelivery verifies the persisted group', async (t) => {
  const h = harness(t);
  const error = new Error('ambiguous transport result');
  h.transaction(async (input) => {
    h.commit(input);
    throw error;
  });
  await assert.rejects(h.run, (caught) => caught === error);
  assert.equal(h.calls(), 1);
  assert.equal(h.group.count, 2);
  assert.equal(h.receipt.outcome, undefined);
  await h.run();
  assert.equal(h.calls(), 1);
  assert.equal(h.group.count, 2);
  assert.equal(h.receipt.outcome, 'grouped');
});
