import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { collect, logAlerts, probe, probeUrl } from './handlers.js';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { EVENT_TYPE } from './contract.js';
import { ddb, sqs } from './aws.js';
import type { EventBridgeEvent } from 'aws-lambda';
const group = '/aws/lambda/seizeAPI';
const event = {
  _type: EVENT_TYPE,
  eventId: 'fake',
  occurredAt: '2026-09-12T00:00:00Z',
  environment: 'staging',
  service: 'fake-service',
  severity: 'critical',
  code: 'APPLICATION_ERROR',
  fingerprint: '123'
};
function encode(messages: string[], owner = '123456789012') {
  return gzipSync(
    JSON.stringify({
      messageType: 'DATA_MESSAGE',
      owner,
      logGroup: group,
      logStream: '2026/09/12/[$LATEST]test',
      logEvents: messages.map((message, i) => ({
        id: String(i),
        message,
        timestamp: 1789171200000
      }))
    })
  ).toString('base64');
}
test('raw stdout and Lambda JSON log envelopes normalize using authenticated AWS metadata', () => {
  const direct = JSON.stringify(event) + '\n';
  const jsonWrapped = JSON.stringify({
    timestamp: '2026-09-12T00:00:00Z',
    level: 'INFO',
    message: direct
  });
  const alerts = logAlerts(
    encode([
      direct,
      jsonWrapped,
      '2026-09-12T00:00:00Z\trequest\tERROR\tprivate exception'
    ]),
    '123456789012',
    [group],
    'prod'
  );
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0]?.service, 'seizeAPI');
  assert.equal(alerts[0]?.severity, 'error');
  assert.equal(alerts[0]?.environment, 'prod');
  assert.notEqual(alerts[0]?.eventId, alerts[1]?.eventId);
  assert.deepEqual(
    logAlerts(encode([direct]), '123456789012', [group], 'prod'),
    alerts.slice(0, 1)
  );
  assert.throws(
    () =>
      logAlerts(
        encode([direct], '999999999999'),
        '123456789012',
        [group],
        'prod'
      ),
    /UNAPPROVED_LOG_SOURCE/
  );
});
test('canonical log envelopes take precedence over unknown message fields and redact both Lambda wrapper forms', () => {
  const sentinel = 'PRIVATE_UNKNOWN_MESSAGE_AND_EVIDENCE';
  const direct = { ...event, message: sentinel, evidence: { text: sentinel } };
  const messages = [
    direct,
    { ...direct, message: { text: sentinel } },
    {
      timestamp: event.occurredAt,
      level: 'ERROR',
      message: JSON.stringify(direct)
    },
    { timestamp: event.occurredAt, level: 'ERROR', message: direct }
  ];
  const alerts = logAlerts(
    encode([
      ...messages.map((value) => JSON.stringify(value)),
      JSON.stringify({ message: sentinel })
    ]),
    '123456789012',
    [group],
    'prod'
  );
  assert.equal(alerts.length, messages.length);
  assert.equal(
    new Set(alerts.map((alert) => alert.eventId)).size,
    messages.length
  );
  for (const alert of alerts) {
    assert.equal(alert._type, EVENT_TYPE);
    assert.equal(alert.service, 'seizeAPI');
    assert.equal(alert.environment, 'prod');
    assert.equal(alert.severity, 'error');
    assert.equal(Object.hasOwn(alert, 'message'), false);
    assert.equal(Object.hasOwn(alert, 'evidence'), false);
    assert.equal(JSON.stringify(alert).includes(sentinel), false);
  }
});

test('operator check-in URLs reject non-HTTPS, IPs, local hosts and credentials without echoing secrets', () => {
  for (const input of [
    'http://example.com',
    'https://127.0.0.1',
    'https://test.local',
    'https://name:secret@example.com',
    'secret'
  ]) {
    assert.throws(() => probeUrl(input), /INVALID_PROBE_TARGET/);
  }
  assert.equal(probeUrl('https://example.com/health').pathname, '/health');
});

