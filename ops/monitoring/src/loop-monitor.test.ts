import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { admit, ddb, sqs } from './aws.js';
import {
  monitorLoop,
  policiesFor,
  receiveLoopObservation,
  receiveLoopThrottle
} from './loop-monitor.js';
import { LOOP_EVENT_TYPE, LoopPolicy } from './loop-health.js';
import { logEnvelopes, collect } from './handlers.js';
import { gzipSync } from 'node:zlib';
import { EventBridgeEvent } from 'aws-lambda';

test('all configured background workers are enrolled; APIs remain separate and eligibility is inclusive at five minutes', () => {
  for (const env of ['prod', 'staging'] as const) {
    const policies = policiesFor(env);
    assert.equal(
      policies.find((p) => p.service === 'seizeAPI'),
      undefined
    );
    assert.equal(
      policies.find((p) => p.service === 'ethPriceLoop')?.expectedOverlap,
      true
    );
    assert.equal(
      policies.find((p) => p.service === 'marketStatsMEMES')?.expectedOverlap,
      false
    );
    assert.equal(
      policies.find((p) => p.service === 'pushNotificationsHandler')
        ?.expectedOverlap,
      false
    );
    assert.equal(
      policies.find((p) => p.service === 'externalCollectionSnapshottingLoop')
        ?.expectedOverlap,
      false
    );
    assert.equal(
      policies.find((p) => p.service === 'helpBotDailyActivityCreditLoop')
        ?.expectedOverlap,
      true
    );
    assert.ok(policies.find((p) => p.service === 'nftLinkRefresherLoop'));
  }
});

test('authenticated log metadata binds progress service and strips content in direct and JSON-wrapped logs', async () => {
  const message = {
    _type: LOOP_EVENT_TYPE,
    service: 'forged',
    operation: 'indexing',
    observedAt: 100,
    pending: true,
    recovery: 'automatic',
    privateMessage: 'PRIVATE'
  };
  const encoded = gzipSync(
    JSON.stringify({
      owner: '123',
      logGroup: '/aws/lambda/delegationsLoop',
      logEvents: [
        { message: JSON.stringify(message) },
        { message: JSON.stringify({ message }) }
      ]
    })
  ).toString('base64');
  const parsed = logEnvelopes(
    encoded,
    '123',
    ['/aws/lambda/delegationsLoop'],
    'staging'
  );
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every((row) => row.service === 'delegationsLoop'));
  assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false);
  await assert.rejects(
    collect({
      account: 'unapproved',
      source: '6529.ops',
      'detail-type': LOOP_EVENT_TYPE,
      detail: message
    } as unknown as EventBridgeEvent<string, unknown>),
    /UNAPPROVED_SOURCE/
  );
});

