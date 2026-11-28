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

  it('takes a mainnet grant whose signature recovers to no one as unverifiable, as wave-events does', () => {
    const event = testSignedEvent();
    const viaOf = (proof: Record<string, unknown>, known = null as never) => {
      const check = checkRelayEvent(event, proof, known);
      return check.ok ? check.grantVia : check.reason;
    };
    expect(viaOf(testGrantProof())).toBe('signature');
    // A contract wallet's signature, or none that this server can read.
    expect(
      viaOf(testGrantProof({ wallet_signature: `0x${'11'.repeat(65)}` }))
    ).toBe('unverifiable');
    // Only the strict form recovers: 65 bytes, v 27/28 or 0/1, a low s.
    const valid = String(testGrantProof().wallet_signature);
    expect(
      viaOf(testGrantProof({ wallet_signature: valid.slice(0, 130) }))
    ).toBe('unverifiable');
    expect(
      viaOf(testGrantProof({ wallet_signature: `${valid.slice(0, 130)}25` }))
    ).toBe('unverifiable');
    expect(
      viaOf(testGrantProof({ wallet_signature: `${valid.slice(0, 130)}00` }))
    ).not.toBe('signature');
    // 6529.io holds the grant: known, with its terms compared.
    expect(viaOf(testGrantProof(), testGrantEntity() as never)).toBe('known');
  });

  it('checks a grant 6529.io holds against the proof, and counts its revocation', () => {
    const event = testSignedEvent();
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
    expect(
      reasonOf(event, testGrantProof({ domain: '6529.io' }), testGrantEntity())
    ).toBe('grant inconsistent');
  });

  it('refuses app grants beyond the terms wave-events takes', () => {
    const event = testSignedEvent();
    const message = JSON.parse(String(testGrantProof().message));
    expect(
      reasonOf(
        event,
        testGrantProof({
          message: JSON.stringify({
            ...message,
            scopes: 'edit,post,delete,react'
          })
        })
      )
    ).toMatch(/grant (terms out of bounds|message unreadable)/);
    expect(
      reasonOf(
        event,
        testGrantProof({
          message: JSON.stringify({
            ...message,
            expiresAt: message.issuedAt + 400 * 86400
          })
        })
      )
    ).toMatch(/grant (terms out of bounds|message unreadable)/);
  });

  it('reads the wallet in a grant message in any case, as wave-events does', () => {
    const message = JSON.parse(String(testGrantProof().message));
    // A checksum that is wrong in mixed case: ethers alone would throw.
    const check = checkRelayEvent(
      testSignedEvent(),
      testGrantProof({
        message: JSON.stringify({
          ...message,
          wallet: '0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266'
        })
      }),
      null
    );
    expect(check).toMatchObject({ ok: true, grantVia: 'signature' });
  });

  it('answers a grant that cannot be read at all, instead of throwing', () => {
    const check = checkRelayEvent(
      testSignedEvent(),
      testGrantProof({ message: '{"wallet": ' }),
      null
    );
    expect(check.ok).toBe(false);
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
