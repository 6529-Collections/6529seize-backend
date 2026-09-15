import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type { PushNotificationSettingsData } from '@/entities/IPushNotificationSettings';

const CAUSE_TO_SETTING_KEY: Partial<
  Record<IdentityNotificationCause, keyof PushNotificationSettingsData>
> = {
  [IdentityNotificationCause.IDENTITY_SUBSCRIBED]: 'identity_subscribed',
  [IdentityNotificationCause.IDENTITY_MENTIONED]: 'identity_mentioned',
  [IdentityNotificationCause.IDENTITY_REP]: 'identity_rep',
  [IdentityNotificationCause.IDENTITY_NIC]: 'identity_nic',
  [IdentityNotificationCause.DROP_QUOTED]: 'drop_quoted',
  [IdentityNotificationCause.DROP_REPLIED]: 'drop_replied',
  [IdentityNotificationCause.DROP_VOTED]: 'drop_voted',
  [IdentityNotificationCause.DROP_POLL_VOTED]: 'drop_voted',
  [IdentityNotificationCause.DROP_REACTED]: 'drop_reacted',
  [IdentityNotificationCause.DROP_BOOSTED]: 'drop_boosted',
  [IdentityNotificationCause.WAVE_CREATED]: 'wave_created',
  [IdentityNotificationCause.SUBSCRIPTION_COVERAGE]: 'subscription_coverage'
};

export function isNotificationEnabledForDevice(
  cause: IdentityNotificationCause,
  settings: PushNotificationSettingsData
): boolean {
  const settingKey = CAUSE_TO_SETTING_KEY[cause];
  return settingKey ? settings[settingKey] : true;
}

export function getEnabledCauses(
  settings: PushNotificationSettingsData
): IdentityNotificationCause[] {
  return (
    Object.values(IdentityNotificationCause) as IdentityNotificationCause[]
  ).filter((cause) => isNotificationEnabledForDevice(cause, settings));
}
