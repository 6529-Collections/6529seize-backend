import * as fc from 'fast-check';
import {
  E2EE_ENTRY_BUCKETS,
  E2EE_MESSAGE_BUCKETS
} from '@/e2ee/e2ee.constants';
import {
  decodeE2eeBase64,
  fromMysqlBase64,
  isDeadlockError,
  isDuplicateKeyError,
  isE2eeBucketLength,
  sanitizeE2eeDeviceLabel
} from '@/e2ee/e2ee-encoding';
import { E2eeApiException } from '@/e2ee/e2ee-errors';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as E2eeApiException).code;
  }
  return undefined;
}

describe('E2EE encodings', () => {
  it('round-trips canonical base64 and rejects other encodings', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const encoded = Buffer.from(bytes).toString('base64');
        expect(
          decodeE2eeBase64(encoded, 'data', 200).equals(Buffer.from(bytes))
        ).toBe(true);
      })
    );
    expect(codeOf(() => decodeE2eeBase64('AAA', 'data', 10))).toBe(
      'E2EE_BAD_REQUEST'
    );
    expect(codeOf(() => decodeE2eeBase64('AB==', 'data', 10))).toBe(
      'E2EE_BAD_REQUEST'
    );
    expect(codeOf(() => decodeE2eeBase64('AA-_', 'data', 10))).toBe(
      'E2EE_BAD_REQUEST'
    );
    expect(codeOf(() => decodeE2eeBase64('AAAA AAA', 'data', 10))).toBe(
      'E2EE_BAD_REQUEST'
    );
  });

  it('rejects payloads over the byte limit as too large', () => {
    const encoded = Buffer.alloc(11).toString('base64');
    expect(codeOf(() => decodeE2eeBase64(encoded, 'data', 10))).toBe(
      'E2EE_TOO_LARGE'
    );
    expect(codeOf(() => decodeE2eeBase64('A'.repeat(4000), 'data', 10))).toBe(
      'E2EE_TOO_LARGE'
    );
  });

  it('strips MySQL TO_BASE64 line breaks', () => {
    expect(fromMysqlBase64('QUJD\nREVG')).toBe('QUJDREVG');
    expect(fromMysqlBase64(null)).toBeNull();
  });

  it('accepts only exact bucket lengths', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 * 1024 * 1024 }), (length) => {
        expect(isE2eeBucketLength(length, E2EE_ENTRY_BUCKETS)).toBe(
          E2EE_ENTRY_BUCKETS.includes(length)
        );
        expect(isE2eeBucketLength(length, E2EE_MESSAGE_BUCKETS)).toBe(
          E2EE_MESSAGE_BUCKETS.includes(length)
        );
      })
    );
    for (const bucket of [...E2EE_ENTRY_BUCKETS, ...E2EE_MESSAGE_BUCKETS]) {
      expect(
        isE2eeBucketLength(bucket, E2EE_ENTRY_BUCKETS) ||
          isE2eeBucketLength(bucket, E2EE_MESSAGE_BUCKETS)
      ).toBe(true);
      expect(isE2eeBucketLength(bucket + 1, E2EE_ENTRY_BUCKETS)).toBe(false);
    }
  });

  it('sanitizes device labels', () => {
    expect(sanitizeE2eeDeviceLabel(undefined)).toBe('Device');
    expect(sanitizeE2eeDeviceLabel('   ')).toBe('Device');
    expect(sanitizeE2eeDeviceLabel('My <b>Phone</b>  (2)')).toBe(
      'My bPhoneb (2)'
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (label) => {
        const sanitized = sanitizeE2eeDeviceLabel(label);
        expect(sanitized.length).toBeGreaterThan(0);
        expect(sanitized.length).toBeLessThanOrEqual(48);
        expect(sanitized).toMatch(/^[A-Za-z0-9 ._()-]+$/);
      })
    );
  });

  it('recognizes duplicate-key errors, including sanitized ones', () => {
    expect(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(
      isDuplicateKeyError(
        Object.assign(
          new Error('Private e2ee messaging database operation failed'),
          {
            code: 'ER_DUP_ENTRY'
          }
        )
      )
    ).toBe(true);
    expect(isDuplicateKeyError(new Error('other'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it('recognizes deadlock errors, including sanitized ones', () => {
    expect(isDeadlockError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isDeadlockError({ errno: 1213 })).toBe(true);
    expect(
      isDeadlockError(
        Object.assign(
          new Error('Private e2ee messaging database operation failed'),
          { code: 'ER_LOCK_DEADLOCK' }
        )
      )
    ).toBe(true);
    expect(isDeadlockError({ code: 'ER_DUP_ENTRY' })).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });
});
