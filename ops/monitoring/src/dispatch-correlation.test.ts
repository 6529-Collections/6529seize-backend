import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  type ChangeMessageVisibilityCommandInput,
  type SendMessageCommandInput
} from '@aws-sdk/client-sqs';
import type { Context, SQSEvent } from 'aws-lambda';
import { ddb, sqs, store } from './aws.js';
import { EVENT_TYPE, hash, type Alert } from './contract.js';
import { dispatch } from './handlers.js';
import { processWork, type Group, type Store, type Work } from './pipeline.js';
import { DeliveryError } from './webhook.js';
import type { DeliveryResult, DigestPlan } from './digest-plan.js';
import {
  bindDispatchWork,
  logDispatchFailure,
  traceDispatch,
  withDispatchDiagnostics
} from './dispatch-diagnostics.js';

const now = 1789326000000;
const privateMarker = 'PRIVATE_DISPATCH_TEST_VALUE';
const destination = `https://discord.com/api/webhooks/123/${privateMarker}`;
const alert: Alert = {
  _type: EVENT_TYPE,
  eventId: 'private-event:first',
  occurredAt: '2026-09-13T19:00:00Z',
  environment: 'prod',
  service: 'private-service',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'private-fingerprint',
  correlationId: 'private-correlation',
  release: 'private-release'
};
const context: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'dispatcher',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'private-function-arn',
  memoryLimitInMB: '512',
  awsRequestId: 'private-lambda-request',
  logGroupName: 'private-log-group',
  logStreamName: 'private-log-stream',
  getRemainingTimeInMillis: () => 30000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined
};

type Receipt = {
  busy?: boolean;
  outcome?: string;
  groupKey?: string;
  delivery?: DeliveryResult;
};
type LogEntry = Record<string, unknown>;

function row(value: unknown, messageId = 'private-sqs-message', count = 1) {
  return {
    messageId,
    receiptHandle: `${privateMarker}:${messageId}`,
    body: JSON.stringify(value),
    attributes: {
      ApproximateReceiveCount: String(count),
      ApproximateFirstReceiveTimestamp: String(now),
      SentTimestamp: String(now),
      SenderId: privateMarker
    },
    messageAttributes: {},
    md5OfBody: 'test',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:eu-west-1:123456789012:test',
    awsRegion: 'eu-west-1'
  } satisfies SQSEvent['Records'][number];
}

function sdkError(name: string) {
  return Object.assign(new Error(privateMarker), {
    name,
    $metadata: {
      httpStatusCode: 400,
      attempts: 3,
      requestId: privateMarker
    }
  });
}

