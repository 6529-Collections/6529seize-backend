/**
 * Signed records: device-signed interim events (D111 format, unchanged) of
 * the kinds the relays carry on per-person streams and inboxes. The kind
 * numbers are the relay-inbox design's; every kind signs under the `post`
 * scope, which every device grant carries, so no grant changes.
 */
export const RecordKind = {
  RECORD: 9,
  SEALED: 10,
  LOG: 11,
  DEL: 12
} as const;

export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind];

export const RECORD_KIND_VERSION = 1;
export const RECORD_GRANT_SCOPE = 'post';
// Ed25519 in the P33 key type registry, as for drops.
export const RECORD_KEY_TYPE = 2;

/** Record types, sealed item types and SEALED labels. */
export const RECORD_TYPE_PATTERN = /^[a-z0-9.-]{1,32}$/;
export const RECORD_KEY_MAX_BYTES = 200;
export const RECORD_BODY_MAX_BYTES = 16 * 1024;
export const SEALED_BODY_MAX_BYTES = 64 * 1024;
export const LOG_BODY_MAX_BYTES = 64 * 1024;
export const DEL_BODY_MAX_BYTES = 4 * 1024;
export const DEL_MAX_IDS = 64;

export function isRecordKind(value: unknown): value is RecordKind {
  return (
    value === RecordKind.RECORD ||
    value === RecordKind.SEALED ||
    value === RecordKind.LOG ||
    value === RecordKind.DEL
  );
}
