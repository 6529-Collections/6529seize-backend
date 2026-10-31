import { isActiveDevice } from '@/api/e2ee/e2ee-context';
import { E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { e2eeDeviceInactiveDays } from '@/e2ee/e2ee-flag';

// Inactive devices (docs/e2ee-messaging.md, "Inactive devices"): an active
// device that has not been used for E2EE_DEVICE_INACTIVE_DAYS. Browsers that
// delete site data on close leave one such device behind per visit; they
// must not fill the device limit or be added to new groups.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time and cutoff one request judges device activity against. */
export interface E2eeDeviceActivityWindow {
  readonly atSeconds: number;
  /** Devices last used before this time (Unix ms) are inactive. */
  readonly inactiveBeforeMs: number;
}

export function e2eeDeviceActivityWindow(
  nowMs: number,
  inactiveDays: number = e2eeDeviceInactiveDays()
): E2eeDeviceActivityWindow {
  return {
    atSeconds: Math.floor(nowMs / 1000),
    inactiveBeforeMs: nowMs - inactiveDays * DAY_MS
  };
}

/** Last authenticated use: last_seen_at, else the registration time. */
export function e2eeDeviceLastUsedAt(
  device: Pick<E2eeDeviceRow, 'last_seen_at' | 'created_at'>
): number {
  return Number(device.last_seen_at ?? device.created_at);
}

/** Active (not revoked, not expired) but unused since the cutoff. */
export function isInactiveDevice(
  device: E2eeDeviceRow,
  window: E2eeDeviceActivityWindow
): boolean {
  return (
    isActiveDevice(device, window.atSeconds) &&
    e2eeDeviceLastUsedAt(device) < window.inactiveBeforeMs
  );
}
