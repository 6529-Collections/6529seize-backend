import { ethers } from 'ethers';
import {
  computeDeviceEventId,
  DeviceEventFields,
  verifyEd25519EventSignature
} from '@/api/device-signing/device-event';
import { RelayCheckResult } from '@/rebuild/manifest.types';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';

/** The kinds of the signed event format the relays carry, version 1. */
const KINDS = new Set([1, 2, 3, 4, 9, 10, 11, 12]);
const KIND_VERSION = 1;
/** Ed25519, the only key type the format signs with. */
const ED25519 = 2;

const isUint = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isHex32 = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);

/**
 * The relays' own check of a signed event, for every area's events: the
 * kind and its version, the body (canonical JSON, matching its hash and
 * size), the id recomputed from the fields (the EIP-712 digest the
 * backend's device signing uses), and the Ed25519 signature over it by the
 * event's own device key. It does not check the grant or who the key
 * belongs to: that is the area's check (relayChecks).
 */
export function checkSignedEvent(
  event: Readonly<Record<string, unknown>>
): RelayCheckResult {
  const e = event;
  if (!isUint(e.kind) || !KINDS.has(e.kind)) {
    return {
      ok: false,
      reason: `kind ${String(e.kind)} is not a signed event's`
    };
  }
  if (e.kind_version !== KIND_VERSION) {
    return { ok: false, reason: `kind version ${String(e.kind_version)}` };
  }
  if (e.key_type !== ED25519) {
    return { ok: false, reason: `key type ${String(e.key_type)}` };
  }
  if (
    typeof e.wave !== 'string' ||
    typeof e.author !== 'string' ||
    !ethers.isAddress(e.author) ||
    !isHex32(e.device_key) ||
    !isHex32(e.auth_ref) ||
    !isHex32(e.body_hash) ||
    !isHex32(e.id) ||
    !isUint(e.seq) ||
    !isUint(e.anchor) ||
    !isUint(e.claimed_time) ||
    !isUint(e.body_size) ||
    !Array.isArray(e.refs) ||
    !e.refs.every((ref) => typeof ref === 'string') ||
    typeof e.signature !== 'string'
  ) {
    return {
      ok: false,
      reason: 'not a signed event: a field is missing or malformed'
    };
  }
  if (e.body === null || e.body === undefined) {
    if (e.body_hash !== ethers.ZeroHash || e.body_size !== 0) {
      return { ok: false, reason: 'no body, but a body hash or size' };
    }
  } else {
    if (typeof e.body !== 'string') {
      return { ok: false, reason: 'the body is not a string' };
    }
    let canonical: string;
    try {
      canonical = canonicalizeJson(JSON.parse(e.body));
    } catch {
      return { ok: false, reason: 'the body is not JSON' };
    }
    if (canonical !== e.body) {
      return { ok: false, reason: 'the body is not canonical JSON' };
    }
    const bytes = ethers.toUtf8Bytes(e.body);
    if (
      ethers.keccak256(bytes) !== e.body_hash ||
      bytes.length !== e.body_size
    ) {
      return { ok: false, reason: 'the body does not match its hash and size' };
    }
  }
  const fields: DeviceEventFields = {
    kind: e.kind,
    kindVersion: e.kind_version,
    wave: e.wave,
    author: e.author,
    keyType: e.key_type,
    deviceKey: e.device_key,
    authRef: e.auth_ref,
    seq: e.seq,
    anchor: e.anchor,
    claimedTime: e.claimed_time,
    refs: e.refs as string[],
    bodyHash: e.body_hash,
    bodySize: e.body_size
  };
  if (computeDeviceEventId(fields) !== e.id) {
    return { ok: false, reason: 'the id is not the digest of its fields' };
  }
  if (
    !verifyEd25519EventSignature({
      deviceKey: e.device_key,
      eventId: e.id,
      signature: e.signature
    })
  ) {
    return { ok: false, reason: "the signature is not the device key's" };
  }
  return { ok: true };
}
