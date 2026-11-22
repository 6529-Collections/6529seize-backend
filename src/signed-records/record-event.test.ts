import {
  computeRecordEventId,
  decodeSignedRecordsHeader,
  encodeSignedRecordsHeader,
  hashRecordBody
} from './record-event';
import {
  familyWave,
  isPrincipalFamily,
  parseFamilyWave
} from './record-families';
import { compareOrderKeys, importOrderKey, orderKeyOf } from './record-order';
import { VECTORS } from './record-test-fixtures';

const PRINCIPAL = VECTORS.inputs.principal;

describe('record events', () => {
  it('computes the vector ids and body hashes', () => {
    for (const event of [
      VECTORS.followRecord,
      VECTORS.followUnset,
      VECTORS.sealedSettings.event,
      VECTORS.keys.event
    ]) {
      expect(computeRecordEventId(event)).toBe(event.id);
      const body = hashRecordBody(
        event.body === null ? null : (JSON.parse(event.body) as object)
      );
      expect(body).toEqual({
        canonical: event.body,
        bodyHash: event.body_hash,
        bodySize: event.body_size
      });
    }
  });

  it('round-trips the transport header and refuses bad input', () => {
    const events = [VECTORS.followRecord, VECTORS.keys.event];
    expect(
      decodeSignedRecordsHeader(encodeSignedRecordsHeader(events))
    ).toEqual(events);
    expect(() => decodeSignedRecordsHeader('not base64!')).toThrow('base64url');
    expect(() =>
      decodeSignedRecordsHeader(Buffer.from('[]').toString('base64url'))
    ).toThrow('non-empty array');
    expect(() =>
      decodeSignedRecordsHeader(
        encodeSignedRecordsHeader([
          { ...VECTORS.followRecord, kind: 1 } as never
        ])
      )
    ).toThrow('malformed signed record');
    expect(() => decodeSignedRecordsHeader('A'.repeat(9000))).toThrow(
      'too large'
    );
  });
});

describe('record families', () => {
  it('parses streams and refuses drop waves and bad owners', () => {
    expect(parseFamilyWave(`ps/${PRINCIPAL}`)).toEqual({
      family: 'ps',
      owner: PRINCIPAL
    });
    expect(parseFamilyWave('cv/0x0a1b')).toEqual({
      family: 'cv',
      owner: '0x0a1b'
    });
    // Lane owners are lowercase hex, as the relays take them.
    expect(parseFamilyWave('cv/group-1')).toBeNull();
    expect(parseFamilyWave('cv/0x0A1B')).toBeNull();
    expect(parseFamilyWave(`dv/0x${'a'.repeat(129)}`)).toBeNull();
    expect(parseFamilyWave('4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10')).toBeNull();
    expect(parseFamilyWave(`pv/${PRINCIPAL.toUpperCase()}`)).toBeNull();
    expect(parseFamilyWave('pv/0x01')).toBeNull();
    expect(parseFamilyWave('zz/owner')).toBeNull();
    expect(parseFamilyWave('cv/a/b')).toBeNull();
    expect(isPrincipalFamily('bk')).toBe(true);
    expect(isPrincipalFamily('md')).toBe(false);
    expect(familyWave('pv', PRINCIPAL)).toBe(`pv/${PRINCIPAL}`);
    expect(() => familyWave('pv', 'not-a-principal')).toThrow('Invalid pv');
  });
});

describe('record order', () => {
  it('orders by anchor, then claimed time, then event id', () => {
    const set = orderKeyOf(VECTORS.followRecord);
    const unset = orderKeyOf(VECTORS.followUnset);
    expect(compareOrderKeys(set, unset)).toBe(-1);
    expect(compareOrderKeys(unset, set)).toBe(1);
    expect(compareOrderKeys(set, { ...set })).toBe(0);
    expect(
      compareOrderKeys(set, { ...set, claimedTime: set.claimedTime + 1 })
    ).toBe(-1);
    expect(
      compareOrderKeys(set, { ...set, eventId: `0x${'f'.repeat(64)}` })
    ).toBe(-1);
    const imported = importOrderKey(set.anchor, set.claimedTime);
    expect(compareOrderKeys(imported, set)).toBe(-1);
  });
});
