import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import {
  getEnabledCauses,
  isNotificationEnabledForDevice
} from './identity-push-notification-settings';

describe('identity push notification settings', () => {
  it.each([
    IdentityNotificationCause.COMPETITION_LIFECYCLE,
    IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED
  ])(
    'requires competition capability and preserves the existing wave preference for %s',
    (cause) => {
      expect(
        getEnabledCauses(DEFAULT_PUSH_NOTIFICATION_SETTINGS)
      ).not.toContain(cause);
      expect(
        isNotificationEnabledForDevice(
          cause,
          DEFAULT_PUSH_NOTIFICATION_SETTINGS
        )
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
    }
  );
  it.each(['android', null])(
    'enables subscription coverage by default for platform %s',
    (platform) => {
      expect(DEFAULT_PUSH_NOTIFICATION_SETTINGS.subscription_coverage).toBe(
        true
      );
      expect(
        isNotificationEnabledForDevice(
          IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
          DEFAULT_PUSH_NOTIFICATION_SETTINGS,
          false,
          platform
        )
      ).toBe(true);
    }
  );

  it.each(['ios', ' iOS '])(
    'suppresses subscription coverage on %s while allowing other pushes',
    (platform) => {
      expect(
        isNotificationEnabledForDevice(
          IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
          DEFAULT_PUSH_NOTIFICATION_SETTINGS,
          false,
          platform
        )
      ).toBe(false);
      expect(
        isNotificationEnabledForDevice(
          IdentityNotificationCause.IDENTITY_MENTIONED,
          DEFAULT_PUSH_NOTIFICATION_SETTINGS,
          false,
          platform
        )
      ).toBe(true);
    }
  );

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
