import { KeyObject, sign as signBytes } from 'node:crypto';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import {
  DEVICE_EVENT_DOMAIN,
  DEVICE_EVENT_TYPES
} from '@/api/device-signing/device-event';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import {
  RECORD_KEY_TYPE,
  RECORD_KIND_VERSION,
  RecordKind
} from './record-kinds';

/** A signed record on the wire: CRP's SignedEvent, field for field. */
export interface SignedRecordEvent {
  readonly id: string;
  readonly kind: RecordKind;
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
  // The canonical JSON exactly as hashed; null when the record has no body.
  readonly body: string | null;
  readonly body_hash: string;
  readonly body_size: number;
  readonly signature: string;
}

/** CRP's GrantProof: what lets anyone check a record without 6529.io. */
export interface RecordGrantProof {
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

export const SIGNED_RECORDS_HEADER = 'x-6529-signed-records';
export const SIGNED_RECORDS_HEADER_MAX_BYTES = 8 * 1024;
const MAX_RECORDS_PER_HEADER = 16;

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX64 = /^0x[0-9a-f]{128}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

const uint = () =>
  Joi.number().integer().strict().min(0).max(Number.MAX_SAFE_INTEGER);

export const SignedRecordEventSchema: Joi.ObjectSchema<SignedRecordEvent> =
  Joi.object<SignedRecordEvent>({
    id: Joi.string().pattern(HEX32).required(),
    kind: Joi.number()
      .valid(
        RecordKind.RECORD,
        RecordKind.SEALED,
        RecordKind.LOG,
        RecordKind.DEL
      )
      .strict()
      .required(),
    kind_version: Joi.number().valid(RECORD_KIND_VERSION).strict().required(),
    wave: Joi.string().min(1).max(256).required(),
    author: Joi.string().pattern(ADDRESS).required(),
    key_type: Joi.number().valid(RECORD_KEY_TYPE).strict().required(),
    device_key: Joi.string().pattern(HEX32).required(),
    auth_ref: Joi.string().pattern(HEX32).required(),
    seq: uint().min(1).required(),
    anchor: uint().required(),
    claimed_time: uint().required(),
    refs: Joi.array().items(Joi.string().max(256)).max(4).required(),
    body: Joi.string().allow(null).required(),
    body_hash: Joi.string().pattern(HEX32).required(),
    body_size: uint().required(),
    signature: Joi.string().pattern(HEX64).required()
  })
    .required()
    .unknown(false);

export interface HashedRecordBody {
  readonly canonical: string | null;
  readonly bodyHash: string;
  readonly bodySize: number;
}

/** Canonical JSON, keccak256 and byte length of a body; null has none. */
export function hashRecordBody(body: object | null): HashedRecordBody {
  if (body === null) {
    return { canonical: null, bodyHash: ethers.ZeroHash, bodySize: 0 };
  }
  return hashCanonicalBody(canonicalizeJson(body));
}

export function hashCanonicalBody(canonical: string): HashedRecordBody {
  const bytes = ethers.toUtf8Bytes(canonical);
  return {
    canonical,
    bodyHash: ethers.keccak256(bytes),
    bodySize: bytes.length
  };
}

type UnsignedRecordFields = Omit<SignedRecordEvent, 'id' | 'signature'>;

/** The EIP-712 digest of a record's signed fields (its event id). */
export function computeRecordEventId(event: UnsignedRecordFields): string {
  return ethers.TypedDataEncoder.hash(DEVICE_EVENT_DOMAIN, DEVICE_EVENT_TYPES, {
    kind: event.kind,
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
  }).toLowerCase();
}

export interface RecordToSign {
  readonly kind: RecordKind;
  readonly wave: string;
  readonly refs: readonly string[];
  readonly body: object | null;
  readonly author: string;
  readonly deviceKey: string;
  readonly authRef: string;
  readonly seq: number;
  readonly anchor: number;
  readonly claimedTime: number;
}

/**
 * Signs a record with a server-held device key: the service identity's
 * import and log records, and test fixtures. People's records are signed in
 * their browsers.
 */
export function signRecordEvent(
  record: RecordToSign,
  privateKey: KeyObject
): SignedRecordEvent {
  const body = hashRecordBody(record.body);
  const fields: UnsignedRecordFields = {
    kind: record.kind,
    kind_version: RECORD_KIND_VERSION,
    wave: record.wave,
    author: record.author.toLowerCase(),
    key_type: RECORD_KEY_TYPE,
    device_key: record.deviceKey.toLowerCase(),
    auth_ref: record.authRef.toLowerCase(),
    seq: record.seq,
    anchor: record.anchor,
    claimed_time: record.claimedTime,
    refs: [...record.refs],
    body: body.canonical,
    body_hash: body.bodyHash,
    body_size: body.bodySize
  };
  const id = computeRecordEventId(fields);
  const signature = signBytes(
    null,
    Buffer.from(id.slice(2), 'hex'),
    privateKey
  ).toString('hex');
  return { ...fields, id, signature: `0x${signature}` };
}

/**
 * Reads the `x-6529-signed-records` header: base64url of the UTF-8 JSON
 * array of records. Throws on anything else; each record is checked against
 * SignedRecordEventSchema, not verified.
 */
export function decodeSignedRecordsHeader(value: string): SignedRecordEvent[] {
  if (value.length > SIGNED_RECORDS_HEADER_MAX_BYTES) {
    throw new Error('signed records header is too large');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('signed records header is not base64url');
  }
  const parsed: unknown = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8')
  );
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('signed records header is not a non-empty array');
  }
  if (parsed.length > MAX_RECORDS_PER_HEADER) {
    throw new Error('signed records header holds too many records');
  }
  return parsed.map((item) => {
    const { error, value: record } = SignedRecordEventSchema.validate(item);
    if (error) {
      throw new Error(`malformed signed record (${error.message})`);
    }
    return record;
  });
}

export function encodeSignedRecordsHeader(
  events: readonly SignedRecordEvent[]
): string {
  return Buffer.from(JSON.stringify(events), 'utf8').toString('base64url');
}
