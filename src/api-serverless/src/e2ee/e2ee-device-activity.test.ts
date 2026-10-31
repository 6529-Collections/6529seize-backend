import fc from 'fast-check';
import {
  e2eeDeviceActivityWindow,
  e2eeDeviceLastUsedAt,
  isInactiveDevice
} from '@/api/e2ee/e2ee-device-activity';
import { toApiE2eeDevice } from '@/api/e2ee/e2ee.mappers';
import { E2eeDeviceRow } from '@/e2ee/e2ee.db';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);

function aDevice(overrides: Partial<E2eeDeviceRow> = {}): E2eeDeviceRow {
  return {
    device_key: `0x${'ab'.repeat(32)}`,
    profile_id: 'profile-1',
    wallet: `0x${'11'.repeat(20)}`,
    ciphersuite: 0x004f,
    issued_at_seconds: Math.floor((NOW - 40 * DAY) / 1000),
    expires_at_seconds: Math.floor((NOW + 140 * DAY) / 1000),
    origin: '6529.io',
    grant_id: `0x${'cd'.repeat(32)}`,
    wallet_signature: `0x${'ef'.repeat(65)}`,
    verified_via: 'eoa',
    label: 'Chrome on Windows',
    platform: 'web',
    created_at: NOW - 40 * DAY,
    updated_at: NOW - 40 * DAY,
    last_seen_at: NOW - 40 * DAY,
    revoked_at: null,
    revoker_device_key: null,
    revocation_signed_at_seconds: null,
    revocation_signature: null,
    ...overrides
  } as E2eeDeviceRow;
}

describe('e2eeDeviceActivityWindow', () => {
  it('puts the cutoff the configured number of days before now', () => {
    expect(e2eeDeviceActivityWindow(NOW, 30)).toEqual({
      atSeconds: Math.floor(NOW / 1000),
      inactiveBeforeMs: NOW - 30 * DAY
    });
    expect(e2eeDeviceActivityWindow(NOW, 7).inactiveBeforeMs).toBe(
      NOW - 7 * DAY
    );
  });
});

describe('e2eeDeviceLastUsedAt', () => {
  it('uses last_seen_at, else the registration time', () => {
    expect(
      e2eeDeviceLastUsedAt({ last_seen_at: 500, created_at: 100 } as never)
    ).toBe(500);
    expect(
      e2eeDeviceLastUsedAt({ last_seen_at: null, created_at: 100 } as never)
    ).toBe(100);
    // MySQL bigint columns can arrive as strings.
    expect(
      e2eeDeviceLastUsedAt({ last_seen_at: '700', created_at: 100 } as never)
    ).toBe(700);
  });
});

describe('isInactiveDevice', () => {
  const window = e2eeDeviceActivityWindow(NOW, 30);

  it('marks an active device unused for longer than the window', () => {
    expect(isInactiveDevice(aDevice(), window)).toBe(true);
    expect(
      isInactiveDevice(aDevice({ last_seen_at: NOW - 29 * DAY }), window)
    ).toBe(false);
    expect(
      isInactiveDevice(aDevice({ last_seen_at: NOW - 30 * DAY }), window)
    ).toBe(false);
    expect(
      isInactiveDevice(aDevice({ last_seen_at: NOW - 30 * DAY - 1 }), window)
    ).toBe(true);
  });

  it('falls back to the registration time when the device was never seen', () => {
    expect(
      isInactiveDevice(
        aDevice({ last_seen_at: null, created_at: NOW - DAY }),
        window
      )
    ).toBe(false);
    expect(isInactiveDevice(aDevice({ last_seen_at: null }), window)).toBe(
      true
    );
  });

  it('never marks revoked or expired devices (they do not count anyway)', () => {
    expect(isInactiveDevice(aDevice({ revoked_at: NOW - DAY }), window)).toBe(
      false
    );
    expect(
      isInactiveDevice(
        aDevice({ expires_at_seconds: Math.floor((NOW - DAY) / 1000) }),
        window
      )
    ).toBe(false);
  });

  it('agrees with the cutoff for any last use of an active device', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 * DAY }),
        fc.integer({ min: 1, max: 365 }),
        (age, days) => {
          const cutoff = e2eeDeviceActivityWindow(NOW, days);
          const device = aDevice({ last_seen_at: NOW - age });
          expect(isInactiveDevice(device, cutoff)).toBe(age > days * DAY);
        }
      )
    );
  });
});

describe('toApiE2eeDevice activity', () => {
  it('adds inactive only when given an activity window', () => {
    const window = e2eeDeviceActivityWindow(NOW, 30);
    expect(toApiE2eeDevice(aDevice())).not.toHaveProperty('inactive');
    expect(toApiE2eeDevice(aDevice(), window).inactive).toBe(true);
    expect(
      toApiE2eeDevice(aDevice({ last_seen_at: NOW }), window).inactive
    ).toBe(false);
  });
});