function harness(t: TestContext, lane = 'normal', boundDestination = false) {
  const originalEnvironment = process.env;
  process.env = {
    ...originalEnvironment,
    ENVIRONMENT: 'prod',
    LANE: lane,
    RECEIPTS_TABLE: 'test-receipts',
    WEBHOOK_SECRET_ARN: `test-secret:${hash(t.name)}`,
    NORMAL_QUEUE_URL: 'normal-queue',
    CRITICAL_QUEUE_URL: 'critical-queue',
    ARCHIVE_BUCKET: 'test-archive',
    FALLBACK_TOPIC_ARN: 'test-fallback'
  };
  t.after(() => {
    process.env = originalEnvironment;
  });
  let clockNow = now;
  let credentialVersion = 'fixture-version-1';
  t.mock.method(Date, 'now', () => clockNow);
  const calls: string[] = [];
  const failures = new Map<string, unknown[]>();
  const receipts = new Map<string, Receipt>();
  const groups = new Map<string, Group>();
  const plans = new Map<string, DigestPlan>();
  const logged: LogEntry[] = [];
  const scheduled: SendMessageCommandInput[] = [];
  const visibility: ChangeMessageVisibilityCommandInput[] = [];
  const archives: PutObjectCommandInput[] = [];
  const responses: Response[] = [];
  const payloads: string[] = [];
  const methods: string[] = [];
  function call(operation: string) {
    calls.push(operation);
    const pending = failures.get(operation);
    if (pending?.length) throw pending.shift();
  }
  function fail(operation: string, error: unknown) {
    const pending = failures.get(operation) ?? [];
    pending.push(error);
    failures.set(operation, pending);
  }
  const memory: Store = {
    async reserve(id) {
      call('RESERVE');
      const receipt = receipts.get(id) ?? {};
      if (receipt.outcome) return 'done';
      if (receipt.busy) return 'busy';
      receipt.busy = true;
      receipts.set(id, receipt);
      return 'acquired';
    },
    async complete(id, _owner, outcome, delivery) {
      call('COMPLETE');
      receipts.set(id, { ...receipts.get(id), busy: false, outcome, delivery });
    },
    async release(id) {
      call('RELEASE');
      const receipt = receipts.get(id);
      assert.ok(receipt);
      receipt.busy = false;
    },
    async group(key, id, item) {
      call('GROUP');
      const receipt = receipts.get(id);
      assert.ok(receipt);
      if (receipt.groupKey) {
        const existing = groups.get(receipt.groupKey);
        assert.ok(existing);
        return existing;
      }
      const group = groups.get(key) ?? {
        key,
        count: 0,
        firstEventId: id,
        alert: item
      };
      group.count++;
      groups.set(key, group);
      receipt.groupKey = key;
      return group;
    },
    async readGroup(key) {
      call('DIGEST_READ');
      return groups.get(key) ?? null;
    },
    async prepareDigest(id, _owner, group) {
      const current = plans.get(id);
      if (current) return current;
      const first = receipts.get(group.firstEventId)?.delivery;
      const snapshot = {
        version: 1 as const,
        groupKey: group.key,
        count: group.count
      };
      const plan: DigestPlan = first?.destinationKey
        ? {
            ...snapshot,
            mode: 'EDIT',
            target: {
              messageId: first.messageId,
              destinationKey: first.destinationKey
            }
          }
        : { ...snapshot, mode: 'POST', reason: 'NO_ACK' };
      plans.set(id, plan);
      return plan;
    },
    async fallbackDigest(id, _owner, plan) {
      const fallback = {
        version: 1 as const,
        groupKey: plan.groupKey,
        count: plan.count,
        mode: 'POST' as const,
        reason: 'TARGET_MISSING' as const,
        destinationKey: plan.target.destinationKey
      };
      plans.set(id, fallback);
      return fallback;
    },
    async heartbeat() {
      call('HEARTBEAT');
    }
  };
  t.mock.method(store, 'reserve', memory.reserve);
  t.mock.method(store, 'complete', memory.complete);
  t.mock.method(store, 'release', memory.release);
  t.mock.method(store, 'group', memory.group);
  t.mock.method(store, 'readGroup', memory.readGroup);
  t.mock.method(store, 'prepareDigest', memory.prepareDigest);
  t.mock.method(store, 'fallbackDigest', memory.fallbackDigest);
  t.mock.method(store, 'heartbeat', memory.heartbeat);
  t.mock.method(
    ddb,
    'send',
    async (command: { input: { Key?: { pk?: string } } }) => {
      assert.equal(command.input.Key?.pk, 'delivery-rate:normal');
      call('RATE_SLOT');
      return {};
    }
  );
  t.mock.method(SecretsManagerClient.prototype, 'send', async () => {
    call('SECRET');
    return {
      SecretString: destination,
      ...(boundDestination ? { VersionId: credentialVersion } : {})
    };
  });
  t.mock.method(
    S3Client.prototype,
    'send',
    async (command: { input: PutObjectCommandInput }) => {
      call('ARCHIVE');
      archives.push(command.input);
      return {};
    }
  );
  t.mock.method(SNSClient.prototype, 'send', async () => {
    call('FALLBACK');
    return {};
  });
  t.mock.method(
    sqs,
    'send',
    async (command: SendMessageCommand | ChangeMessageVisibilityCommand) => {
      if (command instanceof ChangeMessageVisibilityCommand) {
        visibility.push(command.input);
        call('VISIBILITY');
      } else {
        scheduled.push(command.input);
        call('SCHEDULE');
      }
      return {};
    }
  );
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options?: RequestInit) => {
      call('WEBHOOK');
      assert.ok(options);
      if (options.method === 'PATCH') {
        assert.ok(boundDestination);
        assert.equal(String(url), `${destination}/messages/123456789012345678`);
      } else assert.equal(options.method, 'POST');
      methods.push(options.method);
      assert.ok(typeof options.body === 'string');
      payloads.push(options.body);
      return (
        responses.shift() ??
        new Response('{"id":"123456789012345678"}', { status: 200 })
      );
    }
  );
  const capture = (value: unknown) => {
    assert.ok(typeof value === 'string');
    logged.push(JSON.parse(value) as LogEntry);
  };
  t.mock.method(console, 'log', capture);
  t.mock.method(console, 'error', capture);
  t.after(() => {
    const text = JSON.stringify(logged);
    for (const forbidden of [
      privateMarker,
      destination,
      alert.eventId,
      alert.fingerprint,
      alert.service,
      alert.correlationId!,
      alert.release!,
      context.awsRequestId,
      'private-sqs-',
      '123456789012345678'
    ])
      assert.equal(
        text.includes(forbidden),
        false,
        `diagnostics leaked ${forbidden}`
      );
  });
  return {
    calls,
    fail,
    receipts,
    groups,
    logged,
    scheduled,
    visibility,
    archives,
    responses,
    payloads,
    methods,
    rotateCredential: () => {
      credentialVersion = 'fixture-version-2';
      clockNow += 60001;
    },
    memory,
    failures: () => logged.filter((entry) => entry.code === 'DELIVERY_FAILED'),
    settled: () => logged.filter((entry) => entry.code === 'DELIVERY_SETTLED'),
    metricCount: () =>
      logged.reduce(
        (count, entry) => count + Number(entry.DeliveryFailures ?? 0),
        0
      ),
    run: (...records: SQSEvent['Records']) =>
      dispatch({ Records: records }, context)
  };
}

