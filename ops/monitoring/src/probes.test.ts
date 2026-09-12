import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkProbe, measureProbe, parseProbeTargets } from './probes.js';

const target = {
  name: 'api',
  url: 'https://api.example.com/health',
  jsonEquals: { db: 'ok', 'redis.healthy': true }
};

test('health assertions detect degraded DB or Redis despite HTTP 200', async () => {
  const responses = [
    { db: 'ok', redis: { healthy: true } },
    { db: 'degraded', redis: { healthy: true } },
    { db: 'ok', redis: { healthy: false } },
    { db: 'ok' },
    { db: 'ok', redis: { healthy: 'true' } }
  ];
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      return Response.json(responses.shift());
    }
  );
  try {
    assert.equal(await checkProbe(target), true);
    for (let i = 0; i < 4; i++) assert.equal(await checkProbe(target), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test('malformed and oversize health bodies fail without exposing response contents', async () => {
  const bodies = [
    new Response('private malformed response'),
    new Response('x'.repeat(65537)),
    new Response('{}', { headers: { 'content-length': '65537' } })
  ];
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => bodies.shift()!
  );
  try {
    for (let i = 0; i < 3; i++) assert.equal(await checkProbe(target), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test('status-only probes discard bodies and preserve strict expected status and transport failure', async () => {
  const statuses = [200, 307, 503];
  let cancellations = 0;
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
          }
        }),
        { status: statuses.shift() }
      )
  );
  try {
    const statusOnly = { name: target.name, url: target.url };
    assert.equal(await checkProbe(statusOnly), true);
    assert.equal(await checkProbe(statusOnly), false);
    assert.equal(await checkProbe(statusOnly), false);
    assert.equal(cancellations, 3);
    fetchMock.mock.mockImplementation(async () => {
      throw new Error('private endpoint failure');
    });
    assert.equal(await checkProbe(target), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test('probe configuration bounds targets, property paths, and scalar assertions', () => {
  assert.deepEqual(
    parseProbeTargets(JSON.stringify([target]))[0]?.jsonEquals,
    target.jsonEquals
  );
  for (const value of [
    '{private invalid JSON',
    JSON.stringify(Array.from({ length: 11 }, () => target)),
    JSON.stringify([target, target]),
    JSON.stringify([{ ...target, status: 0 }]),
    JSON.stringify([{ ...target, jsonEquals: { 'redis.constructor': true } }]),
    JSON.stringify([{ ...target, jsonEquals: { redis: { healthy: true } } }]),
    JSON.stringify([{ ...target, jsonEquals: {} }])
  ])
    assert.throws(() => parseProbeTargets(value), /INVALID_PROBE/);
});

test('probe observations time health evaluation and bound both successful and failed durations', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json({ db: 'ok', redis: { healthy: true } })
  );
  const clock = (end: number) => {
    const times = [100, end];
    return () => times.shift()!;
  };
  try {
    assert.deepEqual(await measureProbe(target, clock(125.5)), {
      healthy: true,
      durationMs: 25.5
    });
    fetchMock.mock.mockImplementation(async () => {
      throw new Error('private transport failure');
    });
    assert.deepEqual(await measureProbe(target, clock(5100)), {
      healthy: false,
      durationMs: 5000
    });
    for (const [end, durationMs] of [
      [90, 0],
      [Infinity, 60_000],
      [99_999, 60_000]
    ] as const) {
      assert.deepEqual(await measureProbe(target, clock(end)), {
        healthy: false,
        durationMs
      });
    }
  } finally {
    fetchMock.mock.restore();
  }
});
