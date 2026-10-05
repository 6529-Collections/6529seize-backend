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
const embed = (alert: Parameters<typeof renderAlert>[0]) =>
  (renderAlert(alert) as { embeds: Array<{ title: string; color: number }> })
    .embeds[0]!;
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
test('validated diagnostics render amber only for explicit remaining retries', () => {
  const alert = parseAlert({
    ...fixture,
    diagnostic: {
      category: 'HTTP_ERROR',
      operation: 'NFT_REFRESH',
      provider: 'TRANSIENT',
      httpStatus: 404,
      resource: 'ethereum:0xb8d23ee4e252bda66ed8a93db294ed52c23e80c8:6',
      recovery: {
        state: 'pending',
        attempt: 1,
        maxAttempts: 5,
        nextAttemptAt: '2026-09-29T15:00:00Z'
      },
      message: 'Authorization Bearer secret',
      body: 'private'
    }
  });
  const rendered = JSON.stringify(renderAlert(alert));
  assert.equal(embed(alert).title, 'prod · seizeAPI · APPLICATION_ERROR');
  assert.equal(embed(alert).color, 0xf59e0b);
  assert.match(rendered, /TRANSIENT returned HTTP 404/);
  assert.match(rendered, /1 of 5/);
  assert.match(rendered, /Pending at/);
  assert.doesNotMatch(rendered, /secret|private|Authorization/);
  const exhausted = {
    ...alert,
    diagnostic: {
      ...alert.diagnostic!,
      recovery: { state: 'exhausted', attempt: 5, maxAttempts: 5 }
    }
  } as typeof alert;
  assert.equal(embed(exhausted).color, 0xef4444);
  assert.match(JSON.stringify(renderAlert(exhausted)), /Retries are exhausted/);
});
test('invalid pending state and unsafe resource never reach an amber alert', () => {
  const alert = parseAlert({
    ...fixture,
    diagnostic: {
      category: 'ACCESS_DENIED',
      operation: 'SEND',
      resource: 'https://signed.example/?Authorization=secret',
      recovery: { state: 'pending', attempt: 3, maxAttempts: 3 }
    }
  });
  const rendered = JSON.stringify(renderAlert(alert));
  assert.equal(embed(alert).color, 0xef4444);
  assert.match(rendered, /provider denied access/);
  assert.doesNotMatch(rendered, /signed.example|secret/);
});
test('completed SDK attempts remain red without a separate delivery retry', () => {
  const alert = parseAlert({
    ...fixture,
    diagnostic: {
      category: 'THROTTLED',
      operation: 'WS_OUTBOUND_SEND',
      httpStatus: 429,
      sdkAttempts: 3
    }
  });
  const rendered = JSON.stringify(renderAlert(alert));
  assert.equal(embed(alert).color, 0xef4444);
  assert.match(rendered, /SDK attempts completed/);
  assert.match(rendered, /Recovery status is unknown/);
});
test('demand-driven retry eligibility is red and never promises scheduling', () => {
  const alert = parseAlert({
    ...fixture,
    diagnostic: {
      category: 'HTTP_ERROR',
      operation: 'NFT_REFRESH',
      provider: 'TRANSIENT',
      httpStatus: 404,
      resource: 'ethereum:0xb8d23ee4e252bda66ed8a93db294ed52c23e80c8:6',
      recovery: {
        state: 'unknown',
        attempt: 1,
        nextEligibleAt: '2026-09-29T15:05:00Z'
      }
    }
  });
  const rendered = JSON.stringify(renderAlert(alert));
  assert.equal(embed(alert).color, 0xef4444);
  assert.match(rendered, /NFT refresh failed: TRANSIENT returned HTTP 404/);
  assert.match(rendered, /Affected NFT/);
  assert.match(rendered, /no attempt scheduled/);
});
test('recovery alerts keep the green embed color without a color name in the title', () => {
  const alert = parseAlert({
    ...fixture,
    severity: 'recovery',
    code: 'PLATFORM_RECOVERY'
  });
  assert.equal(embed(alert).color, 0x22c55e);
  assert.equal(embed(alert).title, 'prod · seizeAPI · PLATFORM_RECOVERY');
});
