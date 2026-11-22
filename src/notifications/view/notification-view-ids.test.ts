import * as fc from 'fast-check';
import {
  MAX_VIEW_ID_CREATED_AT,
  notificationSourceKey,
  notificationViewId
} from './notification-view-ids';

describe('notification view ids', () => {
  it('derives a stable sha256 source key from family, ref and recipient', () => {
    const key = notificationSourceKey('vote', 'tx-1:voter:drop', 'profile-a');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(notificationSourceKey('vote', 'tx-1:voter:drop', 'profile-a')).toBe(
      key
    );
    expect(
      notificationSourceKey('vote', 'tx-1:voter:drop', 'profile-b')
    ).not.toBe(key);
    // The separator keeps field boundaries: no two splits of one string collide.
    expect(notificationSourceKey('ab', 'c', 'd')).not.toBe(
      notificationSourceKey('a', 'bc', 'd')
    );
  });

  it('orders ids by time and keeps them safe integers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_VIEW_ID_CREATED_AT - 1 }),
        fc.string(),
        fc.string(),
        (createdAt, ref, recipient) => {
          const key = notificationSourceKey('f', ref, recipient);
          const id = notificationViewId(createdAt, key);
          const later = notificationViewId(createdAt + 1, key);
          expect(Number.isSafeInteger(id)).toBe(true);
          expect(Number.isSafeInteger(later)).toBe(true);
          expect(later).toBeGreaterThan(id);
          expect(Math.floor(id / 4096)).toBe(createdAt);
        }
      )
    );
  });

  it('places every id for today above any identity_notifications id', () => {
    const key = notificationSourceKey('f', 'r', 'p');
    // 22 Nov 2026; identity_notifications ids are far below 2^40.
    expect(notificationViewId(1_795_000_000_000, key)).toBeGreaterThan(2 ** 52);
  });

  it('refuses times it cannot encode and malformed keys', () => {
    const key = notificationSourceKey('f', 'r', 'p');
    expect(() => notificationViewId(-1, key)).toThrow('Invalid');
    expect(() => notificationViewId(1.5, key)).toThrow('Invalid');
    expect(() => notificationViewId(MAX_VIEW_ID_CREATED_AT + 1, key)).toThrow(
      'id range'
    );
    expect(notificationViewId(MAX_VIEW_ID_CREATED_AT, key)).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER
    );
    expect(() => notificationViewId(1, 'not-a-key')).toThrow('source key');
  });
});
