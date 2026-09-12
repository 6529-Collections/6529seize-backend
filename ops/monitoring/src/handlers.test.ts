import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { collect, logAlerts, probeUrl } from './handlers.js';
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