test('incident lifecycle is silent for overlap, escalates once, and retries a durable outbox without inventing recovery', async () => {
  const original = process.env;
  process.env = {
    ...original,
    RECEIPTS_TABLE: 'test',
    CRITICAL_QUEUE_URL: 'https://example.com/critical'
  };
  const data = new Map<string, Record<string, unknown>>();
  const sent: string[] = [];
  let failQueue = false;
  let ambiguousQueue = false;
  const dbMock = mock.method(
    ddb,
    'send',
    async (command: GetCommand | PutCommand | UpdateCommand) => {
      if (command instanceof GetCommand)
        return { Item: data.get(String(command.input.Key?.pk)) };
      if (command instanceof PutCommand) {
        data.set(String(command.input.Item?.pk), { ...command.input.Item });
        return {};
      }
      const key = String(command.input.Key?.pk);
      const at = Number(command.input.ExpressionAttributeValues?.[':at']);
      if (Number(data.get(key)?.observedAt ?? 0) >= at)
        throw Object.assign(new Error('stale'), {
          name: 'ConditionalCheckFailedException'
        });
      data.set(key, {
        observedAt: at,
        payload: command.input.ExpressionAttributeValues?.[':payload']
      });
      return {};
    }
  );
  const queueMock = mock.method(
    sqs,
    'send',
    async (command: { input: { MessageBody?: string } }) => {
      if (failQueue) throw new Error('queue unavailable');
      sent.push(command.input.MessageBody!);
      if (ambiguousQueue) {
        ambiguousQueue = false;
        throw new Error('acceptance unknown');
      }
      return {};
    }
  );
  const policy: LoopPolicy = {
    ...policiesFor('staging').find((p) => p.service === 'delegationsLoop')!,
    operations: ['indexing']
  };
  const now = Math.floor(Date.now() / 1000) - 5000;
  const observation = {
    _type: LOOP_EVENT_TYPE,
    service: policy.service,
    operation: 'indexing',
    observedAt: now,
    progressAt: now - 60,
    oldestPendingAt: now - 120,
    pending: true,
    recovery: 'automatic'
  };
  try {
    await receiveLoopThrottle(policy.service, true, now);
    await receiveLoopThrottle(policy.service, true, now - 30, 'native-child');
    await receiveLoopThrottle(policy.service, false, now + 1);
    assert.equal(
      (
        data.get(`loop:throttle:${policy.service}`)?.payload as {
          active: boolean;
        }
      ).active,
      true
    );
    await receiveLoopThrottle(policy.service, false, now + 1, 'native-child');
    assert.equal(
      (
        data.get(`loop:throttle:${policy.service}`)?.payload as {
          active: boolean;
        }
      ).active,
      false
    );
    await receiveLoopThrottle(policy.service, true, now + 2);
    await receiveLoopObservation(observation, 'staging');
    const retainedWrites = dbMock.mock.calls
      .map((call) => call.arguments[0])
      .filter(
        (command): command is UpdateCommand => command instanceof UpdateCommand
      )
      .filter((command) => {
        const payload = command.input.ExpressionAttributeValues?.[':payload'];
        return payload?.active === true || payload?.pending === true;
      });
    assert.ok(retainedWrites.length > 0);
    assert.ok(
      retainedWrites.every((command) =>
        command.input.UpdateExpression?.includes('REMOVE expiresAt')
      )
    );
    await monitorLoop(policy, 'staging', now);
    await receiveLoopThrottle(policy.service, false, now + 3);
    await monitorLoop(policy, 'staging', now + 1);
    assert.equal(sent.length, 0);
    // A delayed snapshot, even with recent committed work, opens amber.
    await receiveLoopObservation(
      { ...observation, observedAt: now + 2, oldestPendingAt: now - 900 },
      'staging'
    );
    failQueue = true;
    await assert.rejects(
      monitorLoop(policy, 'staging', now + 2),
      /queue unavailable/
    );
    const pending = data.get(`loop:incident:${policy.service}`)?.pendingAlert;
    assert.ok(pending);
    assert.equal(
      data.get(`loop:incident:${policy.service}`)?.expiresAt,
      undefined
    );
    failQueue = false;
    await monitorLoop(policy, 'staging', now + 3);
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0]!).alert, pending);
    await monitorLoop(policy, 'staging', now + 4);
    assert.equal(sent.length, 1);
    // Late observations and alarm transitions cannot replace newer evidence.
    await receiveLoopObservation(observation, 'staging');
    await receiveLoopThrottle(policy.service, true, now - 1);
    assert.equal(
      (
        data.get(`loop:throttle:${policy.service}`)?.payload as {
          active: boolean;
        }
      ).active,
      false
    );
    await monitorLoop(policy, 'staging', now + 1300);
    assert.equal(JSON.parse(sent.at(-1)!).alert.loop.reason, 'stalled');
    await receiveLoopObservation(
      {
        ...observation,
        observedAt: now + 1301,
        pending: false,
        oldestPendingAt: undefined,
        watermarkAt: now + 1301,
        progressAt: now + 1301
      },
      'staging'
    );
    await monitorLoop(policy, 'staging', now + 1301);
    assert.equal(JSON.parse(sent.at(-1)!).alert.code, 'LOOP_RECOVERY');
    assert.ok(
      Number(data.get(`loop:incident:${policy.service}`)?.expiresAt) > now
    );
    const total = sent.length;
    await monitorLoop(policy, 'staging', now + 1302);
    assert.equal(sent.length, total);
    // Queue acceptance followed by a lost response must retry the saved identity.
    await receiveLoopObservation(
      { ...observation, observedAt: now + 1303, oldestPendingAt: now - 900 },
      'staging'
    );
    ambiguousQueue = true;
    await assert.rejects(
      monitorLoop(policy, 'staging', now + 1303),
      /acceptance unknown/
    );
    await monitorLoop(policy, 'staging', now + 1304);
    assert.equal(sent.length, total + 2);
    assert.equal(
      JSON.parse(sent[total]!).alert.eventId,
      JSON.parse(sent[total + 1]!).alert.eventId
    );
    await monitorLoop(policy, 'staging', now + 1305);
    assert.equal(sent.length, total + 2);
  } finally {
    dbMock.mock.restore();
    queueMock.mock.restore();
    process.env = original;
  }
});

