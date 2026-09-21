import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { ddb, store } from './aws.js';
import { EVENT_TYPE, hash, type Alert } from './contract.js';
import { processWork, type Transport, type Work } from './pipeline.js';
import { DeliveryError } from './webhook.js';
import { parseDigestPlan, type DigestPlan } from './digest-plan.js';
import {
  bindDispatchWork,
  logDispatchFailure,
  withDispatchDiagnostics
} from './dispatch-diagnostics.js';

const destinationKey = hash('synthetic-webhook-version');
const messageId = '987654321012345678';
const alert: Alert = {
  _type: EVENT_TYPE,
  eventId: 'first',
  environment: 'prod',
  service: 'fixture',
  occurredAt: '2026-09-14T06:00:00Z',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'fixture'
};
const groupKey = 'group:prod:fixture:1';
const firstId = hash(alert.eventId);
const digest: Work & { kind: 'digest' } = {
  kind: 'digest',
  groupKey,
  eventId: `digest:${hash(groupKey)}`
};
const digestId = hash(digest.eventId);
type Item = Record<string, unknown>;
const conditional = () =>
  Object.assign(new Error('condition'), {
    name: 'ConditionalCheckFailedException'
  });

function harness(t: TestContext) {
  const oldTable = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'synthetic-receipts';
  t.after(() => {
    if (oldTable === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = oldTable;
  });
  const items = new Map<string, Item>();
  const reads: string[] = [];
  const actions: string[] = [];
  const logs: Item[] = [];
  const sent: { method: 'POST' | 'PATCH'; payload: object; target?: string }[] =
    [];
  const scheduled: Work[] = [];
  const archives: Work[] = [];
  const failures = new Map<string, unknown>();
  function failAt(operation: string) {
    if (failures.has(operation)) {
      const error = failures.get(operation);
      failures.delete(operation);
      throw error;
    }
  }
  t.mock.method(
    ddb,
    'send',
    async (command: GetCommand | UpdateCommand | TransactWriteCommand) => {
      if (command instanceof GetCommand) {
        assert.equal(command.input.ConsistentRead, true);
        const key = String(command.input.Key?.pk);
        reads.push(key);
        return { Item: structuredClone(items.get(key)) };
      }
      if (command instanceof TransactWriteCommand) {
        const first = command.input.TransactItems?.[0]?.Update;
        const second = command.input.TransactItems?.[1]?.Update;
        assert.ok(first && second);
        assert.ok(first.Key && second.Key);
        assert.equal(command.input.TransactItems?.length, 2);
        assert.equal(
          first.ConditionExpression,
          'attribute_not_exists(groupKey)'
        );
        const receipt = items.get(String(first.Key.pk)) ?? {};
        if (receipt.groupKey !== undefined)
          throw Object.assign(new Error('duplicate'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' }
            ]
          });
        const group = items.get(String(second.Key.pk)) ?? {
          firstEventId: second.ExpressionAttributeValues?.[':id'],
          alert: second.ExpressionAttributeValues?.[':alert'],
          count: 0
        };
        receipt.groupKey = first.ExpressionAttributeValues?.[':key'];
        group.count = Number(group.count) + 1;
        items.set(String(first.Key.pk), receipt);
        items.set(String(second.Key.pk), group);
        return {};
      }
      const input = command.input;
      const key = String(input.Key?.pk);
      const item = items.get(key) ?? {};
      const values = input.ExpressionAttributeValues ?? {};
      const expression = input.UpdateExpression ?? '';
      if (expression.startsWith('SET leaseOwner')) {
        if (
          item.outcome !== undefined ||
          Number(item.leaseUntil ?? -1) >= Number(values[':now'])
        )
          throw conditional();
        item.leaseOwner = values[':owner'];
        item.leaseUntil = values[':until'];
      } else {
        assert.ok(input.ConditionExpression?.includes('leaseOwner = :owner'));
        if (item.leaseOwner !== values[':owner']) throw conditional();
        if (expression.startsWith('SET digestPlan')) {
          assert.ok(
            input.ConditionExpression?.includes('attribute_not_exists(outcome)')
          );
          if (item.outcome !== undefined) throw conditional();
          const fallback = ':fallback' in values;
          const operation = fallback ? 'FALLBACK' : 'PLAN';
          actions.push(operation);
          failAt(operation);
          assert.equal(input.ReturnValues, 'ALL_NEW');
          if (fallback) {
            assert.ok(
              input.ConditionExpression?.includes('digestPlan = :previous')
            );
            assert.deepEqual(item.digestPlan, values[':previous']);
            item.digestPlan = structuredClone(values[':fallback']);
          } else {
            assert.equal(
              expression,
              'SET digestPlan = if_not_exists(digestPlan, :plan)'
            );
            item.digestPlan ??= structuredClone(values[':plan']);
          }
          items.set(key, item);
          failAt(`${operation}_AFTER`);
        } else if (expression.startsWith('SET outcome')) {
          failAt('COMPLETE');
          item.outcome = values[':outcome'];
          if (values[':operation'])
            item.deliveryOperation = values[':operation'];
          if (values[':destination'])
            item.destinationKey = values[':destination'];
          delete item.leaseOwner;
          delete item.leaseUntil;
        } else {
          assert.equal(expression, 'REMOVE leaseOwner, leaseUntil');
          delete item.leaseOwner;
          delete item.leaseUntil;
        }
      }
      items.set(key, item);
      return { Attributes: structuredClone(item) };
    }
  );
  t.mock.method(console, 'log', (line: string) =>
    logs.push(JSON.parse(line) as Item)
  );
  t.mock.method(console, 'error', (line: string) =>
    logs.push(JSON.parse(line) as Item)
  );
  const transport: Transport = {
    async schedule(work) {
      scheduled.push(work);
    },
    async archive(work) {
      archives.push(work);
    },
    async deliver(payload, expectedDestination) {
      if (expectedDestination !== undefined)
        assert.equal(expectedDestination, destinationKey);
      actions.push('POST');
      sent.push({ method: 'POST', payload: structuredClone(payload) });
      return { messageId, destinationKey, operation: 'POST' };
    },
    async edit(target, payload) {
      actions.push('PATCH');
      sent.push({
        method: 'PATCH',
        payload: structuredClone(payload),
        target: target.messageId
      });
      assert.equal(target.destinationKey, destinationKey);
      return { ...target, operation: 'EDIT' };
    }
  };
  async function run(work: Work, owner = 'fixture-owner', now = 301) {
    return withDispatchDiagnostics(
      { lane: 'normal', messageId: 'synthetic-sqs', receiveCount: '1' },
      async () => {
        bindDispatchWork(
          work.kind,
          hash(work.kind === 'alert' ? work.alert.eventId : work.eventId)
        );
        try {
          await processWork(work, owner, store, transport, now);
        } catch (error) {
          logDispatchFailure(error);
          throw error;
        }
      }
    );
  }
  const repeated = async () => {
    await run({ kind: 'alert', alert });
    await run({ kind: 'alert', alert: { ...alert, eventId: 'repeat' } });
  };
  return {
    items,
    reads,
    actions,
    sent,
    scheduled,
    archives,
    transport,
    logs,
    failures,
    run,
    repeated,
    receipt: () => items.get(`receipt:${digestId}`),
    plan: () =>
      items.get(`receipt:${digestId}`)?.digestPlan as DigestPlan | undefined
  };
}