test('authenticated source routing protects the critical lane and suppresses initial OK alarm spam', async () => {
  const original = process.env;
  process.env = {
    ...original,
    ENVIRONMENT: 'prod',
    SOURCE_ACCOUNTS: '123456789012',
    SOURCE_REGION: 'us-east-1',
    ALLOWED_SERVICES: 'seizeAPI',
    RECEIPTS_TABLE: 'test',
    NORMAL_QUEUE_URL: 'normal',
    CRITICAL_QUEUE_URL: 'critical'
  };
  const queued: unknown[] = [];
  const dbMock = mock.method(ddb, 'send', async () => ({}));
  const queueMock = mock.method(
    sqs,
    'send',
    async (command: { input: unknown }) => {
      queued.push(command.input);
      return {};
    }
  );
  const base: EventBridgeEvent<string, unknown> = {
    id: 'event123',
    version: '0',
    account: '123456789012',
    region: 'us-east-1',
    time: '2026-09-12T00:00:00Z',
    resources: [],
    source: '6529.ops',
    'detail-type': EVENT_TYPE,
    detail: {
      ...event,
      environment: 'prod',
      service: 'seizeAPI',
      message: 'private input'
    }
  };
  try {
    await collect(base);
    assert.equal((queued[0] as { QueueUrl: string }).QueueUrl, 'normal');
    assert.match(
      (queued[0] as { MessageBody: string }).MessageBody,
      /"severity":"error"/
    );
    assert.equal(JSON.stringify(queued).includes('private input'), false);
    await assert.rejects(
      () => collect({ ...base, account: '999999999999' }),
      /UNAPPROVED_SOURCE/
    );
    const alarm = {
      ...base,
      source: 'aws.cloudwatch',
      'detail-type': 'CloudWatch Alarm State Change',
      detail: {
        alarmName: 'test',
        state: { value: 'OK' },
        previousState: { value: 'INSUFFICIENT_DATA' }
      }
    };
    await collect(alarm);
    assert.equal(queued.length, 1);
    await collect({
      ...alarm,
      detail: { ...alarm.detail, state: { value: 'ALARM' } }
    });
    assert.equal((queued[1] as { QueueUrl: string }).QueueUrl, 'critical');
    await assert.rejects(
      () => collect({ ...alarm, region: 'eu-west-1' }),
      /UNAPPROVED_SOURCE_REGION/
    );
  } finally {
    process.env = original;
    dbMock.mock.restore();
    queueMock.mock.restore();
  }
});

test('queue heartbeat metrics survive malformed probe config and endpoint-state storage failures', async () => {
  const original = process.env;
  const metrics: unknown[] = [];
  const metricMock = mock.method(
    CloudWatchClient.prototype,
    'send',
    async (command: { input: unknown }) => {
      metrics.push(command.input);
      return {};
    }
  );
  const dbMock = mock.method(
    ddb,
    'send',
    async (command: { input: { Key?: { pk?: string } } }) => {
      if (command.input.Key?.pk?.startsWith('probe:'))
        throw new Error('PROBE_STORAGE_FAILED');
      return { Item: { seenAt: Math.floor(Date.now() / 1000) } };
    }
  );
  const queueMock = mock.method(sqs, 'send', async () => ({}));
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 200 })
  );
  process.env = {
    ...original,
    ENVIRONMENT: 'prod',
    RECEIPTS_TABLE: 'test',
    NORMAL_QUEUE_URL: 'normal',
    CRITICAL_QUEUE_URL: 'critical'
  };
  try {
    process.env.PROBE_TARGETS = 'invalid-json';
    await assert.rejects(probe, /INVALID_PROBE_TARGETS/);
    assert.equal(metrics.length, 1);
    process.env.PROBE_TARGETS = JSON.stringify([
      {
        name: 'api',
        url: 'https://api.example.com/health',
        expectedStatus: 200
      }
    ]);
    await assert.rejects(probe, /PROBE_STORAGE_FAILED/);
    assert.equal(metrics.length, 3);
    assert.equal(JSON.stringify(metrics).includes('HeartbeatAge'), true);
    const observation = metrics[2] as {
      MetricData: { MetricName: string; Value: number; Dimensions: unknown }[];
    };
    assert.deepEqual(
      observation.MetricData.map((item) => item.MetricName),
      ['ProbeSuccess', 'ProbeFailure', 'ProbeDurationMilliseconds']
    );
    assert.equal(observation.MetricData[0]?.Value, 1);
    assert.equal(observation.MetricData[1]?.Value, 0);
    assert.deepEqual(observation.MetricData[0]?.Dimensions, [
      { Name: 'Environment', Value: 'prod' },
      { Name: 'Target', Value: 'api' }
    ]);
    assert.equal(
      JSON.stringify(observation).includes('api.example.com'),
      false
    );
  } finally {
    process.env = original;
    metricMock.mock.restore();
    dbMock.mock.restore();
    queueMock.mock.restore();
    fetchMock.mock.restore();
  }
});

