import { ethers } from 'ethers';
import {
  computeDeviceEventId,
  DeviceEventKind
} from '@/api/device-signing/device-event';
import {
  checkE2eeRecord,
  computeE2eeRecordEventId,
  e2eeEd25519PublicKey,
  e2eeFamilyWave,
  E2eeRecordKind,
  parseE2eeFamilyWave,
  signE2eeRecord
} from '@/e2ee/relay/e2ee-record-event';
import { e2eeTestRelayIdentity } from '@/tests/fixtures/e2ee-stream-store.fixture';

const orderer = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);

function signed(body: Record<string, unknown> | null = { c: 'AQ', v: 1 }) {
  return signE2eeRecord({
    draft: {
      kind: E2eeRecordKind.SEALED,
      wave: e2eeFamilyWave('dv', `0x${'cd'.repeat(32)}`),
      refs: ['welcome'],
      body
    },
    seed: orderer.seed,
    grant: orderer.grant,
    seq: 1_795_694_700_000_000,
    anchor: 1000,
    claimedTime: 1_795_694_700_007
  });
}

describe('e2ee record events', () => {
  it('derives the RFC 8032 test 1 public key from its seed', () => {
    expect(
      e2eeEd25519PublicKey(
        Buffer.from(
          '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
          'hex'
        )
      )
    ).toBe(
      '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
    );
  });

  it('signs the live interim event shape: the id is the drops typed-data hash', () => {
    const event = signed();
    expect(event).toMatchObject({
      kind: 10,
      kind_version: 1,
      key_type: 2,
      author: orderer.grant.wallet,
      device_key: orderer.deviceKey,
      auth_ref: orderer.grant.id,
      body: '{"c":"AQ","v":1}',
      body_hash: ethers.keccak256(ethers.toUtf8Bytes('{"c":"AQ","v":1}')),
      body_size: 16
    });
    expect(event.id).toBe(
      computeDeviceEventId({
        kind: 10 as DeviceEventKind,
        kindVersion: 1,
        wave: event.wave,
        author: event.author,
        keyType: 2,
        deviceKey: event.device_key,
        authRef: event.auth_ref,
        seq: event.seq,
        anchor: event.anchor,
        claimedTime: event.claimed_time,
        refs: ['welcome'],
        bodyHash: event.body_hash,
        bodySize: event.body_size
      })
    );
    expect(checkE2eeRecord(event, orderer.deviceKey)).toEqual({ ok: true });
  });

  it('checks a record with no body against the zero hash', () => {
    const event = signed(null);
    expect(event.body_hash).toBe(ethers.ZeroHash);
    expect(checkE2eeRecord(event, orderer.deviceKey)).toEqual({ ok: true });
  });

  it('finds every kind of tampering', () => {
    const event = signed();
    expect(
      checkE2eeRecord({ ...event, body: '{"c":"AA","v":1}' }, orderer.deviceKey)
    ).toEqual({ ok: false, reason: 'body' });
    expect(
      checkE2eeRecord({ ...event, seq: event.seq + 1 }, orderer.deviceKey)
    ).toEqual({
      ok: false,
      reason: 'id'
    });
    const other = e2eeTestRelayIdentity(8, `0x${'bb'.repeat(20)}`);
    expect(checkE2eeRecord(event, other.deviceKey)).toEqual({
      ok: false,
      reason: 'author'
    });
    const forged = { ...event, device_key: other.deviceKey };
    expect(
      checkE2eeRecord(
        { ...forged, id: computeE2eeRecordEventId(forged) },
        other.deviceKey
      )
    ).toEqual({ ok: false, reason: 'sig' });
  });

  it('names family streams in lowercase and parses only the orderer families', () => {
    expect(e2eeFamilyWave('cv', '0xABCD')).toBe('cv/0xabcd');
    expect(parseE2eeFamilyWave('cv/0xabcd')).toEqual({
      family: 'cv',
      owner: '0xabcd'
    });
    expect(parseE2eeFamilyWave('ps/0xabcd')).toBeNull();
    expect(parseE2eeFamilyWave('cv/abcd')).toBeNull();
    expect(() => e2eeFamilyWave('bk', 'not-hex')).toThrow();
  });
});
