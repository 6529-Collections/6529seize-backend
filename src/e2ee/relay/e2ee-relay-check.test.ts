import { checkE2eeRelayItem } from '@/e2ee/relay/e2ee-relay-check';
import {
  e2eeFamilyWave,
  E2eeRecordKind,
  signE2eeRecord
} from '@/e2ee/relay/e2ee-record-event';
import { e2eeTestRelayIdentity } from '@/tests/fixtures/e2ee-stream-store.fixture';

const orderer = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const other = e2eeTestRelayIdentity(9, `0x${'bb'.repeat(20)}`);
const flags = { E2EE_ORDERER_PUBLIC_KEY: orderer.deviceKey };

function item(
  signer = orderer,
  wave = e2eeFamilyWave('dv', `0x${'cd'.repeat(32)}`)
): { event: Record<string, unknown>; grant: Record<string, unknown> } {
  const event = signE2eeRecord({
    draft: {
      kind: E2eeRecordKind.SEALED,
      wave,
      refs: ['welcome'],
      body: { c: 'AQ', v: 1 }
    },
    seed: signer.seed,
    grant: signer.grant,
    seq: 1_795_694_700_000_000,
    anchor: 1000,
    claimedTime: 1_795_694_700_007
  });
  return {
    event: { ...event },
    grant: { ...signer.grant }
  };
}

describe('checkE2eeRelayItem', () => {
  it("passes the orderer's record", () => {
    expect(checkE2eeRelayItem(item(), flags)).toEqual({ ok: true });
  });

  it('passes every family the orderer writes', () => {
    for (const family of ['cv', 'dv', 'dr', 'bl', 'bk', 'md'] as const) {
      const wave = e2eeFamilyWave(family, `0x${'cd'.repeat(32)}`);
      expect(checkE2eeRelayItem(item(orderer, wave), flags)).toEqual({
        ok: true
      });
    }
  });

  it('fails a record another key signed, even under its own grant', () => {
    expect(checkE2eeRelayItem(item(other), flags)).toEqual({
      ok: false,
      reason: "not the orderer's record (author)"
    });
  });

  it('fails a record whose body or signature was changed', () => {
    const body = item();
    body.event.body = '{"c":"AA","v":1}';
    expect(checkE2eeRelayItem(body, flags)).toEqual({
      ok: false,
      reason: "not the orderer's record (body)"
    });
    const signature = item();
    signature.event.signature = `0x${'00'.repeat(64)}`;
    expect(checkE2eeRelayItem(signature, flags)).toEqual({
      ok: false,
      reason: "not the orderer's record (sig)"
    });
  });

  it('fails a wave outside the six families', () => {
    expect(
      checkE2eeRelayItem(item(orderer, `xx/0x${'cd'.repeat(32)}`), flags)
    ).toEqual({
      ok: false,
      reason: `wave xx/0x${'cd'.repeat(32)} is not an e2ee stream`
    });
  });

  it('fails a malformed event instead of throwing', () => {
    const missing = item();
    delete missing.event.body_hash;
    expect(checkE2eeRelayItem(missing, flags)).toEqual({
      ok: false,
      reason: 'malformed event: body_hash is not a string'
    });
    const refs = item();
    refs.event.refs = [1];
    expect(checkE2eeRelayItem(refs, flags)).toEqual({
      ok: false,
      reason: 'malformed event: refs is not a list of strings'
    });
    const badHex = item();
    badHex.event.signature = 'not hex';
    expect(checkE2eeRelayItem(badHex, flags).ok).toBe(false);
  });

  it('fails every event when the flag is missing', () => {
    expect(checkE2eeRelayItem(item(), {})).toEqual({
      ok: false,
      reason: 'no E2EE_ORDERER_PUBLIC_KEY flag'
    });
  });
});
