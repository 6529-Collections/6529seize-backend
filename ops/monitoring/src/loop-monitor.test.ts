import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, sqs } from './aws.js';
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