test('enrolled raw throttles are recorded without immediate notifications; request-serving throttles retain their path', async () => {
  const original = process.env;
  process.env = {
    ...original,
    ENVIRONMENT: 'staging',
    SOURCE_ACCOUNTS: '123',
    SOURCE_REGION: 'eu-west-1',
    RECEIPTS_TABLE: 'test',
    CRITICAL_QUEUE_URL: 'critical'
  };
  const dbMock = mock.method(ddb, 'send', async () => ({}));
  const queueMock = mock.method(sqs, 'send', async () => ({}));
  const event = (name: string): EventBridgeEvent<string, unknown> => ({
    account: '123',
    region: 'eu-west-1',
    source: 'aws.cloudwatch',
    'detail-type': 'CloudWatch Alarm State Change',
    time: new Date().toISOString(),
    id: 'test',
    resources: [],
    version: '0',
    detail: {
      alarmName: `test-${name}`,
      state: { value: 'ALARM' },
      configuration: {
        metrics: [
          {
            metricStat: {
              metric: {
                namespace: 'AWS/Lambda',
                name: 'Throttles',
                dimensions: { FunctionName: name }
              },
              stat: 'Sum',
              period: 60
            }
          }
        ]
      }
    }
  });
  try {
    await collect(event('delegationsLoop'));
    assert.equal(queueMock.mock.callCount(), 0);
    assert.ok(
      dbMock.mock.calls.some(
        (call) => call.arguments[0] instanceof UpdateCommand
      )
    );
    await collect(event('seizeAPI'));
    assert.equal(queueMock.mock.callCount(), 1);
  } finally {
    dbMock.mock.restore();
    queueMock.mock.restore();
    process.env = original;
  }
});

