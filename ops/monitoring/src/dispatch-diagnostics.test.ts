import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  bindDispatchWork,
  completeDispatch,
  logDispatchFailure,
  traceDispatch,
  webhookAccepted,
  webhookAttempted,
  withDispatchDiagnostics
} from './dispatch-diagnostics.js';
import { DeliveryError } from './webhook.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const input = { lane: 'normal', messageId: 'sqs-message', receiveCount: '2' };
type Entry = Record<string, unknown>;
async function capture(run: () => Promise<void>): Promise<Entry[]> {
  const lines: string[] = [];
  const log = mock.method(console, 'log', (line: string) => {
    lines.push(line);
  });
  const error = mock.method(console, 'error', (line: string) => {
    lines.push(line);
  });
  try {
    await run();
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  return lines.map((line) => JSON.parse(line) as Entry);
}
async function failed(
  stage: Parameters<typeof traceDispatch>[0],
  error: unknown
): Promise<void> {
  await assert.rejects(
    traceDispatch(stage, async () => {
      throw error;
    }),
    (caught) => caught === error
  );
}

test('failure and every terminal outcome retain hashed work and message identities', async () => {
  const workHash = digest('canonical-event');
  const error = new Error('private diagnostic');
  const entries = await capture(async () => {
    await withDispatchDiagnostics(input, async () => {
      bindDispatchWork('alert', workHash);
      await failed('GROUP', error);
      logDispatchFailure(error);
    });
    for (const outcome of [
      'DELIVERED',
      'EDITED',
      'GROUPED',
      'HEARTBEAT',
      'NO_REPEAT',
      'ARCHIVED',
      'ALREADY_COMPLETE'
    ] as const) {
      await withDispatchDiagnostics(
        { ...input, receiveCount: '3' },
        async () => {
          bindDispatchWork('alert', workHash);
          completeDispatch(outcome);
        }
      );
    }
  });
  assert.equal(entries.length, 8);
  for (const entry of entries) {
    assert.equal(entry.workHash, workHash);
    assert.equal(entry.sqsMessageHash, digest(input.messageId));
    assert.equal(entry.schemaVersion, 1);
    assert.equal(entry.kind, 'alert');
    assert.equal(typeof entry.elapsedMs, 'number');
  }
  assert.equal(entries[0]?.operation, 'GROUP');
  assert.equal(entries[0]?.receiveCount, 2);
  for (const entry of entries.slice(1)) {
    assert.equal(entry.code, 'DELIVERY_SETTLED');
    assert.equal(entry.receiveCount, 3);
    assert.equal(entry.operation, undefined);
  }
});

test('concurrent SQS records keep independent operation, identities and acceptance', async () => {
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const entries = await capture(async () => {
    const first = withDispatchDiagnostics(input, async () => {
      bindDispatchWork('alert', digest('first'));
      await traceDispatch('WEBHOOK', async () => {
        webhookAttempted();
        entered();
        await gate;
        webhookAccepted();
      });
      const error = new Error('private commit failure');
      await failed('COMPLETE', error);
      logDispatchFailure(error);
    });
    await started;
    await withDispatchDiagnostics(
      { lane: 'critical', messageId: 'second', receiveCount: '1' },
      async () => {
        bindDispatchWork('heartbeat', digest('second'));
        completeDispatch('HEARTBEAT');
      }
    );
    resume();
    await first;
  });
  assert.equal(entries[0]?.lane, 'critical');
  assert.equal(entries[0]?.workHash, digest('second'));
  assert.equal(entries[0]?.deliveryAcceptance, 'NOT_ATTEMPTED');
  assert.equal(entries[1]?.lane, 'normal');
  assert.equal(entries[1]?.workHash, digest('first'));
  assert.equal(entries[1]?.deliveryAcceptance, 'CONFIRMED');
  assert.equal(entries[1]?.operation, 'COMPLETE');
});

test('nested traces retain the most specific error and separate release failure', async () => {
  const original = Object.assign(new Error('private group details'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }]
  });
  const cleanup = Object.assign(new Error('private release details'), {
    name: 'AccessDeniedException'
  });
  const entries = await capture(async () =>
    withDispatchDiagnostics(input, async () => {
      await assert.rejects(
        traceDispatch('GROUP', () =>
          traceDispatch('SCHEDULE', async () => {
            throw original;
          })
        ),
        (error) => error === original
      );
      await failed('RELEASE', cleanup);
      logDispatchFailure(cleanup);
    })
  );
  assert.equal(entries[0]?.operation, 'SCHEDULE');
  assert.equal(entries[0]?.cause, 'DDB_TRANSACTION_CONFLICT');
  assert.deepEqual(entries[0]?.cleanup, {
    operation: 'RELEASE',
    cause: 'AWS_ACCESS_DENIED'
  });
});

