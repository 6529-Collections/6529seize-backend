import { createPrivateKey, sign } from 'node:crypto';
import { ethers } from 'ethers';
import {
  canonicalizeEventBody,
  computeDeviceEventId,
  DEVICE_EVENT_DOMAIN,
  DeviceEventFields,
  verifyEd25519EventSignature,
  ZERO_BODY_HASH
} from './device-event';

// Shared DN1 contract vectors (dn1-vectors.json), copied verbatim.
const VECTORS = {
  salt: '0x4887f15a22b96f574a9f835b87e01e293dc7587acbfc13b5f224b89cd2d8c8aa',
  seedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  deviceKey:
    '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  body: {
    wave_id: '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10',
    title: null,
    parts: [
      {
        content: 'gm é😀 "q"',
        media: [],
        quoted_drop: null
      }
    ],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    reply_to: {
      drop_id: 'b0c5d6e7-1111-4222-8333-944455556666',
      drop_part_id: 1
    },
    signature: null,
    is_safe_signature: false,
    signer_address: '0x1111111111111111111111111111111111111111',
    drop_type: 'CHAT',
    hide_link_preview: false
  },
  canonicalBody:
    '{"drop_type":"CHAT","hide_link_preview":false,"is_safe_signature":false,"mentioned_users":[],"metadata":[],"parts":[{"content":"gm é😀 \\"q\\"","media":[],"quoted_drop":null}],"referenced_nfts":[],"reply_to":{"drop_id":"b0c5d6e7-1111-4222-8333-944455556666","drop_part_id":1},"signature":null,"signer_address":"0x1111111111111111111111111111111111111111","title":null,"wave_id":"4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10"}',
  bodyHash:
    '0x21f35f2f1bfccadb13cb9ad660c3f7c38d971327557f4bf921b37511d808fcf5',
  bodySize: 418,
  event: {
    kind: 1,
    kindVersion: 1,
    wave: '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10',
    author: '0x1111111111111111111111111111111111111111',
    keyType: 2,
    deviceKey:
      '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    authRef:
      '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc',
    seq: 1760000000000,
    anchor: 0,
    claimedTime: 1760000000123,
    refs: ['b0c5d6e7-1111-4222-8333-944455556666'],
    bodyHash:
      '0x21f35f2f1bfccadb13cb9ad660c3f7c38d971327557f4bf921b37511d808fcf5',
    bodySize: 418
  } as DeviceEventFields,
  eventId: '0x85085439fde88ab7c9c2979f922c1eb9d3b7f528819e6e7c3befad77f935b02a',
  signature:
    '0xf8c7552edc9013ef82b331037b34dd7ae20fa4a6aab9feea1d906c6ee1b906db03e20254917fce0832ce5768e3a676fad76cb9d47d12b5e74536aa11e9e9cf04',
  tombstone: {
    kind: 3,
    kindVersion: 1,
    wave: '4a1e0e2c-7a7d-4b38-9c0b-2f1d6d1c9a10',
    author: '0x1111111111111111111111111111111111111111',
    keyType: 2,
    deviceKey:
      '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    authRef:
      '0xe0b23044ded5e97599cd0d3f4ae0234df6aa13c90c633a9f12d9f597ea7f20bc',
    seq: 1760000000001,
    anchor: 0,
    claimedTime: 1760000000123,
    refs: ['b0c5d6e7-1111-4222-8333-944455556666'],
    bodyHash:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    bodySize: 0
  } as DeviceEventFields,
  tombstoneEventId:
    '0x13ad6341cb212fcaee1b119a7fd2b65eba48e74310b1725dabc4697ec99355be'
};

function signWithVectorSeed(eventId: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(VECTORS.seedHex, 'hex')
    ]),
    format: 'der',
    type: 'pkcs8'
  });
  return `0x${sign(null, Buffer.from(eventId.slice(2), 'hex'), privateKey).toString('hex')}`;
}

describe('device event', () => {
  it('uses the interim domain salt', () => {
    expect(DEVICE_EVENT_DOMAIN.salt).toBe(VECTORS.salt);
  });

  it('reproduces the vector auth ref', () => {
    expect(ethers.hashMessage('example grant message')).toBe(
      VECTORS.event.authRef
    );
  });

  it('canonicalizes and hashes the vector body', () => {
    const body = canonicalizeEventBody(
      JSON.parse(JSON.stringify(VECTORS.body))
    );
    expect(body).toEqual({
      canonical: VECTORS.canonicalBody,
      bodyHash: VECTORS.bodyHash,
      bodySize: VECTORS.bodySize
    });
  });

  it('hashes no body as zero with size zero', () => {
    expect(canonicalizeEventBody(null)).toEqual({
      canonical: null,
      bodyHash: ZERO_BODY_HASH,
      bodySize: 0
    });
    expect(ZERO_BODY_HASH).toBe(VECTORS.tombstone.bodyHash);
  });

  it('rejects bodies that are not plain JSON', () => {
    expect(() => canonicalizeEventBody({ n: Infinity })).toThrow();
  });

  it('reproduces the POST event id', () => {
    expect(computeDeviceEventId(VECTORS.event)).toBe(VECTORS.eventId);
  });

  it('reproduces the TOMBSTONE event id', () => {
    expect(computeDeviceEventId(VECTORS.tombstone)).toBe(
      VECTORS.tombstoneEventId
    );
  });

  it('reproduces the deterministic vector signature from the seed', () => {
    expect(signWithVectorSeed(VECTORS.eventId)).toBe(VECTORS.signature);
  });

  it('verifies the vector Ed25519 signature with the device key', () => {
    expect(
      verifyEd25519EventSignature({
        deviceKey: VECTORS.deviceKey,
        eventId: VECTORS.eventId,
        signature: VECTORS.signature
      })
    ).toBe(true);
  });

  it.each([
    [
      'another event',
      {
        eventId: VECTORS.tombstoneEventId,
        signature: VECTORS.signature,
        deviceKey: VECTORS.deviceKey
      }
    ],
    [
      'a flipped signature byte',
      {
        eventId: VECTORS.eventId,
        signature: `${VECTORS.signature.slice(0, -2)}05`,
        deviceKey: VECTORS.deviceKey
      }
    ],
    [
      'another key',
      {
        eventId: VECTORS.eventId,
        signature: VECTORS.signature,
        deviceKey: `0x${'11'.repeat(32)}`
      }
    ],
    [
      'a malformed key',
      {
        eventId: VECTORS.eventId,
        signature: VECTORS.signature,
        deviceKey: VECTORS.deviceKey.toUpperCase()
      }
    ],
    [
      'a short signature',
      {
        eventId: VECTORS.eventId,
        signature: VECTORS.signature.slice(0, -2),
        deviceKey: VECTORS.deviceKey
      }
    ]
  ])('rejects %s', (_name, input) => {
    expect(verifyEd25519EventSignature(input)).toBe(false);
  });
});
