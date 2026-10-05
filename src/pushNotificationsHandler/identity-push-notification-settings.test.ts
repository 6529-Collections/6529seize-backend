import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import {
  getEnabledCauses,
  isNotificationEnabledForDevice
} from './identity-push-notification-settings';

describe('identity push notification settings', () => {
  it('requires competition capability and preserves the existing wave preference', () => {
    const cause = IdentityNotificationCause.COMPETITION_LIFECYCLE;
    expect(getEnabledCauses(DEFAULT_PUSH_NOTIFICATION_SETTINGS)).not.toContain(
      cause
    );
    expect(
      isNotificationEnabledForDevice(cause, DEFAULT_PUSH_NOTIFICATION_SETTINGS)
    ).toBe(false);
    expect(
      getEnabledCauses(DEFAULT_PUSH_NOTIFICATION_SETTINGS, true)
    ).toContain(cause);
    expect(
      isNotificationEnabledForDevice(
        cause,
        { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS, wave_created: false },
        true
      )
    ).toBe(false);
  });
  it('enables subscription coverage pushes by default', () => {
    expect(DEFAULT_PUSH_NOTIFICATION_SETTINGS.subscription_coverage).toBe(true);
    expect(
      isNotificationEnabledForDevice(
        IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
        DEFAULT_PUSH_NOTIFICATION_SETTINGS
      )
    ).toBe(true);
  });

  it('excludes subscription coverage from enabled causes when disabled', () => {
    const settings = {
      ...DEFAULT_PUSH_NOTIFICATION_SETTINGS,
      subscription_coverage: false
    };

    expect(
      isNotificationEnabledForDevice(
        IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
        settings
      )
    ).toBe(false);
    expect(getEnabledCauses(settings)).not.toContain(
      IdentityNotificationCause.SUBSCRIPTION_COVERAGE
    );
  });
});
