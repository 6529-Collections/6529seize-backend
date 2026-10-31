import { E2eeApiException, e2eeErrors } from '@/e2ee/e2ee-errors';
import {
  E2EE_DEFAULT_DEVICE_LABEL,
  E2EE_DEVICE_LABEL_MAX_LENGTH
} from '@/e2ee/e2ee.constants';
import { E2EE_ZERO_32 } from '@/e2ee/e2ee-digests';

export const E2EE_HEX32_PATTERN = /^0x[0-9a-f]{64}$/;
export const E2EE_SIG64_PATTERN = /^0x[0-9a-f]{128}$/;
export const E2EE_WALLET_PATTERN = /^0x[0-9a-f]{40}$/;
export const E2EE_BLOB_ID_PATTERN = /^0x[0-9a-f]{32}$/;
export const E2EE_EPOCH_FP_PATTERN = /^[0-9a-f]{16}$/;
export const E2EE_WALLET_SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

/** Base64 length (with padding) of `bytes` raw bytes. */
export function e2eeBase64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Decodes canonical standard base64 (with padding). Rejects anything that
 * does not round-trip, so equivalent encodings cannot alias.
 */
export function decodeE2eeBase64(
  value: string,
  field: string,
  maxBytes: number
): Buffer {
  if (value.length > e2eeBase64Length(maxBytes)) {
    throw e2eeErrors.tooLarge(field);
  }
  if (value.length % 4 !== 0) {
    throw e2eeErrors.badRequest(`${field} must be standard padded base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw e2eeErrors.badRequest(`${field} must be standard padded base64`);
  }
  if (decoded.length > maxBytes) throw e2eeErrors.tooLarge(field);
  return decoded;
}

/** MySQL TO_BASE64 output wraps lines every 76 characters. */
export function fromMysqlBase64(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, '');
}

export function isE2eeBucketLength(
  length: number,
  buckets: readonly number[]
): boolean {
  return buckets.includes(length);
}

export function isZero32(value: string): boolean {
  return value === E2EE_ZERO_32;
}

/** Keeps [A-Za-z0-9 ._()-], collapses spaces, trims and truncates. */
export function sanitizeE2eeDeviceLabel(label: string | null | undefined) {
  const cleaned = (label ?? '')
    .replace(/[^A-Za-z0-9 ._()-]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, E2EE_DEVICE_LABEL_MAX_LENGTH)
    .trim();
  return cleaned || E2EE_DEFAULT_DEVICE_LABEL;
}

export function assertDistinct(values: readonly string[], field: string) {
  if (new Set(values).size !== values.length) {
    throw e2eeErrors.badRequest(`${field} contains duplicates`);
  }
}

export function isE2eeApiException(error: unknown): error is E2eeApiException {
  return error instanceof E2eeApiException;
}

/** MySQL duplicate-key errors, including sanitized private-family errors. */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

/** InnoDB deadlock victims, including sanitized private-family errors. */
export function isDeadlockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ER_LOCK_DEADLOCK' || errno === 1213;
}
