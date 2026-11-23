import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as signEd25519
} from 'node:crypto';
import { ethers } from 'ethers';
import {
  canonicalizeEventBody,
  computeDeviceEventId,
  DeviceEventFields,
  DeviceEventKind,
  verifyEd25519EventSignature
} from '@/api/device-signing/device-event';

/**
 * Signed records as the shared records API defines them: the live
 * interim event (D111) with the relay
 * families' kinds 9-12. This file holds only what the orderer needs to write
 * and check its own records. When the shared `src/signed-records/` module
 * lands, these helpers delegate to it; the wire shape does not change.
 */
export const E2eeRecordKind = {
  RECORD: 9,
  SEALED: 10,
  LOG: 11,
  DEL: 12
} as const;
export type E2eeRecordKind =
  (typeof E2eeRecordKind)[keyof typeof E2eeRecordKind];

export const E2EE_RECORD_KIND_VERSION = 1;
const ED25519_KEY_TYPE = 2;

/** The families the orderer writes. */
export type E2eeRecordFamily = 'cv' | 'dv' | 'dr' | 'bl' | 'bk' | 'md';

/** CRP's SignedEvent: the record exactly as signed, snake_case. */
export interface E2eeSignedRecordEvent {
  readonly id: string;
  readonly kind: number;
  readonly kind_version: number;
  readonly wave: string;
  readonly author: string;
  readonly key_type: number;
  readonly device_key: string;
  readonly auth_ref: string;
  readonly seq: number;
  readonly anchor: number;
  readonly claimed_time: number;
  readonly refs: readonly string[];
  /** The canonical JSON exactly as hashed; null when there is no body. */
  readonly body: string | null;
  readonly body_hash: string;
  readonly body_size: number;
  readonly signature: string;
}

/** CRP's GrantProof (times in milliseconds). */
export interface E2eeRecordGrantProof {
  readonly id: string;
  readonly message: string;
  readonly wallet_signature: string;
  readonly chain_id: number;
  readonly wallet: string;
  readonly device_key: string;
  readonly scopes: readonly string[];
  readonly domain: string;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

/** What a record says, before the signer adds author, key, time and order. */
export interface E2eeRecordDraft {
  readonly kind: E2eeRecordKind;
  readonly wave: string;
  readonly refs: readonly string[];
  /** A JSON object, or null for no body. */
  readonly body: Record<string, unknown> | null;
}

const OWNER_PATTERN = /^0x[0-9a-f]{1,128}$/;

export function e2eeFamilyWave(family: E2eeRecordFamily, owner: string) {
  const normalized = owner.toLowerCase();
  if (!OWNER_PATTERN.test(normalized)) {
    throw new Error(`Bad ${family} stream owner: ${owner}`);
  }
  return `${family}/${normalized}`;
}

export function parseE2eeFamilyWave(
  wave: string
): { readonly family: E2eeRecordFamily; readonly owner: string } | null {
  const match = /^(cv|dv|dr|bl|bk|md)\/(0x[0-9a-f]{1,128})$/.exec(wave);
  if (!match) return null;
  return { family: match[1] as E2eeRecordFamily, owner: match[2] };
}

function seedPrivateKey(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new Error('An Ed25519 seed is 32 bytes');
  }
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed
    ]),
    format: 'der',
    type: 'pkcs8'
  });
}

/** The 0x-hex Ed25519 public key of a 32-byte seed. */
export function e2eeEd25519PublicKey(seed: Buffer): string {
  const der = createPublicKey(seedPrivateKey(seed)).export({
    format: 'der',
    type: 'spki'
  });
  return `0x${Buffer.from(der).subarray(-32).toString('hex')}`;
}

/** Ed25519 over 32 digest bytes, 0x-hex. */
export function e2eeEd25519Sign(seed: Buffer, digest: string): string {
  const signature = signEd25519(
    null,
    Buffer.from(digest.slice(2), 'hex'),
    seedPrivateKey(seed)
  );
  return `0x${signature.toString('hex')}`;
}

function eventFields(event: Omit<E2eeSignedRecordEvent, 'id' | 'signature'>) {
  const fields: DeviceEventFields = {
    // The typed data takes any uint16 kind; the enum names only drops' kinds.
    kind: event.kind as DeviceEventKind,
    kindVersion: event.kind_version,
    wave: event.wave,
    author: event.author,
    keyType: event.key_type,
    deviceKey: event.device_key,
    authRef: event.auth_ref,
    seq: event.seq,
    anchor: event.anchor,
    claimedTime: event.claimed_time,
    refs: [...event.refs],
    bodyHash: event.body_hash,
    bodySize: event.body_size
  };
  return fields;
}

export function computeE2eeRecordEventId(
  event: Omit<E2eeSignedRecordEvent, 'id' | 'signature'>
): string {
  return computeDeviceEventId(eventFields(event));
}

export interface E2eeRecordSigningInput {
  readonly draft: E2eeRecordDraft;
  readonly seed: Buffer;
  readonly grant: E2eeRecordGrantProof;
  readonly seq: number;
  readonly anchor: number;
  readonly claimedTime: number;
}

/** Builds and signs one record with a device key under its grant. */
export function signE2eeRecord(
  input: E2eeRecordSigningInput
): E2eeSignedRecordEvent {
  const body = canonicalizeEventBody(input.draft.body);
  const unsigned = {
    kind: input.draft.kind,
    kind_version: E2EE_RECORD_KIND_VERSION,
    wave: input.draft.wave,
    author: input.grant.wallet.toLowerCase(),
    key_type: ED25519_KEY_TYPE,
    device_key: input.grant.device_key.toLowerCase(),
    auth_ref: input.grant.id.toLowerCase(),
    seq: input.seq,
    anchor: input.anchor,
    claimed_time: input.claimedTime,
    refs: [...input.draft.refs],
    body: body.canonical,
    body_hash: body.bodyHash,
    body_size: body.bodySize
  };
  const id = computeE2eeRecordEventId(unsigned);
  return { ...unsigned, id, signature: e2eeEd25519Sign(input.seed, id) };
}

export type E2eeRecordCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'body' | 'id' | 'sig' | 'author' };

/**
 * Checks a record against its own fields and an expected author key: the
 * body hashes to `body_hash` (or is absent with the zero hash), the id
 * recomputes, the Ed25519 signature verifies, and the signing device key is
 * the one expected (the orderer's, pinned in config).
 */
export function checkE2eeRecord(
  event: E2eeSignedRecordEvent,
  expectedDeviceKey: string
): E2eeRecordCheck {
  if (event.body === null) {
    if (event.body_hash !== ethers.ZeroHash || event.body_size !== 0) {
      return { ok: false, reason: 'body' };
    }
  } else {
    const bytes = ethers.toUtf8Bytes(event.body);
    if (
      ethers.keccak256(bytes) !== event.body_hash ||
      bytes.length !== event.body_size
    ) {
      return { ok: false, reason: 'body' };
    }
  }
  if (computeE2eeRecordEventId(event) !== event.id) {
    return { ok: false, reason: 'id' };
  }
  if (event.device_key !== expectedDeviceKey.toLowerCase()) {
    return { ok: false, reason: 'author' };
  }
  const signed = verifyEd25519EventSignature({
    deviceKey: event.device_key,
    eventId: event.id,
    signature: event.signature
  });
  return signed ? { ok: true } : { ok: false, reason: 'sig' };
}
