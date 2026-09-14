import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { secret, webhookDestination } from './aws.js';

test('webhook bindings reuse secret metadata and change across scope, version and webhook identity', async (t) => {
  const oldEnvironment = process.env;
  process.env = {
    ...oldEnvironment,
    ENVIRONMENT: 'prod',
    WEBHOOK_SECRET_ARN: 'fixture:version-binding'
  };
  t.after(() => {
    process.env = oldEnvironment;
  });
  let now = 0;
  let requests = 0;
  let version: string | undefined = 'fixture-version-1';
  let value = 'https://discord.com/api/webhooks/123/PRIVATE_TOKEN';
  t.mock.method(Date, 'now', () => now);
  t.mock.method(SecretsManagerClient.prototype, 'send', async () => {
    requests++;
    return { SecretString: value, VersionId: version };
  });
  assert.equal(await secret('fixture:version-binding'), value);
  const first = await webhookDestination();
  assert.equal(requests, 1);
  assert.match(first.key ?? '', /^[a-f0-9]{64}$/);
  assert.equal(first.key?.includes('PRIVATE_TOKEN'), false);
  assert.equal((await webhookDestination()).key, first.key);
  version = 'fixture-version-2';
  assert.equal(
    (await webhookDestination()).key,
    first.key,
    'warm cache binds the credential actually used'
  );
  now += 60001;
  const rotated = await webhookDestination();
  assert.notEqual(rotated.key, first.key);
  value = 'https://discord.com/api/webhooks/456/PRIVATE_TOKEN';
  now += 60001;
  const replacement = await webhookDestination();
  assert.notEqual(replacement.key, rotated.key);
  process.env.ENVIRONMENT = 'staging';
  assert.notEqual((await webhookDestination()).key, replacement.key);
  now += 60001;
  version = undefined;
  const unbound = await webhookDestination();
  assert.equal(unbound.key, undefined);
  assert.equal(
    unbound.value,
    value,
    'missing version metadata preserves initial delivery compatibility'
  );
});
