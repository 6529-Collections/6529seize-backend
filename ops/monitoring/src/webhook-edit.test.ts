import test from 'node:test';
import assert from 'node:assert/strict';
import { edit, DeliveryError } from './webhook.js';
import { EVENT_TYPE, renderAlert, type Alert } from './contract.js';

const secret = 'https://discord.com/api/webhooks/123/test-token';
const messageId = '987654321012345678';
const alert: Alert = {
  _type: EVENT_TYPE,
  eventId: 'synthetic-first',
  environment: 'prod',
  occurredAt: '2026-09-14T06:00:00Z',
  service: 'fixture',
  severity: 'error',
  code: 'APPLICATION_ERROR',
  fingerprint: 'fixture'
};

test('count edit preserves the representative alert and confirms the exact message', async () => {
  const first = renderAlert(alert);
  const updated = renderAlert(alert, 3);
  assert.equal(
    JSON.stringify(updated),
    JSON.stringify(first).replace('"value":"1"', '"value":"3"')
  );
  const confirmed = await edit(
    secret,
    messageId,
    updated,
    async (url, init) => {
      assert.equal(String(url), `${secret}/messages/${messageId}`);
      assert.equal(init?.method, 'PATCH');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init?.body, JSON.stringify(updated));
      assert.deepEqual(JSON.parse(String(init?.body)).allowed_mentions, {
        parse: []
      });
      return Response.json({ id: messageId });
    }
  );
  assert.equal(confirmed, messageId);
});

test('only exact404 and numeric unknown-message code permit replacement', async () => {
  assert.equal(
    await edit(secret, messageId, {}, async () =>
      Response.json({ code: 10008, message: 'unretained' }, { status: 404 })
    ),
    null
  );
  for (const [status, body] of [
    [404, { code: 10015 }],
    [404, { code: '10008' }],
    [404, {}],
    [403, { code: 10008 }],
    [401, { code: 10008 }],
    [400, { code: 10008 }]
  ] as const) {
    await assert.rejects(
      edit(secret, messageId, {}, async () => Response.json(body, { status })),
      (error) =>
        error instanceof DeliveryError &&
        !error.retryable &&
        error.details?.httpStatus === status
    );
  }
  await assert.rejects(
    edit(
      secret,
      messageId,
      {},
      async () => new Response('not-json', { status: 404 })
    ),
    (error) => error instanceof DeliveryError && !error.retryable
  );
});

test('edit transient failures retain retry policy and never report missing target', async () => {
  for (const status of [408, 500, 502, 503]) {
    await assert.rejects(
      edit(secret, messageId, {}, async () => new Response(null, { status })),
      (error) =>
        error instanceof DeliveryError &&
        error.retryable &&
        error.details?.httpStatus === status
    );
  }
  await assert.rejects(
    edit(secret, messageId, {}, async () =>
      Response.json({ retry_after: 2.1 }, { status: 429 })
    ),
    (error) =>
      error instanceof DeliveryError &&
      error.retryable &&
      error.retryAfterSeconds === 3
  );
  for (const error of [
    new Error(secret),
    new DOMException(secret, 'TimeoutError')
  ]) {
    await assert.rejects(
      edit(secret, messageId, {}, async () => {
        throw error;
      }),
      (caught) =>
        caught instanceof DeliveryError &&
        caught.retryable &&
        !JSON.stringify(caught).includes(secret)
    );
  }
});

test('empty or mismatched edit acknowledgement is retryable', async () => {
  for (const response of [
    new Response(null, { status: 204 }),
    Response.json({ id: '123' }),
    Response.json({ id: Number(messageId) }),
    Response.json({}),
    new Response('invalid')
  ]) {
    await assert.rejects(
      edit(secret, messageId, {}, async () => response),
      (error) =>
        error instanceof DeliveryError &&
        error.retryable &&
        error.details?.cause === 'INVALID_DELIVERY_RESPONSE'
    );
  }
});

test('null rate-limit JSON retains the default delay instead of an unclassified exception', async () => {
  await assert.rejects(
    edit(secret, messageId, {}, async () =>
      Response.json(null, { status: 429 })
    ),
    (error) =>
      error instanceof DeliveryError &&
      error.retryable &&
      error.retryAfterSeconds === 60 &&
      error.details?.cause === 'HTTP_RATE_LIMIT'
  );
});

test('untrusted targets and destinations cannot produce an edit request', async () => {
  let requests = 0;
  const send = async () => {
    requests++;
    return Response.json({ id: messageId });
  };
  for (const target of ['', '../123', '123?wait=false', '1'.repeat(21)]) {
    await assert.rejects(
      edit(secret, target, {}, send),
      (error) => error instanceof DeliveryError && !error.retryable
    );
  }
  for (const url of [
    'http://discord.com/api/webhooks/123/token',
    'https://evil.test/api/webhooks/123/token'
  ]) {
    await assert.rejects(
      edit(url, messageId, {}, send),
      (error) => error instanceof DeliveryError && !error.retryable
    );
  }
  assert.equal(requests, 0);
});
