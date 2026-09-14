import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPE, Alert } from './contract.js';
import {
  processWork,
  parseWork,
  Store,
  Transport,
  Work,
  Group
} from './pipeline.js';
import { DeliveryError } from './webhook.js';
const alert: Alert = {
  _type: EVENT_TYPE,
  eventId: 'first',
  occurredAt: '2026-09-12T00:00:00Z',
  environment: 'prod',
  service: 'api',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'fingerprint'
};
function harness() {
  const receipts = new Map<
    string,
    { done?: boolean; busy?: boolean; groupKey?: string }
  >();
  const groups = new Map<string, Group>();
  const scheduled: Work[] = [];
  const sent: object[] = [];
  const archived: Work[] = [];
  const heartbeat: string[] = [];
  const store: Store = {
    async reserve(id) {
      const row = receipts.get(id) ?? {};
      if (row.done) return 'done';
      if (row.busy) return 'busy';
      row.busy = true;
      receipts.set(id, row);
      return 'acquired';
    },
    async complete(id) {
      receipts.get(id)!.done = true;
      receipts.get(id)!.busy = false;
    },
    async release(id) {
      receipts.get(id)!.busy = false;
    },
    async group(key, id, item) {
      const receipt = receipts.get(id)!;
      if (receipt.groupKey) return groups.get(receipt.groupKey)!;
      receipt.groupKey = key;
      const group = groups.get(key) ?? {
        key,
        count: 0,
        firstEventId: id,
        alert: item
      };
      group.count++;
      groups.set(key, group);
      return group;
    },
    async readGroup(key) {
      return groups.get(key) ?? null;
    },
    async heartbeat(lane) {
      heartbeat.push(lane);
    }
  };
  const transport: Transport = {
    async schedule(work) {
      scheduled.push(work);
    },
    async deliver(payload) {
      sent.push(payload);
      return '123';
    },
    async archive(work) {
      archived.push(work);
    }
  };
  return { store, transport, scheduled, sent, archived, groups, heartbeat };
}
test('duplicate SQS receipts send once; repeated fingerprints yield a durable summary', async () => {
  const h = harness();
  const work: Work = { kind: 'alert', alert };
  await processWork(work, 'one', h.store, h.transport, 300);
  await processWork(work, 'two', h.store, h.transport, 301);
  await processWork(
    { kind: 'alert', alert: { ...alert, eventId: 'second' } },
    'three',
    h.store,
    h.transport,
    302
  );
  assert.equal(h.sent.length, 1);
  assert.equal(h.scheduled.length, 1);
  await processWork(h.scheduled[0]!, 'digest', h.store, h.transport, 605);
  assert.equal(h.sent.length, 2);
  assert.match(JSON.stringify(h.sent[1]), /"value":"2"/);
});
test('a failed send retries in its original bucket without double-counting', async () => {
  const h = harness();
  const original = h.transport.deliver;
  h.transport.deliver = async () => {
    throw new DeliveryError(true);
  };
  await assert.rejects(() =>
    processWork({ kind: 'alert', alert }, 'one', h.store, h.transport, 599)
  );
  h.transport.deliver = original;
  await processWork({ kind: 'alert', alert }, 'two', h.store, h.transport, 601);
  assert.equal(h.groups.size, 1);
  assert.equal([...h.groups.values()][0]?.count, 1);
  assert.equal(h.sent.length, 1);
});
test('critical delivery bypasses normal grouping and permanent failures are archived before acknowledgement', async () => {
  const h = harness();
  const critical: Work = {
    kind: 'alert',
    alert: { ...alert, severity: 'critical', code: 'PLATFORM_ALARM' }
  };
  h.transport.deliver = async () => {
    throw new DeliveryError(false);
  };
  await processWork(critical, 'one', h.store, h.transport);
  assert.equal(h.archived.length, 1);
  assert.equal(h.scheduled.length, 0);
  const failed = harness();
  failed.transport.deliver = h.transport.deliver;
  failed.transport.archive = async () => {
    throw new Error('S3 unavailable');
  };
  await assert.rejects(
    () => processWork(critical, 'one', failed.store, failed.transport),
    /S3 unavailable/
  );
});
test('fresh heartbeat proves traversal, stale messages cannot keep health green', async () => {
  const h = harness();
  const work: Work = {
    kind: 'heartbeat',
    lane: 'critical',
    eventId: 'fresh',
    emittedAt: 1000
  };
  await processWork(work, 'one', h.store, h.transport, 1001);
  assert.deepEqual(h.heartbeat, ['critical']);
  await processWork(
    { ...work, eventId: 'old' },
    'two',
    h.store,
    h.transport,
    1300
  );
  assert.equal(h.heartbeat.length, 1);
  assert.equal(h.archived.length, 1);
  assert.throws(
    () =>
      parseWork({
        kind: 'digest',
        groupKey: 'private arbitrary string',
        eventId: 'abc'
      }),
    /INVALID_WORK/
  );
});