test('failed attempts join delivered and grouped retries without repeating group counts', async (t) => {
  const h = harness(t);
  const first: Work = { kind: 'alert', alert };
  h.fail('WEBHOOK', new DOMException(privateMarker, 'TimeoutError'));
  assert.deepEqual(await h.run(row(first)), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-message' }]
  });
  assert.deepEqual(await h.run(row(first, 'private-sqs-message', 2)), {
    batchItemFailures: []
  });
  const [failed] = h.failures();
  const [delivered] = h.settled();
  assert.ok(failed && delivered);
  assert.equal(failed.operation, 'WEBHOOK');
  assert.equal(failed.cause, 'TRANSPORT_TIMEOUT');
  assert.equal(failed.deliveryAcceptance, 'UNKNOWN');
  assert.equal(delivered.outcome, 'DELIVERED');
  assert.equal(delivered.deliveryAcceptance, 'CONFIRMED');
  assert.equal(failed.workHash, hash(alert.eventId));
  assert.equal(failed.workHash, delivered.workHash);
  assert.equal(failed.sqsMessageHash, hash('private-sqs-message'));
  assert.equal(failed.sqsMessageHash, delivered.sqsMessageHash);
  assert.deepEqual([failed.receiveCount, delivered.receiveCount], [1, 2]);
  const second: Work = {
    kind: 'alert',
    alert: { ...alert, eventId: 'private-event:second' }
  };
  h.fail(
    'GROUP',
    Object.assign(sdkError('TransactionCanceledException'), {
      CancellationReasons: [
        { Code: 'None', Message: privateMarker },
        { Code: 'TransactionConflict' }
      ]
    })
  );
  await h.run(row(second, 'private-sqs-second'));
  assert.deepEqual(await h.run(row(second, 'private-sqs-second', 2)), {
    batchItemFailures: []
  });
  const groupFailure = h.failures()[1];
  const grouped = h.settled()[1];
  assert.ok(groupFailure && grouped);
  assert.equal(groupFailure.operation, 'GROUP');
  assert.equal(groupFailure.cause, 'DDB_TRANSACTION_CONFLICT');
  assert.equal(groupFailure.sdkAttempts, 3);
  assert.deepEqual(groupFailure.cancellationCodes, [
    'None',
    'TransactionConflict'
  ]);
  assert.equal(grouped.outcome, 'GROUPED');
  assert.equal(grouped.deliveryAcceptance, 'NOT_ATTEMPTED');
  assert.equal(groupFailure.workHash, grouped.workHash);
  assert.equal(groupFailure.sqsMessageHash, grouped.sqsMessageHash);
  assert.deepEqual([groupFailure.receiveCount, grouped.receiveCount], [1, 2]);
  assert.equal(h.groups.size, 1);
  assert.equal([...h.groups.values()][0]?.count, 2);
  assert.equal(
    h.calls.filter((operation) => operation === 'WEBHOOK').length,
    2
  );
  assert.equal(h.scheduled.length, 2); // The first event's failed attempt schedules before sending.
  assert.equal(h.metricCount(), 2);
});

