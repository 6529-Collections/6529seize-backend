import { PUSH_NOTIFICATION_SETTINGS_TABLE } from '../../../constants';
import {
  DEFAULT_PUSH_NOTIFICATION_SETTINGS,
  PushNotificationSettingsData,
  PushNotificationSettingsEntity
} from '../../../entities/IPushNotificationSettings';
import { sqlExecutor } from '../../../sql-executor';

export async function getPushNotificationSettings(
  profileId: string,
  deviceId: string
): Promise<PushNotificationSettingsData> {
  const result = await sqlExecutor.oneOrNull<PushNotificationSettingsEntity>(
    `
    SELECT * FROM ${PUSH_NOTIFICATION_SETTINGS_TABLE}
    WHERE profile_id = :profileId AND device_id = :deviceId
    `,
    { profileId, deviceId }
  );

  if (!result) {
    return { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS };
  }

  return {
    identity_subscribed: result.identity_subscribed,
    identity_mentioned: result.identity_mentioned,
    identity_rep: result.identity_rep,
    identity_cic: result.identity_cic,
    drop_quoted: result.drop_quoted,
    drop_replied: result.drop_replied,
    drop_voted: result.drop_voted,
    drop_reacted: result.drop_reacted,
    drop_boosted: result.drop_boosted,
    wave_created: result.wave_created
  };
}

export async function upsertPushNotificationSettings(
  profileId: string,
  deviceId: string,
  settings: Partial<PushNotificationSettingsData>
): Promise<PushNotificationSettingsData> {
  const currentSettings = await getPushNotificationSettings(
    profileId,
    deviceId
  );
  const mergedSettings = { ...currentSettings, ...settings };

  await sqlExecutor.execute(
    `
    INSERT INTO ${PUSH_NOTIFICATION_SETTINGS_TABLE} (
      profile_id,
      device_id,
      identity_subscribed,
      identity_mentioned,
      identity_rep,
      identity_cic,
      drop_quoted,
      drop_replied,
      drop_voted,
      drop_reacted,
      drop_boosted,
      wave_created
    ) VALUES (
      :profileId,
      :deviceId,
      :identity_subscribed,
      :identity_mentioned,
      :identity_rep,
      :identity_cic,
      :drop_quoted,
      :drop_replied,
      :drop_voted,
      :drop_reacted,
      :drop_boosted,
      :wave_created
    )
    ON DUPLICATE KEY UPDATE
      identity_subscribed = VALUES(identity_subscribed),
      identity_mentioned = VALUES(identity_mentioned),
      identity_rep = VALUES(identity_rep),
      identity_cic = VALUES(identity_cic),
      drop_quoted = VALUES(drop_quoted),
      drop_replied = VALUES(drop_replied),
      drop_voted = VALUES(drop_voted),
      drop_reacted = VALUES(drop_reacted),
      drop_boosted = VALUES(drop_boosted),
      wave_created = VALUES(wave_created)
    `,
    {
      profileId,
      deviceId,
      ...mergedSettings
    }
  );

  return mergedSettings;
}