test('insufficient throttle data cannot recover an incident; a later OK clears contention regardless of its previous state', async () => {
  const original = process.env;
  process.env = {
    ...original,
    ENVIRONMENT: 'staging',
    SOURCE_ACCOUNTS: '123',
    SOURCE_REGION: 'eu-west-1',
    RECEIPTS_TABLE: 'test',
    CRITICAL_QUEUE_URL: 'critical'
  };
  const { data, dbMock } = fakeState();
  const sent: string[] = [];
  const queueMock = mock.method(
    sqs,
    'send',
    async (command: { input: { MessageBody?: string } }) => {
      sent.push(command.input.MessageBody!);
      return {};
    }
  );
  const policy = policiesFor('staging').find(
    (item) => item.service === 'delegationsLoop'
  )!;
  const now = Math.floor(Date.now() / 1000) - 60;
  const event = (
    state: string,
    previousState: string,
    at: number
  ): EventBridgeEvent<string, unknown> => ({
    account: '123',
    region: 'eu-west-1',
    source: 'aws.cloudwatch',
    'detail-type': 'CloudWatch Alarm State Change',
    time: new Date(at * 1000).toISOString(),
    id: `throttle-${at}`,
    resources: [],
    version: '0',
    detail: {
      alarmName: 'delegations-throttles',
      state: { value: state },
      previousState: { value: previousState },
      configuration: {
        metrics: [
          {
            metricStat: {
              metric: {
                namespace: 'AWS/Lambda',
                name: 'Throttles',
                dimensions: { FunctionName: policy.service }
              },
              stat: 'Sum',
              period: 60
            }
          }
        ]
      }
    }
  });
  const active = () =>
    (
      data.get(`loop:throttle:${policy.service}`)?.payload as {
        active: boolean;
      }
    ).active;
  try {
    await collect(event('OK', 'INSUFFICIENT_DATA', now));
    await monitorLoop(policy, 'staging', now);
    assert.equal(active(), false);
    assert.equal(sent.length, 0);

    await collect(event('ALARM', 'OK', now + 1));
    await monitorLoop(policy, 'staging', now + 1);
    assert.equal(active(), true);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0]!).alert.loop.reason, 'unconfirmed');

    await collect(event('INSUFFICIENT_DATA', 'ALARM', now + 2));
    await monitorLoop(policy, 'staging', now + 2);
    assert.equal(active(), true);
    assert.equal(sent.length, 1);

    await collect(event('OK', 'INSUFFICIENT_DATA', now + 3));
    await monitorLoop(policy, 'staging', now + 3);
    assert.equal(active(), false);
    assert.equal(sent.length, 2);
    const recovery = JSON.parse(sent[1]!).alert;
    assert.equal(recovery.code, 'LOOP_RECOVERY');
    assert.equal(recovery.loop.scope, 'contention');
    assert.equal(recovery.loop.reason, 'contention_cleared');

    await collect(event('ALARM', 'OK', now + 1));
    await monitorLoop(policy, 'staging', now + 4);
    assert.equal(active(), false);
    assert.equal(sent.length, 2);
  } finally {
    dbMock.mock.restore();
    queueMock.mock.restore();
    process.env = original;
  }
});

function fakeState() {
  const data = new Map<string, Record<string, unknown>>();
  const dbMock = mock.method(
    ddb,
    'send',
    async (command: GetCommand | PutCommand | UpdateCommand) => {
      if (command instanceof GetCommand)
        return { Item: data.get(String(command.input.Key?.pk)) };
      if (command instanceof PutCommand) {
        data.set(String(command.input.Item?.pk), { ...command.input.Item });
        return {};
      }
      const key = String(command.input.Key?.pk);
      const values = command.input.ExpressionAttributeValues!;
      const previous = data.get(key)?.observedAt;
      if (
        previous !== undefined &&
        (Number(previous) >= Number(values[':at']) ||
          previous !== values[':expected'])
      )
        throw Object.assign(new Error('race'), {
          name: 'ConditionalCheckFailedException'
        });
      data.set(key, { observedAt: values[':at'], payload: values[':payload'] });
      return {};
    }
  );
  return { data, dbMock };
}

test('simultaneous observations converge, and equal or older replays are successful no-ops', async () => {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  const { data, dbMock } = fakeState();
  const observation = {
    _type: LOOP_EVENT_TYPE,
    service: 'delegationsLoop',
    operation: 'indexing',
    observedAt: 100,
    pending: true,
    recovery: 'automatic'
  };
  try {
    await Promise.all([
      receiveLoopObservation(observation, 'staging'),
      receiveLoopObservation(observation, 'staging')
    ]);
    await Promise.all(
      [101, 102, 103].map((observedAt) =>
        receiveLoopObservation({ ...observation, observedAt }, 'staging')
      )
    );
    await receiveLoopObservation(observation, 'staging');
    const saved = data.get('loop:observation:delegationsLoop:indexing');
    assert.equal(saved?.observedAt, 103);
    assert.equal((saved?.payload as { baselineAt: number }).baselineAt, 100);
  } finally {
    dbMock.mock.restore();
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  }
});