test('heartbeat, no-repeat digest and completed receipt settle without contacting the webhook', async (t) => {
  const h = harness(t);
  const heartbeat: Work = {
    kind: 'heartbeat',
    lane: 'normal',
    emittedAt: now / 1000,
    eventId: 'heartbeat:normal:11111111-1111-4111-8111-111111111111'
  };
  const groupKey = 'group:prod:single:5964420';
  const digest: Work = {
    kind: 'digest',
    groupKey,
    eventId: `digest:${hash(groupKey)}`
  };
  h.groups.set(groupKey, {
    key: groupKey,
    count: 1,
    firstEventId: hash(alert.eventId),
    alert
  });
  const completed: Work = { kind: 'alert', alert };
  h.receipts.set(hash(alert.eventId), { outcome: '123' });
  assert.deepEqual(
    await h.run(
      row(heartbeat, 'private-sqs-heartbeat'),
      row(digest, 'private-sqs-digest'),
      row(completed, 'private-sqs-done')
    ),
    { batchItemFailures: [] }
  );
  assert.deepEqual(
    h.settled().map((entry) => entry.outcome),
    ['HEARTBEAT', 'NO_REPEAT', 'ALREADY_COMPLETE']
  );
  assert.deepEqual(
    h.settled().map((entry) => entry.kind),
    ['heartbeat', 'digest', 'alert']
  );
  assert.ok(
    h.settled().every((entry) => entry.deliveryAcceptance === 'NOT_ATTEMPTED')
  );
  assert.deepEqual(
    h.settled().map((entry) => entry.workHash),
    [hash(heartbeat.eventId), hash(digest.eventId), hash(alert.eventId)]
  );
  assert.equal(h.payloads.length, 0);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.calls.includes('RATE_SLOT'), false);
  assert.equal(h.metricCount(), 0);
});

test('confirmed delivery with failed receipt completion remains a failed batch item without settlement', async (t) => {
  const h = harness(t);
  h.fail('COMPLETE', sdkError('AccessDeniedException'));
  assert.deepEqual(await h.run(row({ kind: 'alert', alert })), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-message' }]
  });
  assert.equal(h.payloads.length, 1);
  assert.equal(h.settled().length, 0);
  assert.equal(h.receipts.get(hash(alert.eventId))?.outcome, undefined);
  assert.equal(h.receipts.get(hash(alert.eventId))?.busy, false);
  const failure = h.failures()[0];
  assert.ok(failure);
  assert.equal(failure.operation, 'COMPLETE');
  assert.equal(failure.cause, 'AWS_ACCESS_DENIED');
  assert.equal(failure.deliveryAcceptance, 'CONFIRMED');
  assert.equal(failure.cleanup, undefined);
  assert.equal(h.metricCount(), 1);
  assert.deepEqual(h.calls, [
    'RESERVE',
    'GROUP',
    'SCHEDULE',
    'RATE_SLOT',
    'SECRET',
    'WEBHOOK',
    'COMPLETE',
    'RELEASE'
  ]);
});

