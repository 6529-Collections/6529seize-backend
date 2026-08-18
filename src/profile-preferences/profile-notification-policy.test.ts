import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationLevel
} from '@/entities/IProfilePreferences';
import { isNotificationEnabled } from './profile-notification-policy';

describe('profile notification policy', () => {
  it('keeps all current causes enabled for profiles without stored preferences', () => {
    for (const cause of Object.values(IdentityNotificationCause)) {
      expect(isNotificationEnabled(cause, DEFAULT_PROFILE_PREFERENCES)).toBe(
        true
      );
    }
  });

  it('pauses all current optional causes in essential-only mode', () => {
    const preferences = {
      ...DEFAULT_PROFILE_PREFERENCES,
      notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
    };
    for (const cause of Object.values(IdentityNotificationCause)) {
      expect(isNotificationEnabled(cause, preferences)).toBe(false);
    }
  });

  it('fails open for a notification cause unknown to this deployment', () => {
    const unknownCause = 'FUTURE_NOTIFICATION' as IdentityNotificationCause;
    expect(
      isNotificationEnabled(unknownCause, {
        ...DEFAULT_PROFILE_PREFERENCES,
        notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
      })
    ).toBe(true);
  });
});
