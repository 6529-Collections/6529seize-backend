import { DeviceEventKind } from '@/api/device-signing/device-event';
import {
  TEST_CLAIMED_TIME,
  TEST_GRANT_ID,
  testGrantEntity,
  testGrantProof,
  testSignedEvent,
  TEST_WALLET
} from '@/tests/fixtures/relay-events.fixture';
import { checkRelayEvent } from './relay-event-check';

function reasonOf(
  event: Record<string, unknown>,
  grant: Record<string, unknown> = testGrantProof(),
  known: ReturnType<typeof testGrantEntity> | null = null
) {
  const check = checkRelayEvent(event, grant, known);
  return check.ok ? 'ok' : check.reason;
}

describe('checkRelayEvent', () => {
  it('passes an event under a grant its wallet signed', () => {
    const event = testSignedEvent();
    const check = checkRelayEvent(event, testGrantProof(), null);
    expect(check).toMatchObject({
      ok: true,
      grantVia: 'signature',
      event: {
        id: event.id,
        kind: DeviceEventKind.POST,
        author: TEST_WALLET,
        authRef: TEST_GRANT_ID,
        body: '{"parts":[{"content":"hello"}]}'
      }
    });
  });

  it('passes every kind with its refs, and an event without a body', () => {
    for (const kind of [
      DeviceEventKind.EDIT,
      DeviceEventKind.TOMBSTONE,
      DeviceEventKind.REACT
    ]) {
      expect(reasonOf(testSignedEvent({ kind, refs: ['drop-1'] }))).toBe('ok');
    }
    expect(
      reasonOf(
        testSignedEvent({
          kind: DeviceEventKind.TOMBSTONE,
          refs: ['drop-1'],
          body: null
        })
      )
    ).toBe('ok');
  });

  it('takes a grant 6529.io holds without its signature, and its revocation', () => {
    const event = testSignedEvent();
    const proof = testGrantProof({ wallet_signature: `0x${'11'.repeat(65)}` });
    expect(reasonOf(event, proof)).toBe('grant signature');
    expect(reasonOf(event, proof, testGrantEntity())).toBe('ok');
    expect(
      reasonOf(event, testGrantProof(), testGrantEntity({ scopes: 'post' }))
    ).toBe('grant differs from the one 6529.io holds');
    expect(
      reasonOf(
        event,
        testGrantProof(),
        testGrantEntity({ revoked_at: TEST_CLAIMED_TIME - 1 })
      )
    ).toBe('grant revoked');
  });

  it('refuses an event whose fields were changed after signing', () => {
    const event = testSignedEvent();
    expect(reasonOf({ ...event, seq: 2 })).toBe('event id does not match');
    expect(reasonOf({ ...event, wave: 'wave-2' })).toBe(
      'event id does not match'
    );
    expect(reasonOf({ ...event, signature: `0x${'00'.repeat(64)}` })).toBe(
      'signature does not verify'
    );
  });

  it('refuses a body that is not what the event commits to, or not canonical', () => {
    const event = testSignedEvent();
    expect(reasonOf({ ...event, body: '{"parts":[{"content":"bye"}]}' })).toBe(
      'body does not match its hash'
    );
    expect(
      reasonOf({ ...event, body: '{ "parts": [{"content":"hello"}]}' })
    ).toBe('body does not match its hash');
  });

  it("refuses an event outside its grant's binding, scope and life", () => {
    const event = testSignedEvent();
    expect(reasonOf({ ...event, author: `0x${'ab'.repeat(20)}` })).toBe(
      'not bound to its grant'
    );
    expect(
      reasonOf(
        testSignedEvent({ kind: DeviceEventKind.REACT, refs: ['d'] }),
        testGrantProof({ scopes: ['post'] })
      )
    ).toBe('out of the grant scope');
    expect(reasonOf(testSignedEvent({ claimedTime: 1807876800 * 1000 }))).toBe(
      'grant expired'
    );
    expect(
      reasonOf(event, testGrantProof({ revoked_at: TEST_CLAIMED_TIME - 1 }))
    ).toBe('grant revoked');
    // A revocation after the event leaves it valid.
    expect(
      reasonOf(event, testGrantProof({ revoked_at: TEST_CLAIMED_TIME + 1 }))
    ).toBe('ok');
  });

  it('refuses a grant whose terms differ from the message its wallet signed', () => {
    const event = testSignedEvent();
    expect(
      reasonOf(event, testGrantProof({ expires_at: 1807876800 * 1000 + 1 }))
    ).toBe('grant inconsistent');
    expect(reasonOf(event, testGrantProof({ domain: '6529.io' }))).toBe(
      'grant inconsistent'
    );
    expect(reasonOf(event, testGrantProof({ message: '{}' }))).toBe(
      'grant message unreadable'
    );
  });

  it('refuses unknown kinds, other key types, too many refs and unreadable frames', () => {
    expect(reasonOf({ ...testSignedEvent(), kind: 9 })).toBe('unknown kind');
    expect(reasonOf({ ...testSignedEvent(), kind_version: 2 })).toBe(
      'unknown kind version'
    );
    expect(reasonOf({ ...testSignedEvent(), key_type: 1 })).toBe('key type');
    expect(
      reasonOf(testSignedEvent({ refs: Array.from({ length: 17 }, String) }))
    ).toBe('too many refs');
    expect(reasonOf({ id: 'x' })).toBe('unreadable event');
    expect(reasonOf(testSignedEvent(), { id: TEST_GRANT_ID })).toBe(
      'unreadable grant'
    );
  });
});