test('alarm renames reclaim resolved identities without clearing a different active alarm', async () => {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  const { data, dbMock } = fakeState();
  try {
    await receiveLoopThrottle('delegationsLoop', true, 100, 'persistent');
    for (let index = 0; index < 12; index++) {
      await receiveLoopThrottle(
        'delegationsLoop',
        true,
        101 + index * 2,
        `renamed-${index}`
      );
      await receiveLoopThrottle(
        'delegationsLoop',
        false,
        102 + index * 2,
        `renamed-${index}`
      );
    }
    const state = data.get('loop:throttle:delegationsLoop')?.payload as {
      active: boolean;
      alarms: Record<string, unknown>;
    };
    assert.equal(state.active, true);
    assert.equal(Object.keys(state.alarms).length, 8);
    await receiveLoopThrottle('delegationsLoop', false, 200, 'persistent');
    assert.equal(
      (
        data.get('loop:throttle:delegationsLoop')?.payload as {
          active: boolean;
        }
      ).active,
      false
    );
  } finally {
    dbMock.mock.restore();
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  }
});

test('an exhausted monitoring I/O budget aborts before new business-health reads', async () => {
  const dbMock = mock.method(ddb, 'send', async () => ({}));
  try {
    await assert.rejects(
      monitorLoop(
        policiesFor('staging')[0]!,
        'staging',
        100,
        AbortSignal.abort()
      ),
      { name: 'AbortError' }
    );
    assert.equal(dbMock.mock.callCount(), 0);
  } finally {
    dbMock.mock.restore();
  }
});

test('health admission has its own quota key and cannot consume the error-alert budget', async () => {
  const original = process.env;
  process.env = {
    ...original,
    RECEIPTS_TABLE: 'test',
    ENVIRONMENT: 'staging',
    SOURCE_ACCOUNTS: '123'
  };
  const dbMock = mock.method(ddb, 'send', async () => ({}));
  const observation = {
    _type: LOOP_EVENT_TYPE,
    service: 'delegationsLoop',
    operation: 'indexing',
    observedAt: 100,
    pending: true,
    recovery: 'automatic'
  };
  const event = {
    account: '123',
    source: '6529.ops',
    'detail-type': LOOP_EVENT_TYPE,
    detail: observation
  } as unknown as EventBridgeEvent<string, unknown>;
  try {
    await collect(event);
    const keys = dbMock.mock.calls.map((call) =>
      String((call.arguments[0] as UpdateCommand).input.Key?.pk)
    );
    assert.equal(
      keys.filter((key) =>
        key.startsWith('loop-quota:staging:delegationsLoop:')
      ).length,
      1
    );
    assert.equal(keys.filter((key) => key.startsWith('quota:')).length, 0);
    await admit({ environment: 'staging', service: 'delegationsLoop' });
    assert.match(
      String(
        (dbMock.mock.calls.at(-1)!.arguments[0] as UpdateCommand).input.Key?.pk
      ),
      /^quota:staging:delegationsLoop:/
    );
    const count = dbMock.mock.callCount();
    await assert.rejects(
      collect({ ...event, detail: { ...observation, operation: 'forged' } }),
      /UNAPPROVED_LOOP_OPERATION/
    );
    assert.equal(dbMock.mock.callCount(), count);
  } finally {
    dbMock.mock.restore();
    process.env = original;
  }
});

test('monitoring passes the shared budget to in-flight SDK reads and propagates cancellation', async () => {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  const controller = new AbortController();
  const dbMock = mock.method(
    ddb,
    'send',
    async (_command: GetCommand, options: { abortSignal: AbortSignal }) => {
      assert.equal(options.abortSignal, controller.signal);
      return new Promise((_resolve, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason),
          { once: true }
        )
      );
    }
  );
  try {
    const policy = policiesFor('staging')[0]!;
    const pending = monitorLoop(policy, 'staging', 100, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(dbMock.mock.callCount(), 2 + policy.operations.length);
  } finally {
    dbMock.mock.restore();
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  }
});

