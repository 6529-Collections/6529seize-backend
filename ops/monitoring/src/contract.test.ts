import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPE, parseAlert, renderAlert } from './contract.js';

export const fixture = {
  _type: EVENT_TYPE,
  eventId: 'event-123',
  occurredAt: '2026-09-12T00:00:00Z',
  environment: 'prod' as const,
  service: 'seizeAPI',
  severity: 'error' as const,
  code: 'APPLICATION_ERROR' as const,
  fingerprint: 'fingerprint-123'
};
test('the contract reconstructs only bounded metadata and suppresses Discord mentions', () => {
  const alert = parseAlert({
    ...fixture,
    message: 'private body @everyone',
    user: { address: 'private' },
    sourceLink: 'https://evil.example/secret',
    release: '@everyone'
  });
  assert.equal(JSON.stringify(alert).includes('private'), false);
  assert.equal('sourceLink' in alert, false);
  assert.equal(alert.release, undefined);
  assert.deepEqual(
    (renderAlert(alert) as { allowed_mentions: unknown }).allowed_mentions,
    { parse: [] }
  );
});
test('invalid identities, dates, unknown codes and oversized events are rejected', () => {
  for (const change of [
    { service: '@everyone' },
    { occurredAt: 'not a date' },
    { code: 'MODEL_REJECTED' },
    { raw: 'x'.repeat(9000) }
  ]) {
    assert.throws(() => parseAlert({ ...fixture, ...change }), /INVALID_ALERT/);
  }
});

test('push conditions are finite safe labels; arbitrary condition text is discarded', () => {
  const known = parseAlert({ ...fixture, condition: 'PUSH_SENDER_MISMATCH' });
  assert.equal(known.condition, 'PUSH_SENDER_MISMATCH');
  assert.match(JSON.stringify(renderAlert(known)), /PUSH_SENDER_MISMATCH/);
  const unknown = parseAlert({
    ...fixture,
    condition: 'PRIVATE_TOKEN @everyone'
  });
  assert.equal(unknown.condition, undefined);
  assert.doesNotMatch(JSON.stringify(renderAlert(unknown)), /PRIVATE_TOKEN/);
});