test('real receipt/transaction path edits only the acknowledged first message and counts once', async (t) => {
  const h = harness(t);
  await h.repeated();
  await h.run({ kind: 'alert', alert: { ...alert, eventId: 'repeat' } });
  assert.equal(h.items.get(groupKey)?.count, 2);
  assert.equal(h.scheduled.length, 1);
  assert.deepEqual(h.items.get(`receipt:${firstId}`), {
    groupKey,
    outcome: messageId,
    deliveryOperation: 'POST',
    destinationKey
  });
  await h.run(digest);
  await h.run(digest);
  assert.deepEqual(
    h.sent.map((item) => item.method),
    ['POST', 'PATCH']
  );
  assert.equal(h.sent[1]?.target, messageId);
  assert.equal(
    JSON.stringify(h.sent[1]?.payload),
    JSON.stringify(h.sent[0]?.payload).replace('"value":"1"', '"value":"2"')
  );
  assert.equal(h.receipt()?.outcome, messageId);
  assert.equal(h.receipt()?.deliveryOperation, 'EDIT');
  assert.ok(h.reads.includes(`receipt:${firstId}`));
  assert.equal(h.reads.includes(`receipt:${hash(firstId)}`), false);
  assert.ok(h.logs.some((entry) => entry.outcome === 'EDITED'));
  assert.equal(JSON.stringify(h.logs).includes(messageId), false);
});

test('ambiguous edit and failed completion replay the same persisted target/count', async (t) => {
  const h = harness(t);
  await h.repeated();
  const original = h.transport.edit;
  const ambiguous = new DeliveryError(true);
  h.transport.edit = async (...args) => {
    await original(...args);
    throw ambiguous;
  };
  await assert.rejects(h.run(digest), (error) => error === ambiguous);
  assert.equal(h.receipt()?.outcome, undefined);
  assert.equal(h.plan()?.count, 2);
  h.items.get(groupKey)!.count = 3;
  h.transport.edit = original;
  const storageError = new Error('fixture completion failure');
  h.failures.set('COMPLETE', storageError);
  await assert.rejects(h.run(digest), (error) => error === storageError);
  assert.equal(h.receipt()?.outcome, undefined);
  await h.run(digest);
  assert.deepEqual(
    h.sent.map((item) => item.method),
    ['POST', 'PATCH', 'PATCH', 'PATCH']
  );
  assert.deepEqual(h.sent[1], h.sent[2]);
  assert.deepEqual(h.sent[2], h.sent[3]);
  assert.equal(h.items.get(groupKey)?.count, 3);
});

