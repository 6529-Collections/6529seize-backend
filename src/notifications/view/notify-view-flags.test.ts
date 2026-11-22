import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  derivedCauses,
  isDerivedCause,
  legacyOutputEnabled,
  notificationsReadTable,
  notifyViewMode,
  writesLegacyCopy
} from './notify-view-flags';

const KEYS = [
  'NOTIFY_VIEW_MODE',
  'NOTIFY_DERIVED_CAUSES',
  'NOTIFY_LEGACY_OUTPUT'
] as const;

describe('notification view flags', () => {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
  });
  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to today: off, nothing derived, readers on identity_notifications', () => {
    expect(notifyViewMode()).toBe('off');
    expect(derivedCauses().size).toBe(0);
    expect(notificationsReadTable()).toBe('identity_notifications');
    expect(legacyOutputEnabled()).toBe(true);
  });

  it.each([
    ['shadow', 'shadow'],
    [' ON ', 'on'],
    ['true', 'off'],
    ['', 'off']
  ])('reads mode %p as %p', (value, mode) => {
    process.env.NOTIFY_VIEW_MODE = value;
    expect(notifyViewMode()).toBe(mode);
  });

  it('ignores derived causes while the mode is off, so every old writer runs', () => {
    process.env.NOTIFY_DERIVED_CAUSES = 'IDENTITY_REP';
    expect(isDerivedCause(IdentityNotificationCause.IDENTITY_REP)).toBe(false);
    expect(writesLegacyCopy(IdentityNotificationCause.IDENTITY_REP)).toBe(
      false
    );
  });

  it('parses the cause list and drops unknown names', () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    process.env.NOTIFY_DERIVED_CAUSES = ' identity_rep, DROP_VOTED ,NOPE,';
    expect(
      Array.from(derivedCauses()).sort((a, b) => a.localeCompare(b))
    ).toEqual([
      IdentityNotificationCause.DROP_VOTED,
      IdentityNotificationCause.IDENTITY_REP
    ]);
  });

  it('writes legacy copies in shadow, and in on until legacy output stops', () => {
    process.env.NOTIFY_DERIVED_CAUSES = 'DROP_VOTED';
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    expect(writesLegacyCopy(IdentityNotificationCause.DROP_VOTED)).toBe(true);
    expect(writesLegacyCopy(IdentityNotificationCause.IDENTITY_REP)).toBe(
      false
    );
    expect(notificationsReadTable()).toBe('identity_notifications');
    process.env.NOTIFY_VIEW_MODE = 'on';
    expect(writesLegacyCopy(IdentityNotificationCause.DROP_VOTED)).toBe(true);
    expect(notificationsReadTable()).toBe('notification_view');
    process.env.NOTIFY_LEGACY_OUTPUT = 'false';
    expect(writesLegacyCopy(IdentityNotificationCause.DROP_VOTED)).toBe(false);
  });
});