test('a handled inner condition does not poison a later failure or terminal log', async () => {
  const condition = Object.assign(new Error('already reserved'), {
    name: 'ConditionalCheckFailedException'
  });
  const later = new Error('unrelated failure');
  const entries = await capture(async () =>
    withDispatchDiagnostics(input, async () => {
      await traceDispatch('RESERVE', async () => {
        try {
          await traceDispatch('RESERVE', async () => {
            throw condition;
          });
        } catch {
          return 'done';
        }
      });
      completeDispatch('ALREADY_COMPLETE');
      await failed('SECRET', later);
      logDispatchFailure(later);
    })
  );
  assert.equal(entries[0]?.operation, undefined);
  assert.equal(entries[0]?.cause, undefined);
  assert.equal(entries[1]?.operation, 'SECRET');
  assert.equal(entries[1]?.cause, 'UNKNOWN');
});

test('cleanup success preserves the primary failure and unrelated caught errors are not reused', async () => {
  const original = new Error('first');
  const unrelated = new Error('second');
  const entries = await capture(async () =>
    withDispatchDiagnostics(input, async () => {
      await failed('GROUP', original);
      await traceDispatch('RELEASE', async () => undefined);
      logDispatchFailure(original);
      logDispatchFailure(unrelated);
    })
  );
  assert.equal(entries[0]?.operation, 'GROUP');
  assert.equal(entries[1]?.operation, 'UNKNOWN');
});

test('diagnostics allow only fixed causes, numeric metadata and two cancellation codes', async () => {
  const secret = 'private-webhook-secret-'.repeat(1000);
  const error = Object.assign(new Error(secret), {
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'TransactionConflict', Message: secret, Item: { token: secret } },
      { Code: secret, Message: secret },
      { Code: 'ThrottlingError', Message: secret }
    ],
    $metadata: { attempts: 2000, httpStatusCode: 400, requestId: secret },
    retryAfterSeconds: 100000,
    details: { cause: secret, httpStatus: 9999, content: secret }
  });
  const entries = await capture(async () =>
    withDispatchDiagnostics(
      { ...input, lane: secret, receiveCount: '999999999' },
      async () => {
        bindDispatchWork('alert', secret);
        await failed('GROUP', error);
        logDispatchFailure(error);
      }
    )
  );
  const entry = entries[0];
  assert.equal(entry?.lane, 'UNKNOWN');
  assert.equal(entry?.receiveCount, 1000000);
  assert.equal(entry?.workHash, undefined);
  assert.equal(entry?.cause, 'AWS_OTHER');
  assert.equal(entry?.httpStatus, 400);
  assert.equal(entry?.sdkAttempts, 100);
  assert.equal(entry?.retryAfterSeconds, 43200);
  assert.deepEqual(entry?.cancellationCodes, [
    'TransactionConflict',
    'UNKNOWN'
  ]);
  assert.ok(!JSON.stringify(entries).includes('private-webhook-secret'));
  assert.ok(JSON.stringify(entries).length < 1000);
});

