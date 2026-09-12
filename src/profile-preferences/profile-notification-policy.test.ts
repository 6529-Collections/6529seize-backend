import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationCategories,
  ProfileNotificationLevel
} from '@/entities/IProfilePreferences';
import { isNotificationEnabled } from './profile-notification-policy';

const categoryCases: Array<
  [keyof ProfileNotificationCategories, IdentityNotificationCause[]]
> = [
  [
    'direct_messages',
    [
      IdentityNotificationCause.WAVE_CREATED,
      IdentityNotificationCause.ALL_DROPS,
      IdentityNotificationCause.PRIORITY_ALERT
    ]
  ],
  [
    'mentions_replies_quotes',
    [
      IdentityNotificationCause.IDENTITY_MENTIONED,
      IdentityNotificationCause.DROP_QUOTED,
      IdentityNotificationCause.DROP_REPLIED
    ]
  ],
  [
    'reactions_votes_boosts',
    [
      IdentityNotificationCause.DROP_VOTED,
      IdentityNotificationCause.DROP_POLL_VOTED,
      IdentityNotificationCause.DROP_REACTED,
      IdentityNotificationCause.DROP_BOOSTED
    ]
  ],
  ['new_followers', [IdentityNotificationCause.IDENTITY_SUBSCRIBED]],
  [
    'rep_and_nic',
    [
      IdentityNotificationCause.IDENTITY_REP,
      IdentityNotificationCause.IDENTITY_NIC
    ]
  ],
  ['subscription_coverage', [IdentityNotificationCause.SUBSCRIPTION_COVERAGE]]
];

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

  it.each([
    IdentityNotificationCause.WAVE_CREATED,
    IdentityNotificationCause.ALL_DROPS,
    IdentityNotificationCause.PRIORITY_ALERT
  ])(
    'uses the combined direct-message and wave-activity preference for %s',
    (cause) => {
      expect(
        isNotificationEnabled(cause, {
          ...DEFAULT_PROFILE_PREFERENCES,
          notifications: {
            ...DEFAULT_PROFILE_PREFERENCES.notifications,
            direct_messages: false
          }
        })
      ).toBe(false);
    }
  );

  it.each(categoryCases)(
    'suppresses only the disabled %s category',
    (category, mappedCauses) => {
      const preferences = {
        ...DEFAULT_PROFILE_PREFERENCES,
        notifications: {
          ...DEFAULT_PROFILE_PREFERENCES.notifications,
          [category]: false
        }
      };

      for (const cause of mappedCauses) {
        expect(isNotificationEnabled(cause, preferences)).toBe(false);
      }

      const otherCause = categoryCases.find(
        ([otherCategory]) => otherCategory !== category
      )![1][0];
      expect(isNotificationEnabled(otherCause, preferences)).toBe(true);
    }
  );
});
