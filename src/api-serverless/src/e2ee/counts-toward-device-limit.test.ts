import fc from 'fast-check';
import { countsTowardDeviceLimit } from '@/api/e2ee/e2ee-context';
import { E2EE_DEVICE_LIMIT_IDLE_WINDOW_MS } from '@/e2ee/e2ee.constants';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function device(
  overrides: Partial<{
    revoked_at: number | null;
    expires_at_seconds: number;
    last_seen_at: number | null;
    created_at: number;
  }> = {}
) {
  return {
    revoked_at: null,
    expires_at_seconds: Math.floor(NOW / 1000) + 100 * 86400,
    last_seen_at: NOW - DAY,
    created_at: NOW - 60 * DAY,
    ...overrides
  };
}

describe('countsTowardDeviceLimit', () => {
  it('counts an active device seen in the last 30 days', () => {
    expect(countsTowardDeviceLimit(device(), NOW)).toBe(true);
    expect(
      countsTowardDeviceLimit(
        device({ last_seen_at: NOW - E2EE_DEVICE_LIMIT_IDLE_WINDOW_MS }),
        NOW
      )
    ).toBe(true);
  });

  it('does not count an active device idle for longer', () => {
    expect(
      countsTowardDeviceLimit(
        device({ last_seen_at: NOW - E2EE_DEVICE_LIMIT_IDLE_WINDOW_MS - 1 }),
        NOW
      )
    ).toBe(false);
  });

  it('falls back to the creation time when the device was never seen', () => {
    expect(
      countsTowardDeviceLimit(
        device({ last_seen_at: null, created_at: NOW - DAY }),
        NOW
      )
    ).toBe(true);
    expect(
      countsTowardDeviceLimit(
        device({ last_seen_at: null, created_at: NOW - 31 * DAY }),
        NOW
      )
    ).toBe(false);
  });

  it('never counts a revoked or expired device, however recently seen', () => {
    expect(
      countsTowardDeviceLimit(device({ revoked_at: NOW - DAY }), NOW)
    ).toBe(false);
    expect(
      countsTowardDeviceLimit(
        device({ expires_at_seconds: Math.floor(NOW / 1000) }),
        NOW
      )
    ).toBe(false);
  });

  it('counts exactly the active devices seen within the window', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 400 * DAY }), { nil: null }),
        fc.integer({ min: 0, max: 400 * DAY }),
        fc.boolean(),
        fc.integer({ min: -400 * 86400, max: 400 * 86400 }),
        (lastSeenAgo, createdAgo, revoked, expiresIn) => {
          const row = device({
            last_seen_at: lastSeenAgo === null ? null : NOW - lastSeenAgo,
            created_at: NOW - createdAgo,
            revoked_at: revoked ? NOW - DAY : null,
            expires_at_seconds: Math.floor(NOW / 1000) + expiresIn
          });
          const seenAgo = lastSeenAgo ?? createdAgo;
          expect(countsTowardDeviceLimit(row, NOW)).toBe(
            !revoked &&
              expiresIn > 0 &&
              seenAgo <= E2EE_DEVICE_LIMIT_IDLE_WINDOW_MS
          );
        }
      )
    );
  });
});
