import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sentryAlert, verifySignature } from './sentry.js';
test('Sentry signatures authenticate the exact raw payload bytes', () => {
  const raw = Buffer.from('{"action":"triggered"}');
  const signature = createHmac('sha256', 'test-secret')
    .update(raw)
    .digest('hex');
  assert.equal(verifySignature(raw, signature, 'test-secret'), true);
  assert.equal(
    verifySignature(
      Buffer.concat([raw, Buffer.from(' ')]),
      signature,
      'test-secret'
    ),
    false
  );
  assert.equal(verifySignature(raw, 'bad', 'test-secret'), false);
});
test('production environments and numeric project IDs normalize without forwarding user content', () => {
  const payload = {
    action: 'triggered',
    data: {
      event: {
        event_id: 'event123',
        project: 123456,
        tags: [['environment', 'production']],
        issue_id: 'issue123',
        message: 'private biography',
        user: { email: 'private' }
      }
    }
  };
  const alert = sentryAlert(payload, 'prod', ['123456']);
  assert.equal(alert?.environment, 'prod');
  assert.equal(alert?.service, 'sentry.123456');
  assert.equal(JSON.stringify(alert).includes('private'), false);
  assert.equal(sentryAlert(payload, 'staging', ['123456']), null);
  assert.throws(
    () => sentryAlert(payload, 'prod', ['another-project']),
    /INVALID_SENTRY_EVENT/
  );
});
test('error-created integrations support direct event environment while other actions are ignored', () => {
  const payload = {
    action: 'created',
    data: {
      error: { event_id: 'abc', project: 'frontend', environment: 'staging' }
    }
  };
  assert.equal(
    sentryAlert(payload, 'staging', ['frontend'])?.code,
    'SENTRY_ERROR'
  );
  assert.equal(
    sentryAlert({ ...payload, action: 'resolved' }, 'staging', ['frontend']),
    null
  );
});
