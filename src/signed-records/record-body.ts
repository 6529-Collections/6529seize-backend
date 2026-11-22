import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import type { SignedRecordEvent } from './record-event';
import {
  DEL_BODY_MAX_BYTES,
  DEL_MAX_IDS,
  LOG_BODY_MAX_BYTES,
  RECORD_BODY_MAX_BYTES,
  RECORD_KEY_MAX_BYTES,
  RECORD_TYPE_PATTERN,
  RecordKind,
  SEALED_BODY_MAX_BYTES
} from './record-kinds';

export class RecordBodyError extends Error {
  constructor(
    readonly reason: 'refs' | 'body' | 'size',
    message: string
  ) {
    super(message);
    this.name = 'RecordBodyError';
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, RecordBodyError.prototype);
  }
}

/** A SEALED body `{"h","n","v":1}`: the sha256 and size of a payload. */
export interface SealedPayloadRef {
  readonly sha256: string;
  readonly size: number;
}

export type ParsedRecordBody =
  | {
      readonly kind: typeof RecordKind.RECORD;
      readonly type: string;
      readonly key: string;
      // null unsets the key.
      readonly body: Record<string, unknown> | null;
    }
  | {
      readonly kind: typeof RecordKind.SEALED;
      readonly label: string;
      // The inline `c` bytes, or null for a payload reference.
      readonly bytes: Buffer | null;
      // A payload stored apart (relay-inbox payloads), or null when inline.
      readonly payload: SealedPayloadRef | null;
    }
  | {
      readonly kind: typeof RecordKind.LOG;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: typeof RecordKind.DEL;
      readonly ids: readonly string[];
    };

export const SEALED_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;

const EVENT_ID = /^0x[0-9a-f]{64}$/;
const SHA256 = /^0x[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// A UTF-16 surrogate without its pair: not Unicode, not encodable as UTF-8.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string is well-formed Unicode (no lone surrogate). */
export function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

export function isRecordType(value: string): boolean {
  return RECORD_TYPE_PATTERN.test(value);
}

export function isRecordKey(value: string): boolean {
  return (
    isWellFormed(value) &&
    Buffer.byteLength(value, 'utf8') <= RECORD_KEY_MAX_BYTES
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a body that must be canonical JSON of an object within maxBytes. */
function parseCanonicalObject(
  body: string | null,
  maxBytes: number
): Record<string, unknown> {
  if (body === null) {
    throw new RecordBodyError('body', 'body is required');
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw new RecordBodyError('size', `body is over ${maxBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RecordBodyError('body', 'body is not JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new RecordBodyError('body', 'body is not a JSON object');
  }
  let canonical: string;
  try {
    canonical = canonicalizeJson(parsed);
  } catch (error) {
    throw new RecordBodyError('body', String(error));
  }
  if (canonical !== body) {
    throw new RecordBodyError('body', 'body is not canonical JSON');
  }
  return parsed;
}

function parseRecord(event: SignedRecordEvent): ParsedRecordBody {
  const [type, key, ...rest] = event.refs;
  if (
    type === undefined ||
    rest.length > 0 ||
    !isRecordType(type) ||
    (key !== undefined && !isRecordKey(key))
  ) {
    throw new RecordBodyError('refs', 'refs must be [type] or [type, key]');
  }
  const body =
    event.body === null
      ? null
      : parseCanonicalObject(event.body, RECORD_BODY_MAX_BYTES);
  return { kind: RecordKind.RECORD, type, key: key ?? '', body };
}

function parsePayloadRef(body: Record<string, unknown>): SealedPayloadRef {
  const { h, n, v, ...extra } = body;
  if (
    v !== 1 ||
    Object.keys(extra).length > 0 ||
    typeof h !== 'string' ||
    !SHA256.test(h) ||
    typeof n !== 'number' ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > SEALED_PAYLOAD_MAX_BYTES
  ) {
    throw new RecordBodyError(
      'body',
      'a payload reference must be {"h","n","v":1}'
    );
  }
  return { sha256: h, size: n };
}

function parseInline(body: Record<string, unknown>): Buffer {
  const { c, v, ...extra } = body;
  if (
    v !== 1 ||
    Object.keys(extra).length > 0 ||
    typeof c !== 'string' ||
    !BASE64URL.test(c)
  ) {
    throw new RecordBodyError('body', 'sealed body must be {"c","v":1}');
  }
  const bytes = Buffer.from(c, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== c) {
    throw new RecordBodyError('body', 'c is not canonical base64url');
  }
  return bytes;
}

function parseSealed(event: SignedRecordEvent): ParsedRecordBody {
  const [label, ...rest] = event.refs;
  if (label === undefined || rest.length > 0 || !isRecordType(label)) {
    throw new RecordBodyError('refs', 'refs must be [label]');
  }
  const body = parseCanonicalObject(event.body, SEALED_BODY_MAX_BYTES);
  if ('h' in body) {
    return {
      kind: RecordKind.SEALED,
      label,
      bytes: null,
      payload: parsePayloadRef(body)
    };
  }
  return {
    kind: RecordKind.SEALED,
    label,
    bytes: parseInline(body),
    payload: null
  };
}

function parseDel(event: SignedRecordEvent): ParsedRecordBody {
  if (event.refs.length > 0) {
    throw new RecordBodyError('refs', 'DEL takes no refs');
  }
  const body = parseCanonicalObject(event.body, DEL_BODY_MAX_BYTES);
  const { ids, ...extra } = body;
  if (
    Object.keys(extra).length > 0 ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > DEL_MAX_IDS ||
    !ids.every((id) => typeof id === 'string' && EVENT_ID.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new RecordBodyError('body', 'DEL body must be {"ids":[1-64 ids]}');
  }
  return { kind: RecordKind.DEL, ids: ids as string[] };
}

/**
 * Checks a record's refs and body against its kind (API section 2).
 * Throws RecordBodyError.
 */
export function parseRecordBody(event: SignedRecordEvent): ParsedRecordBody {
  switch (event.kind) {
    case RecordKind.RECORD:
      return parseRecord(event);
    case RecordKind.SEALED:
      return parseSealed(event);
    case RecordKind.LOG:
      return {
        kind: RecordKind.LOG,
        body: parseCanonicalObject(event.body, LOG_BODY_MAX_BYTES)
      };
    case RecordKind.DEL:
      return parseDel(event);
  }
}