test('failed probe-metric publication preserves the critical uptime alert and suppresses private diagnostics', async () => {
  const original = process.env;
  process.env = {
    ...original,
    ENVIRONMENT: 'staging',
    RECEIPTS_TABLE: 'test',
    NORMAL_QUEUE_URL: 'normal',
    CRITICAL_QUEUE_URL: 'critical',
    PROBE_TARGETS: JSON.stringify([
      { name: 'api', url: 'https://api.example.com/health' }
    ])
  };
  const queued: { QueueUrl?: string; MessageBody?: string }[] = [];
  const logged: unknown[] = [];
  const metricMock = mock.method(
    CloudWatchClient.prototype,
    'send',
    async (command: { input: { MetricData?: { MetricName?: string }[] } }) => {
      if (command.input.MetricData?.[0]?.MetricName === 'ProbeSuccess')
        throw new Error('private AWS diagnostic');
      return {};
    }
  );
  const dbMock = mock.method(
    ddb,
    'send',
    async (command: {
      input: { Key?: { pk?: string }; Item?: { pk?: string } };
    }) => {
      if (command.input.Key?.pk?.startsWith('probe:'))
        return { Item: { failures: 1, down: false } };
      if (command.input.Item?.pk?.startsWith('probe:'))
        throw new Error('PROBE_STATE_WRITE_REACHED');
      return { Item: { seenAt: Math.floor(Date.now() / 1000) } };
    }
  );
  const queueMock = mock.method(
    sqs,
    'send',
    async (command: { input: { QueueUrl?: string; MessageBody?: string } }) => {
      queued.push(command.input);
      return {};
    }
  );
  const logMock = mock.method(console, 'log', (entry: unknown) => {
    logged.push(entry);
  });
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response('private response', { status: 503 })
  );
  try {
    await assert.rejects(probe, /PROBE_STATE_WRITE_REACHED/);
    assert.ok(
      queued.some(
        (message) =>
          message.QueueUrl === 'critical' &&
          message.MessageBody?.includes('UPTIME_FAILURE')
      )
    );
    assert.ok(
      JSON.stringify(logged).includes('ProbeMetricPublicationFailures')
    );
    assert.equal(JSON.stringify([queued, logged]).includes('private'), false);
  } finally {
    process.env = original;
    for (const mocked of [metricMock, dbMock, queueMock, logMock, fetchMock])
      mocked.mock.restore();
  }
});

test('ten target observations flush once after alert/state work, including a final state failure', async () => {
  const original = process.env;
  process.env = {
    ...original,
    ENVIRONMENT: 'prod',
    RECEIPTS_TABLE: 'test',
    NORMAL_QUEUE_URL: 'normal',
    CRITICAL_QUEUE_URL: 'critical',
    PROBE_TARGETS: JSON.stringify(
      Array.from({ length: 10 }, (_, index) => ({
        name: `api${index}`,
        url: 'https://api.example.com/health'
      }))
    )
  };
  let states = 0;
  let alerts = 0;
  let publications = 0;
  const metricMock = mock.method(
    CloudWatchClient.prototype,
    'send',
    async function (
      this: CloudWatchClient,
      command: {
        input: { MetricData?: { MetricName?: string; Timestamp?: Date }[] };
      },
      options?: { abortSignal?: AbortSignal }
    ) {
      if (command.input.MetricData?.[0]?.MetricName === 'ProbeSuccess') {
        publications++;
        assert.equal(states, 10);
        assert.equal(alerts, 10);
        assert.equal(command.input.MetricData.length, 30);
        assert.ok(
          command.input.MetricData.every(
            (item) => item.Timestamp instanceof Date
          )
        );
        assert.ok(options?.abortSignal);
        assert.equal(await this.config.maxAttempts(), 1);
      }
      return {};
    }
  );
  const dbMock = mock.method(
    ddb,
    'send',
    async (command: {
      input: { Key?: { pk?: string }; Item?: { pk?: string } };
    }) => {
      if (command.input.Key?.pk?.startsWith('probe:'))
        return { Item: { failures: 1, down: false } };
      if (command.input.Item?.pk?.startsWith('probe:') && ++states === 10)
        throw new Error('LAST_STATE_FAILURE');
      return { Item: { seenAt: Math.floor(Date.now() / 1000) } };
    }
  );
  const queueMock = mock.method(
    sqs,
    'send',
    async (command: { input: { MessageBody?: string } }) => {
      if (command.input.MessageBody?.includes('UPTIME_FAILURE')) alerts++;
      return {};
    }
  );
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 })
  );
  try {
    await assert.rejects(probe, /LAST_STATE_FAILURE/);
    assert.equal(publications, 1);
  } finally {
    process.env = original;
    for (const mocked of [metricMock, dbMock, queueMock, fetchMock])
      mocked.mock.restore();
  }
});