test('concurrent digest delivery cannot make a second vendor request', async (t) => {
  const h = harness(t);
  await h.repeated();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.transport.edit;
  h.transport.edit = async (...args) => {
    entered();
    await barrier;
    return original(...args);
  };
  const first = h.run(digest, 'one');
  await started;
  await assert.rejects(
    h.run(digest, 'two'),
    (error) => error instanceof DeliveryError && error.deferred
  );
  release();
  await first;
  assert.deepEqual(
    h.sent.map((item) => item.method),
    ['POST', 'PATCH']
  );
});

for (const legacy of ['missing', 'pending', 'archived', 'unbound']) {
  test(`${legacy} first acknowledgement preserves legacy summary POST`, async (t) => {
    const h = harness(t);
    await h.repeated();
    const receipt = h.items.get(`receipt:${firstId}`)!;
    if (legacy === 'missing') h.items.delete(`receipt:${firstId}`);
    if (legacy === 'pending') delete receipt.outcome;
    if (legacy === 'archived') receipt.outcome = 'archived';
    if (legacy === 'unbound') delete receipt.destinationKey;
    await h.run(digest);
    assert.deepEqual(
      h.sent.map((item) => item.method),
      ['POST', 'POST']
    );
    assert.equal(h.plan()?.mode, 'POST');
  });
}

for (const [field, value] of [
  ['groupKey', 'group:prod:other:1'],
  ['outcome', '../987'],
  ['destinationKey', 'invalid'],
  ['deliveryOperation', 'EDIT']
] as const) {
  test(`contradictory first receipt ${field} fails without vendor contact`, async (t) => {
    const h = harness(t);
    await h.repeated();
    h.items.get(`receipt:${firstId}`)![field] = value;
    await assert.rejects(h.run(digest));
    assert.equal(h.sent.length, 1);
    assert.equal(h.receipt()?.outcome, undefined);
  });
}

test('failed or ambiguously committed plan creation cannot change retry target', async (t) => {
  const h = harness(t);
  await h.repeated();
  h.failures.set('PLAN', new Error('before plan write'));
  await assert.rejects(h.run(digest));
  assert.equal(h.sent.length, 1);
  assert.equal(h.plan(), undefined);
  h.failures.set('PLAN_AFTER', new Error('after plan write'));
  await assert.rejects(h.run(digest));
  assert.equal(h.sent.length, 1);
  assert.equal(h.plan()?.mode, 'EDIT');
  delete h.items.get(`receipt:${firstId}`)!.destinationKey;
  await h.run(digest);
  assert.equal(h.sent[1]?.method, 'PATCH');
});

test('target-missing transition persists before POST and survives ambiguous storage response', async (t) => {
  const h = harness(t);
  await h.repeated();
  h.transport.edit = async () => {
    h.actions.push('PATCH_MISSING');
    return null;
  };
  h.failures.set('FALLBACK', new Error('before fallback write'));
  await assert.rejects(h.run(digest));
  assert.equal(h.sent.length, 1);
  assert.equal(h.plan()?.mode, 'EDIT');
  h.failures.set('FALLBACK_AFTER', new Error('after fallback write'));
  await assert.rejects(h.run(digest));
  assert.equal(h.sent.length, 1);
  assert.equal(h.plan()?.mode, 'POST');
  assert.equal(
    (h.plan() as { destinationKey?: string }).destinationKey,
    destinationKey
  );
  await h.run(digest);
  assert.deepEqual(h.actions, [
    'POST',
    'PLAN',
    'PATCH_MISSING',
    'FALLBACK',
    'PATCH_MISSING',
    'FALLBACK',
    'POST'
  ]);
  assert.equal(h.receipt()?.outcome, messageId);
});

test('retryable edit error never selects replacement, and permanent failure uses archive', async (t) => {
  const h = harness(t);
  await h.repeated();
  h.transport.edit = async () => {
    throw new DeliveryError(true, 4, false, {
      cause: 'HTTP_RATE_LIMIT',
      httpStatus: 429
    });
  };
  await assert.rejects(h.run(digest));
  assert.equal(h.plan()?.mode, 'EDIT');
  assert.equal(h.sent.length, 1);
  assert.equal(h.archives.length, 0);
  h.transport.edit = async () => {
    throw new DeliveryError(false, 0, false, {
      cause: 'DELIVERY_DESTINATION_CHANGED'
    });
  };
  await h.run(digest);
  assert.equal(h.archives.length, 1);
  assert.equal(h.receipt()?.outcome, 'archived');
  assert.equal(h.sent.length, 1);
});

test('malformed or wrong-group persisted plans fail instead of selecting another target', () => {
  const valid = {
    version: 1,
    groupKey,
    count: 2,
    mode: 'EDIT',
    target: { messageId, destinationKey }
  };
  for (const changed of [
    { version: 2 },
    { groupKey: 'other' },
    { count: 1 },
    { count: '2' },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    { target: { messageId: '../123', destinationKey } },
    { mode: 'UNKNOWN' }
  ])
    assert.throws(() => parseDigestPlan({ ...valid, ...changed }, groupKey));
});