test('late scheduled starts retain the due baseline across retries without inventing progress', async () => {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  const { data, dbMock } = fakeState();
  const base = {
    _type: LOOP_EVENT_TYPE,
    service: 'nftsLoop',
    operation: 'discovery',
    recovery: 'automatic'
  };
  try {
    await receiveLoopObservation(
      {
        ...base,
        observedAt: 100,
        pending: false,
        progressAt: 100,
        nextDueAt: 160
      },
      'staging'
    );
    await receiveLoopObservation(
      { ...base, observedAt: 2000, pending: true },
      'staging'
    );
    await receiveLoopObservation(
      { ...base, observedAt: 2001, pending: true },
      'staging'
    );
    const payload = data.get('loop:observation:nftsLoop:discovery')
      ?.payload as Record<string, unknown>;
    assert.equal(payload.baselineAt, 160);
    assert.equal(payload.oldestPendingAt, 160);
    assert.equal(payload.progressAt, undefined);
  } finally {
    dbMock.mock.restore();
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  }
});

test('terminal preview removals cannot advance successful processing progress', async () => {
  const original = process.env.RECEIPTS_TABLE;
  process.env.RECEIPTS_TABLE = 'test';
  const { data, dbMock } = fakeState();
  const base = {
    _type: LOOP_EVENT_TYPE,
    service: 'nftLinkMediaPreviewLoop',
    operation: 'processing',
    pending: true,
    recovery: 'unknown'
  };
  try {
    await receiveLoopObservation(
      { ...base, observedAt: 100, oldestPendingAt: 80 },
      'staging'
    );
    await receiveLoopObservation(
      { ...base, observedAt: 110, oldestPendingAt: 90 },
      'staging'
    );
    const key = 'loop:observation:nftLinkMediaPreviewLoop:processing';
    assert.equal(
      (data.get(key)?.payload as Record<string, unknown>).progressAt,
      undefined
    );
    await receiveLoopObservation(
      { ...base, observedAt: 120, oldestPendingAt: 95, progressAt: 115 },
      'staging'
    );
    assert.equal(
      (data.get(key)?.payload as Record<string, unknown>).progressAt,
      115
    );
  } finally {
    dbMock.mock.restore();
    if (original === undefined) delete process.env.RECEIPTS_TABLE;
    else process.env.RECEIPTS_TABLE = original;
  }
});

test('a preview backlog shrinking only through terminal failures still opens a red stalled incident', async () => {
  const original = process.env;
  process.env = {
    ...original,
    RECEIPTS_TABLE: 'test',
    CRITICAL_QUEUE_URL: 'https://example.com/critical'
  };
  const { data, dbMock } = fakeState();
  let sent = 0;
  const queueMock = mock.method(sqs, 'send', async () => {
    sent++;
    return {};
  });
  const policy = policiesFor('staging').find(
    (p) => p.service === 'nftLinkMediaPreviewLoop'
  )!;
  const now = 100 + policy.stallSeconds + 1;
  const base = {
    _type: LOOP_EVENT_TYPE,
    service: policy.service,
    operation: 'processing',
    pending: true,
    recovery: 'unknown'
  };
  try {
    await receiveLoopObservation(
      { ...base, observedAt: 100, oldestPendingAt: 80 },
      'staging'
    );
    await receiveLoopObservation(
      { ...base, observedAt: now, oldestPendingAt: now - 10 },
      'staging'
    );
    await monitorLoop(policy, 'staging', now);
    const incident = data.get(`loop:incident:${policy.service}`);
    assert.equal(incident?.level, 'red');
    assert.equal(incident?.reason, 'stalled');
    assert.equal(sent, 1);
  } finally {
    queueMock.mock.restore();
    dbMock.mock.restore();
    process.env = original;
  }
});