test('webhook failure and failed release retain both causes and the existing final thrown value', async (t) => {
  const h = harness(t);
  h.responses.push(
    new Response(JSON.stringify({ retry_after: 9, private: privateMarker }), {
      status: 429
    })
  );
  const cleanupError = sdkError('ProvisionedThroughputExceededException');
  h.fail('RELEASE', cleanupError);
  assert.deepEqual(await h.run(row({ kind: 'alert', alert })), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-message' }]
  });
  const failure = h.failures()[0];
  assert.ok(failure);
  assert.equal(failure.operation, 'WEBHOOK');
  assert.equal(failure.cause, 'HTTP_RATE_LIMIT');
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.retryAfterSeconds, 9);
  assert.equal(failure.deliveryAcceptance, 'UNKNOWN');
  assert.deepEqual(failure.cleanup, {
    operation: 'RELEASE',
    cause: 'DDB_THROTTLED',
    httpStatus: 400,
    sdkAttempts: 3
  });
  assert.equal(h.settled().length, 0);
  assert.equal(h.metricCount(), 1);
  assert.equal(h.receipts.get(hash(alert.eventId))?.busy, true);

  // processWork historically throws release's failure instead of the send failure.
  // Preserve that identity while recording both; do not introduce a new retry policy.
  const next: Work = {
    kind: 'alert',
    alert: { ...alert, eventId: 'private-event:identity', severity: 'critical' }
  };
  const originalError = new DeliveryError(true, 9, false, {
    cause: 'HTTP_RATE_LIMIT',
    httpStatus: 429
  });
  h.fail('RELEASE', cleanupError);
  await assert.rejects(
    () =>
      withDispatchDiagnostics(
        { lane: 'critical', messageId: 'private-sqs-identity' },
        async () => {
          bindDispatchWork(next.kind, hash(next.alert.eventId));
          try {
            await processWork(next, 'owner', h.memory, {
              edit: async () => {
                assert.fail('critical work must not edit');
              },
              schedule: async () => {
                assert.fail('critical work must not schedule');
              },
              archive: async () => {
                assert.fail('retryable work must not archive');
              },
              deliver: () =>
                traceDispatch('WEBHOOK', async () => {
                  throw originalError;
                })
            });
          } catch (error) {
            logDispatchFailure(error);
            throw error;
          }
        }
      ),
    (error: unknown) => error === cleanupError
  );
  assert.equal(h.failures()[1]?.cause, 'HTTP_RATE_LIMIT');
  assert.deepEqual(h.failures()[1]?.cleanup, failure.cleanup);
  assert.equal(h.visibility.length, 0); // The surfaced cleanup error has no retry-after.
});

test('busy leases and deferred slots stay quiet while genuine failures retain batch and visibility semantics', async (t) => {
  const h = harness(t);
  const busy: Work = {
    kind: 'alert',
    alert: { ...alert, eventId: 'private-event:busy' }
  };
  const slot: Work = {
    kind: 'alert',
    alert: { ...alert, eventId: 'private-event:slot', fingerprint: 'slot' }
  };
  const rateLimited: Work = {
    kind: 'alert',
    alert: {
      ...alert,
      eventId: 'private-event:limited',
      fingerprint: 'limited'
    }
  };
  const heartbeat: Work = {
    kind: 'heartbeat',
    lane: 'normal',
    emittedAt: now / 1000,
    eventId: 'heartbeat:normal:22222222-2222-4222-8222-222222222222'
  };
  h.receipts.set(hash(busy.alert.eventId), { busy: true });
  h.fail('RATE_SLOT', sdkError('ConditionalCheckFailedException'));
  h.fail('VISIBILITY', new Error(privateMarker));
  h.responses.push(
    new Response(JSON.stringify({ retry_after: 6.2, private: privateMarker }), {
      status: 429
    })
  );
  assert.deepEqual(
    await h.run(
      row(busy, 'private-sqs-busy'),
      row(slot, 'private-sqs-slot'),
      row(rateLimited, 'private-sqs-limited'),
      row(heartbeat, 'private-sqs-heartbeat')
    ),
    {
      batchItemFailures: [
        { itemIdentifier: 'private-sqs-busy' },
        { itemIdentifier: 'private-sqs-slot' },
        { itemIdentifier: 'private-sqs-limited' }
      ]
    }
  );
  assert.deepEqual(
    h.visibility.map((command) => command.VisibilityTimeout),
    [30, 3, 7]
  );
  assert.ok(
    h.visibility.every((command) => command.QueueUrl === 'normal-queue')
  );
  assert.equal(
    h.calls.filter((operation) => operation === 'RELEASE').length,
    2
  );
  assert.equal(
    h.calls.filter((operation) => operation === 'WEBHOOK').length,
    1
  );
  assert.equal(h.failures().length, 1);
  assert.equal(h.failures()[0]?.cause, 'HTTP_RATE_LIMIT');
  assert.equal(h.failures()[0]?.retryAfterSeconds, 7);
  assert.equal(h.failures()[0]?.workHash, hash(rateLimited.alert.eventId));
  assert.equal(h.metricCount(), 1);
  assert.deepEqual(
    h.settled().map((entry) => entry.outcome),
    ['HEARTBEAT']
  );
});

test('critical delivery bypasses grouping, scheduling and the normal rate slot', async (t) => {
  const h = harness(t, 'critical');
  const critical: Work = {
    kind: 'alert',
    alert: { ...alert, severity: 'critical', code: 'PLATFORM_ALARM' }
  };
  assert.deepEqual(await h.run(row(critical)), { batchItemFailures: [] });
  assert.deepEqual(h.calls, ['RESERVE', 'SECRET', 'WEBHOOK', 'COMPLETE']);
  assert.equal(h.settled()[0]?.outcome, 'DELIVERED');
  assert.equal(h.settled()[0]?.lane, 'critical');
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.groups.size, 0);
  assert.equal(h.metricCount(), 0);
});

