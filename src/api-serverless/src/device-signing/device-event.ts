import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { ethers } from 'ethers';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';

export enum DeviceEventKind {
  POST = 1,
  EDIT = 2,
  TOMBSTONE = 3,
  REACT = 4
}

export const DEVICE_EVENT_KIND_VERSION = 1;
// Ed25519 in the P33 key type registry.
export const DEVICE_EVENT_KEY_TYPE = 2;
export const DEVICE_EVENT_ANCHOR = 0;
export const ZERO_BODY_HASH = ethers.ZeroHash;

export const DEVICE_EVENT_DOMAIN: ethers.TypedDataDomain = {
  name: '6529 Network P2P',
  version: '1',
  salt: ethers.keccak256(
    ethers.toUtf8Bytes('6529 Network pre-genesis interim 1')
  )
};

export const DEVICE_EVENT_TYPES: Record<string, ethers.TypedDataField[]> = {
  InterimEvent: [
    { name: 'kind', type: 'uint16' },
    { name: 'kindVersion', type: 'uint16' },
    { name: 'wave', type: 'string' },
    { name: 'author', type: 'address' },
    { name: 'keyType', type: 'uint8' },
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'authRef', type: 'bytes32' },
    { name: 'seq', type: 'uint64' },
    { name: 'anchor', type: 'uint64' },
    { name: 'claimedTime', type: 'uint64' },
    { name: 'refs', type: 'string[]' },
    { name: 'bodyHash', type: 'bytes32' },
    { name: 'bodySize', type: 'uint32' }
  ]
};

export interface DeviceEventFields {
  readonly kind: DeviceEventKind;
  readonly kindVersion: number;
  readonly wave: string;
  readonly author: string;
  readonly keyType: number;
  readonly deviceKey: string;
  readonly authRef: string;
  readonly seq: number;
  readonly anchor: number;
  readonly claimedTime: number;
  readonly refs: readonly string[];
  readonly bodyHash: string;
  readonly bodySize: number;
}

export interface CanonicalEventBody {
  // Canonical JSON exactly as hashed; null when the event has no body.
  readonly canonical: string | null;
  readonly bodyHash: string;
  readonly bodySize: number;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PUBLIC_KEY_PATTERN = /^0x[0-9a-f]{64}$/;
const ED25519_SIGNATURE_PATTERN = /^0x[0-9a-f]{128}$/;
const EVENT_ID_PATTERN = /^0x[0-9a-f]{64}$/;

/**
 * Hashes an event body. `null` means the event has no body (zero hash, size
 * zero). Throws CanonicalJsonError for values that are not plain JSON.
 */
export function canonicalizeEventBody(body: unknown): CanonicalEventBody {
  if (body === null) {
    return { canonical: null, bodyHash: ZERO_BODY_HASH, bodySize: 0 };
  }
  const canonical = canonicalizeJson(body);
  const bytes = ethers.toUtf8Bytes(canonical);
  return {
    canonical,
    bodyHash: ethers.keccak256(bytes),
    bodySize: bytes.length
  };
}

export function computeDeviceEventId(fields: DeviceEventFields): string {
  return ethers.TypedDataEncoder.hash(DEVICE_EVENT_DOMAIN, DEVICE_EVENT_TYPES, {
    ...fields,
    refs: [...fields.refs]
  }).toLowerCase();
}

export function verifyEd25519EventSignature({
  deviceKey,
  eventId,
  signature
}: {
  readonly deviceKey: string;
  readonly eventId: string;
  readonly signature: string;
}): boolean {
  if (
    !ED25519_PUBLIC_KEY_PATTERN.test(deviceKey) ||
    !EVENT_ID_PATTERN.test(eventId) ||
    !ED25519_SIGNATURE_PATTERN.test(signature)
  ) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(deviceKey.slice(2), 'hex')
      ]),
      format: 'der',
      type: 'spki'
    });
    return verifySignature(
      null,
      Buffer.from(eventId.slice(2), 'hex'),
      publicKey,
      Buffer.from(signature.slice(2), 'hex')
    );
  } catch {
    return false;
  }
}