test('malicious getters, revoked proxies and unknown thrown values remain opaque', async () => {
  let getterCalls = 0;
  const value = Object.create(null) as Record<string, unknown>;
  for (const name of [
    'name',
    'message',
    'stack',
    'details',
    '$metadata',
    'CancellationReasons',
    'retryAfterSeconds'
  ]) {
    Object.defineProperty(value, name, {
      get() {
        getterCalls++;
        throw new Error('secret getter');
      }
    });
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const entries = await capture(async () => {
    for (const error of [
      value,
      revoked.proxy,
      null,
      undefined,
      'secret-value',
      42
    ]) {
      await withDispatchDiagnostics(input, async () => {
        try {
          await traceDispatch('SECRET', async () => {
            throw error;
          });
        } catch (caught) {
          assert.equal(caught, error);
        }
        logDispatchFailure(error);
      });
    }
  });
  assert.equal(getterCalls, 0);
  assert.equal(entries.length, 6);
  for (const entry of entries) {
    assert.equal(entry.cause, 'UNKNOWN');
    assert.equal(entry.operation, 'SECRET');
  }
  assert.ok(!JSON.stringify(entries).includes('secret-value'));
});

test('failure logs distinguish unattempted, ambiguous and accepted sends', async () => {
  const entries = await capture(async () => {
    for (const phase of ['none', 'attempt', 'accepted']) {
      await withDispatchDiagnostics(input, async () => {
        const error = new DeliveryError(true, 2, false, {
          cause: 'HTTP_RATE_LIMIT',
          httpStatus: 429
        });
        if (phase !== 'none') webhookAttempted();
        if (phase === 'accepted') webhookAccepted();
        await failed(phase === 'accepted' ? 'COMPLETE' : 'WEBHOOK', error);
        logDispatchFailure(error);
      });
    }
  });
  assert.deepEqual(
    entries.map((entry) => entry.deliveryAcceptance),
    ['NOT_ATTEMPTED', 'UNKNOWN', 'CONFIRMED']
  );
  for (const entry of entries) {
    assert.equal(entry.cause, 'HTTP_RATE_LIMIT');
    assert.equal(entry.httpStatus, 429);
    assert.equal(entry.retryAfterSeconds, 2);
  }
});

test('invalid archived work has no fabricated canonical identity', async () => {
  const entries = await capture(async () =>
    withDispatchDiagnostics(input, async () =>
      completeDispatch('INVALID_ARCHIVED')
    )
  );
  assert.equal(entries[0]?.outcome, 'INVALID_ARCHIVED');
  assert.equal(entries[0]?.workHash, undefined);
  assert.equal(entries[0]?.kind, undefined);
});

test('generic AWS throttles are not attributed to DynamoDB and malformed cancellation arrays stay unknown', async () => {
  const entries = await capture(async () => {
    for (const [stage, name, reasons] of [
      ['SECRET', 'ThrottlingException', undefined],
      ['SCHEDULE', 'RequestLimitExceeded', undefined],
      ['GROUP', 'ProvisionedThroughputExceededException', undefined],
      [
        'GROUP',
        'TransactionCanceledException',
        [{ Code: 'None' }, { Code: 'TransactionConflict' }, { Code: 'None' }]
      ],
      [
        'GROUP',
        'TransactionCanceledException',
        [{ Code: 'None' }, { Code: 'TransactionConflict' }]
      ]
    ] as const) {
      await withDispatchDiagnostics(input, async () => {
        const error = Object.assign(new Error('private SDK message'), {
          name,
          CancellationReasons: reasons
        });
        await failed(stage, error);
        logDispatchFailure(error);
      });
    }
  });
  assert.deepEqual(
    entries.map((entry) => entry.cause),
    [
      'AWS_THROTTLED',
      'AWS_THROTTLED',
      'DDB_THROTTLED',
      'AWS_OTHER',
      'DDB_TRANSACTION_CONFLICT'
    ]
  );
  assert.deepEqual(entries[3]?.cancellationCodes, [
    'None',
    'TransactionConflict'
  ]);
});

test('terminal diagnostics outside a record context do not emit unrelated logs', async () => {
  const entries = await capture(async () => completeDispatch('GROUPED'));
  assert.deepEqual(entries, []);
});

test('diagnostic log failures do not replace business results or exact exceptions', async () => {
  const original = new Error('original');
  const log = mock.method(console, 'log', () => {
    throw new Error('log unavailable');
  });
  const errorLog = mock.method(console, 'error', () => {
    throw new Error('log unavailable');
  });
  try {
    const result = await withDispatchDiagnostics(input, async () => {
      await failed('GROUP', original);
      logDispatchFailure(original);
      completeDispatch('GROUPED');
      return 7;
    });
    assert.equal(result, 7);
    await failed('GROUP', original);
  } finally {
    log.mock.restore();
    errorLog.mock.restore();
  }
});