test('permanent rejection and malformed work settle only after archive and fallback acceptance', async (t) => {
  const h = harness(t, 'critical');
  h.responses.push(new Response(privateMarker, { status: 404 }));
  const critical: Work = {
    kind: 'alert',
    alert: { ...alert, severity: 'critical', code: 'PLATFORM_ALARM' }
  };
  assert.deepEqual(
    await h.run(
      row(critical),
      row({ invalid: privateMarker }, 'private-sqs-invalid')
    ),
    { batchItemFailures: [] }
  );
  assert.deepEqual(h.calls, [
    'RESERVE',
    'SECRET',
    'WEBHOOK',
    'ARCHIVE',
    'FALLBACK',
    'COMPLETE',
    'ARCHIVE',
    'FALLBACK'
  ]);
  assert.equal(h.receipts.get(hash(alert.eventId))?.outcome, 'archived');
  assert.deepEqual(
    h.settled().map((entry) => entry.outcome),
    ['ARCHIVED', 'INVALID_ARCHIVED']
  );
  assert.equal(h.settled()[0]?.workHash, hash(alert.eventId));
  assert.equal(h.settled()[1]?.workHash, undefined);
  assert.equal(h.settled()[1]?.sqsMessageHash, hash('private-sqs-invalid'));
  assert.equal(h.archives.length, 2);
  assert.equal(JSON.stringify(h.archives[1]).includes(privateMarker), false);
  assert.equal(h.metricCount(), 0);
  assert.equal(h.failures().length, 0);
});

test('failed fallback preserves the original permanent failure and leaves the receipt unacknowledged', async (t) => {
  const h = harness(t, 'critical');
  h.responses.push(new Response(privateMarker, { status: 401 }));
  h.fail('FALLBACK', sdkError('AccessDeniedException'));
  const critical: Work = {
    kind: 'alert',
    alert: { ...alert, severity: 'critical', code: 'PLATFORM_ALARM' }
  };
  assert.deepEqual(await h.run(row(critical)), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-message' }]
  });
  assert.equal(h.archives.length, 1);
  assert.equal(h.calls.includes('COMPLETE'), false);
  assert.equal(h.calls.includes('RELEASE'), false);
  assert.equal(h.settled().length, 0);
  const failure = h.failures()[0];
  assert.ok(failure);
  assert.equal(failure.operation, 'WEBHOOK');
  assert.equal(failure.cause, 'HTTP_PERMANENT_STATUS');
  assert.equal(failure.httpStatus, 401);
  assert.deepEqual(failure.cleanup, {
    operation: 'FALLBACK',
    cause: 'AWS_ACCESS_DENIED',
    httpStatus: 400,
    sdkAttempts: 3
  });
  assert.equal(h.metricCount(), 1);
});

test('archive accepted but receipt completion failed retains the original webhook cause and cleanup stage', async (t) => {
  const h = harness(t, 'critical');
  h.responses.push(new Response(privateMarker, { status: 403 }));
  h.fail('COMPLETE', sdkError('AccessDeniedException'));
  const critical: Work = {
    kind: 'alert',
    alert: { ...alert, severity: 'critical', code: 'PLATFORM_ALARM' }
  };
  assert.deepEqual(await h.run(row(critical)), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-message' }]
  });
  assert.deepEqual(h.calls, [
    'RESERVE',
    'SECRET',
    'WEBHOOK',
    'ARCHIVE',
    'FALLBACK',
    'COMPLETE'
  ]);
  assert.equal(h.archives.length, 1);
  assert.equal(h.receipts.get(hash(alert.eventId))?.outcome, undefined);
  assert.equal(h.settled().length, 0);
  const failure = h.failures()[0];
  assert.ok(failure);
  assert.equal(failure.operation, 'WEBHOOK');
  assert.equal(failure.cause, 'HTTP_PERMANENT_STATUS');
  assert.equal(failure.httpStatus, 403);
  assert.deepEqual(failure.cleanup, {
    operation: 'COMPLETE',
    cause: 'AWS_ACCESS_DENIED',
    httpStatus: 400,
    sdkAttempts: 3
  });
  assert.equal(h.metricCount(), 1);
});

