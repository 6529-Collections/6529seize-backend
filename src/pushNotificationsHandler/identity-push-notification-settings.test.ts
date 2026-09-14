import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import {
  getEnabledCauses,
  isNotificationEnabledForDevice
} from './identity-push-notification-settings';

describe('identity push notification settings', () => {
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
