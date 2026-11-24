// Signed relay events for the harness's own tests, under RFC 8032's first
// Ed25519 test key and a made-up author: never a real device or wallet.
import { createPrivateKey, sign } from 'node:crypto';
import { ethers } from 'ethers';
import {
  computeDeviceEventId,
  DeviceEventFields
} from '@/api/device-signing/device-event';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';

const SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex'
);
export const TEST_DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
export const TEST_AUTHOR = '0x00000000000000000000000000000000000000a1';
const TEST_GRANT_ID = `0x${'11'.repeat(32)}`;

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    SEED
  ]),
  format: 'der',
  type: 'pkcs8'
});

/** A signed event in the relays' format, as a client publishes it. */
export function signedEvent(input: {
  wave: string;
  kind?: number;
  seq?: number;
  body?: unknown;
  refs?: string[];
}): Record<string, unknown> & { id: string; wave: string } {
  const body =
    input.body === undefined || input.body === null
      ? null
      : canonicalizeJson(input.body);
  const bytes = body === null ? null : ethers.toUtf8Bytes(body);
  const fields: DeviceEventFields = {
    kind: input.kind ?? 9,
    kindVersion: 1,
    wave: input.wave,
    author: TEST_AUTHOR,
    keyType: 2,
    deviceKey: TEST_DEVICE_KEY,
    authRef: TEST_GRANT_ID,
    seq: input.seq ?? 1,
    anchor: 1,
    claimedTime: 1_795_392_000_000,
    refs: input.refs ?? [],
    bodyHash: bytes ? ethers.keccak256(bytes) : ethers.ZeroHash,
    bodySize: bytes ? bytes.length : 0
  };
  const id = computeDeviceEventId(fields);
  const signature = `0x${sign(null, Buffer.from(id.slice(2), 'hex'), privateKey).toString('hex')}`;
  return {
    id,
    kind: fields.kind,
    kind_version: fields.kindVersion,
    wave: fields.wave,
    author: fields.author,
    key_type: fields.keyType,
    device_key: fields.deviceKey,
    auth_ref: fields.authRef,
    seq: fields.seq,
    anchor: fields.anchor,
    claimed_time: fields.claimedTime,
    refs: [...fields.refs],
    body,
    body_hash: fields.bodyHash,
    body_size: fields.bodySize,
    signature
  };
}