async function boundDigest(h: ReturnType<typeof harness>): Promise<Work> {
  await h.run(row({ kind: 'alert', alert }));
  await h.run(
    row(
      { kind: 'alert', alert: { ...alert, eventId: 'private-event:repeat' } },
      'private-sqs-repeat'
    )
  );
  assert.equal(h.scheduled.length, 1);
  return JSON.parse(h.scheduled[0]!.MessageBody!) as Work;
}

test('bound digest handler edits through the normal rate slot and records EDITED rather than a new post', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: []
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH']);
  assert.equal(h.calls.filter((value) => value === 'RATE_SLOT').length, 2);
  assert.equal(h.settled().at(-1)?.outcome, 'EDITED');
  assert.equal(h.settled().at(-1)?.deliveryAcceptance, 'CONFIRMED');
  assert.equal(h.metricCount(), 0);
  assert.equal(h.archives.length, 0);
});

test('edit429 remains a failed item with vendor delay and retries PATCH only', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  h.responses.push(
    Response.json({ retry_after: 4.2, message: privateMarker }, { status: 429 })
  );
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-digest' }]
  });
  assert.equal(h.visibility.at(-1)?.VisibilityTimeout, 5);
  assert.equal(h.failures().at(-1)?.operation, 'WEBHOOK_EDIT');
  assert.equal(h.failures().at(-1)?.cause, 'HTTP_RATE_LIMIT');
  assert.equal(h.failures().at(-1)?.deliveryAcceptance, 'UNKNOWN');
  assert.equal(h.metricCount(), 1);
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest', 2)), {
    batchItemFailures: []
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH', 'PATCH']);
});

test('secret-version rotation cannot edit or repost an old bound target and signals fallback', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  h.rotateCredential();
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: []
  });
  assert.deepEqual(h.methods, ['POST']);
  assert.equal(h.archives.length, 1);
  assert.ok(h.calls.includes('FALLBACK'));
  assert.equal(h.settled().at(-1)?.outcome, 'ARCHIVED');
  assert.equal(h.settled().at(-1)?.deliveryAcceptance, 'NOT_ATTEMPTED');
});

test('bound missing-message response selects rate-limited summary POST while revoked webhook cannot', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  h.responses.push(
    Response.json({ code: 10008, message: privateMarker }, { status: 404 })
  );
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: []
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH', 'POST']);
  assert.equal(h.calls.filter((value) => value === 'RATE_SLOT').length, 3);
  assert.equal(h.archives.length, 0);
  assert.equal(h.settled().at(-1)?.outcome, 'DELIVERED');
});

test('revoked edit destination retains archive/fallback failure and does not acknowledge or POST', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  h.responses.push(
    Response.json({ code: 10015, message: privateMarker }, { status: 404 })
  );
  h.fail('FALLBACK', sdkError('AccessDeniedException'));
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-digest' }]
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH']);
  assert.equal(h.failures().at(-1)?.operation, 'WEBHOOK_EDIT');
  assert.equal(h.failures().at(-1)?.cause, 'HTTP_PERMANENT_STATUS');
  assert.equal(
    (h.failures().at(-1)?.cleanup as LogEntry).operation,
    'FALLBACK'
  );
  assert.equal(
    h.receipts.get(
      hash(digest.kind === 'alert' ? digest.alert.eventId : digest.eventId)
    )?.outcome,
    undefined
  );
});

test('replacement POST remains destination-bound after missing-target deferral and credential rotation', async (t) => {
  const h = harness(t, 'normal', true);
  const digest = await boundDigest(h);
  h.responses.push(Response.json({ code: 10008 }, { status: 404 }));
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    'fetch',
    async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      if (args[1]?.method === 'PATCH')
        h.fail('RATE_SLOT', new DeliveryError(true, 3, true));
      return response;
    }
  );
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest')), {
    batchItemFailures: [{ itemIdentifier: 'private-sqs-digest' }]
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH']);
  h.rotateCredential();
  assert.deepEqual(await h.run(row(digest, 'private-sqs-digest', 2)), {
    batchItemFailures: []
  });
  assert.deepEqual(h.methods, ['POST', 'PATCH']);
  assert.equal(h.archives.length, 1);
  assert.ok(h.calls.includes('FALLBACK'));
  assert.equal(h.settled().at(-1)?.outcome, 'ARCHIVED');
});
