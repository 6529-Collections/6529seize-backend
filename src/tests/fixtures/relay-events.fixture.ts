import { createPrivateKey, sign } from 'node:crypto';
import {
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  serializeAppDeviceGrantMessage
} from '@/api/device-signing/app-device-grant';
import {
  canonicalizeEventBody,
  computeDeviceEventId,
  DEVICE_EVENT_ANCHOR,
  DEVICE_EVENT_KEY_TYPE,
  DEVICE_EVENT_KIND_VERSION,
  DeviceEventKind
} from '@/api/device-signing/device-event';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';

/**
 * Signed relay events for tests, under the shared app-grant vector (the
 * backend's app-device-grant tests and the web pin the same values):
 * Hardhat's first test account and RFC 8032's first Ed25519 key, never a
 * real wallet or device.
 */

export const TEST_WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
export const TEST_DEVICE_SEED =
  '0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const TEST_DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
export const TEST_GRANT_ID =
  '0x82c7577579d677929ef813cff39ffae1bacd6f1ec1e858687105cfae289d0b58';
const TEST_GRANT_SIGNATURE =
  '0x69929366712f0057f41a94a75751ff2d5bc8185378c8f9c7dd89b3ea49d96f7553adf2b2a37572f097bc10227832da7ad9ae96d90ad21680167fa5b067bf31141c';
const ISSUED_AT = 1792324800;
const EXPIRES_AT = 1807876800;
/** A time inside the grant's life, ms. */
export const TEST_CLAIMED_TIME = (ISSUED_AT + 3600) * 1000;

const APP_GRANT: AppDeviceGrant = {
  wallet: TEST_WALLET,
  device_key: TEST_DEVICE_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  mls_device_key: null,
  ciphersuite: null,
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
  origin: '6529 Desktop'
};

/** The grant proof a relay sends with each event. */
export function testGrantProof(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: TEST_GRANT_ID,
    message: serializeAppDeviceGrantMessage(
      buildAppDeviceGrantMessage(APP_GRANT)
    ),
    wallet_signature: TEST_GRANT_SIGNATURE,
    chain_id: 1,
    wallet: TEST_WALLET,
    device_key: TEST_DEVICE_KEY,
    scopes: ['post', 'edit', 'delete', 'react'],
    domain: '6529 Desktop',
    expires_at: EXPIRES_AT * 1000,
    revoked_at: null,
    ...overrides
  };
}

/** The same grant as 6529.io stores it. */
export function testGrantEntity(
  overrides: Partial<DeviceGrantEntity> = {}
): DeviceGrantEntity {
  const proof = testGrantProof();
  return {
    id: TEST_GRANT_ID,
    wallet: TEST_WALLET,
    key_type: 'ed25519',
    device_key: TEST_DEVICE_KEY,
    scopes: 'post,edit,delete,react',
    device_label: 'Desktop',
    domain: '6529 Desktop',
    message: String(proof.message),
    wallet_signature: TEST_GRANT_SIGNATURE,
    chain_id: 1,
    issued_at: ISSUED_AT * 1000,
    expires_at: EXPIRES_AT * 1000,
    created_at: ISSUED_AT * 1000,
    revoked_at: null,
    last_used_at: null,
    ...overrides
  } as DeviceGrantEntity;
}

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(TEST_DEVICE_SEED.slice(2), 'hex')
  ]),
  format: 'der',
  type: 'pkcs8'
});

/** A signed event as a relay gives it (snake_case fields). */
export function testSignedEvent({
  kind = DeviceEventKind.POST,
  wave = 'wave-1',
  seq = 1,
  claimedTime = TEST_CLAIMED_TIME,
  refs = [],
  body = { parts: [{ content: 'hello' }] }
}: {
  kind?: DeviceEventKind;
  wave?: string;
  seq?: number;
  claimedTime?: number;
  refs?: string[];
  body?: unknown;
} = {}): Record<string, unknown> {
  const canonical = canonicalizeEventBody(body);
  const id = computeDeviceEventId({
    kind,
    kindVersion: DEVICE_EVENT_KIND_VERSION,
    wave,
    author: TEST_WALLET,
    keyType: DEVICE_EVENT_KEY_TYPE,
    deviceKey: TEST_DEVICE_KEY,
    authRef: TEST_GRANT_ID,
    seq,
    anchor: DEVICE_EVENT_ANCHOR,
    claimedTime,
    refs,
    bodyHash: canonical.bodyHash,
    bodySize: canonical.bodySize
  });
  return {
    id,
    kind,
    kind_version: DEVICE_EVENT_KIND_VERSION,
    wave,
    author: TEST_WALLET,
    key_type: DEVICE_EVENT_KEY_TYPE,
    device_key: TEST_DEVICE_KEY,
    auth_ref: TEST_GRANT_ID,
    seq,
    anchor: DEVICE_EVENT_ANCHOR,
    claimed_time: claimedTime,
    refs,
    body: canonical.canonical,
    body_hash: canonical.bodyHash,
    body_size: canonical.bodySize,
    signature: `0x${sign(null, Buffer.from(id.slice(2), 'hex'), privateKey).toString('hex')}`
  };
}
