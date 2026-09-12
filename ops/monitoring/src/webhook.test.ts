import test from 'node:test';
import assert from 'node:assert/strict';
import { deliver, DeliveryError, webhookUrl } from './webhook.js';
const secret = 'https://discord.com/api/webhooks/123/test-token';
test('confirmed webhook delivery requires wait=true and a message id', async () => {
  let request: RequestInit | undefined;
  const result = await deliver(
    secret,
    { allowed_mentions: { parse: [] } },
    async (url, init) => {
      assert.equal(String(url), `${secret}?wait=true`);
      request = init;
      return Response.json({ id: '987' });
    }
  );
  assert.equal(result, '987');
  assert.equal(request?.redirect, 'error');
  await assert.rejects(
    () => deliver(secret, {}, async () => new Response(null, { status: 204 })),
    (error) => error instanceof DeliveryError && error.retryable
  );
});
test('rate limits and transient failures retain the message for retry', async () => {
  await assert.rejects(
    () =>
      deliver(secret, {}, async () =>
        Response.json({ retry_after: 2.1 }, { status: 429 })
      ),
    (error) => error instanceof DeliveryError && error.retryAfterSeconds === 3
  );
  for (const status of [408, 500, 502, 503]) {
    await assert.rejects(
      () => deliver(secret, {}, async () => new Response(null, { status })),
      (error) => error instanceof DeliveryError && error.retryable
    );
  }
  await assert.rejects(
    () =>
      deliver(secret, {}, async () => {
        throw new Error(secret);
      }),
    (error) => error instanceof DeliveryError && !error.message.includes(secret)
  );
});
test('revoked credentials and invalid destinations become safe permanent failures', async () => {
  await assert.rejects(
    () => deliver(secret, {}, async () => new Response(null, { status: 404 })),
    (error) => error instanceof DeliveryError && !error.retryable
  );
  for (const url of [
    'private-secret',
    'http://discord.com/api/webhooks/123/token',
    'https://evil.example/api/webhooks/123/token',
    'https://discord.com.evil.example/api/webhooks/123/token',
    'https://user:pass@discord.com/api/webhooks/123/token'
  ]) {
    assert.throws(
      () => webhookUrl(url),
      (error) => error instanceof DeliveryError && !error.message.includes(url)
    );
  }
});

test('rate limits default to sixty seconds only when vendor retry hints are missing or invalid', async () => {
  for (const [body, headers, expected] of [
    [{}, {}, 60],
    [{}, { 'retry-after': '4.2' }, 5],
    [{ retry_after: 2.1 }, { 'retry-after': '10' }, 3],
    [{ retry_after: 0 }, {}, 1],
    [{ retry_after: 999999 }, {}, 43200],
    [{}, { 'retry-after': 'invalid' }, 60]
  ] as const) {
    await assert.rejects(
      () =>
        deliver(secret, {}, async () =>
          Response.json(body, { status: 429, headers })
        ),
      (error) =>
        error instanceof DeliveryError &&
        error.retryable &&
        error.retryAfterSeconds === expected
    );
  }
});
