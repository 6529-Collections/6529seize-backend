import { In, Like } from 'typeorm';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { ApiIdentity } from '../api-serverless/src/generated/models/ApiIdentity';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import {
  directMessageWaveDisplayService,
  resolveWavePictureOverride
} from '../api-serverless/src/waves/direct-message-wave-display.service';
import { getDataSource } from '../db';
import {
  AttachmentEntity,
  AttachmentKind,
  DropAttachmentEntity
} from '../entities/IAttachment';
import { DropEntity, DropMediaEntity, DropPartEntity } from '../entities/IDrop';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import {
  DEFAULT_PUSH_NOTIFICATION_SETTINGS,
  PushNotificationSettingsData,
  PushNotificationSettingsEntity
} from '../entities/IPushNotificationSettings';
import { WaveEntity } from '../entities/IWave';
import { WaveReaderMetricEntity } from '../entities/IWaveReaderMetric';
import { Logger } from '../logging';
import { IdentityNotificationsDb } from '../notifications/identity-notifications.db';
import { dbSupplier } from '../sql-executor';
import { sumBadgeContributions } from './badge-count';
import {
  getDropMediaInfoForPush,
  truncatePushNotificationFileName
} from './push-notification-text';
import type { PushNotificationFileInfo } from './push-notification-text';
import { sendMessage } from './sendPushNotifications';

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
  [IdentityNotificationCause.DROP_REACTED]: 'drop_reacted',
  [IdentityNotificationCause.DROP_BOOSTED]: 'drop_boosted',
  [IdentityNotificationCause.WAVE_CREATED]: 'wave_created'
};

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');

const identityNotificationsDb = new IdentityNotificationsDb(dbSupplier);

async function getDeviceSettings(
  profileId: string,
  deviceId: string
): Promise<PushNotificationSettingsData> {
  const result = await getDataSource()
    .getRepository(PushNotificationSettingsEntity)
    .findOneBy({ profile_id: profileId, device_id: deviceId });

  if (!result) {
    return { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS };
  }

  return {
    identity_subscribed: result.identity_subscribed,
    identity_mentioned: result.identity_mentioned,
    identity_rep: result.identity_rep,
    identity_nic: result.identity_nic,
    drop_quoted: result.drop_quoted,
    drop_replied: result.drop_replied,
    drop_voted: result.drop_voted,
    drop_reacted: result.drop_reacted,
    drop_boosted: result.drop_boosted,
    wave_created: result.wave_created
  };
}

function isNotificationEnabledForDevice(
  cause: IdentityNotificationCause,
  settings: PushNotificationSettingsData
): boolean {
  const settingKey = CAUSE_TO_SETTING_KEY[cause];
  if (!settingKey) {
    return true;
  }
  return settings[settingKey];
}

function getEnabledCauses(
  settings: PushNotificationSettingsData
): IdentityNotificationCause[] {
  return (
    Object.values(IdentityNotificationCause) as IdentityNotificationCause[]
  ).filter((cause) => {
    const key = CAUSE_TO_SETTING_KEY[cause];
    if (key == null) return true;
    return settings[key];
  });
}

function getDeviceTokenKey(deviceId: string, token: string): string {
  return JSON.stringify([deviceId, token]);
}

function buildMultiProfileTitlePrefix(profileHandle: string): string {
  const normalizedHandle = profileHandle.startsWith('@')
    ? profileHandle.slice(1)
    : profileHandle;
  return `[${normalizedHandle}]`;
}

async function getSharedDeviceTokenKeysForOtherProfiles(
  devices: PushNotificationDevice[]
): Promise<Map<string, Set<string>>> {
  if (devices.length === 0) {
    return new Map();
  }

  const params: Record<string, string> = {};
  const deviceAndTokenConditions: string[] = [];

  devices.forEach((device, index) => {
    const deviceIdParam = `deviceId${index}`;
    const tokenParam = `token${index}`;
    params[deviceIdParam] = device.device_id;
    params[tokenParam] = device.token;
    deviceAndTokenConditions.push(
      `(d.device_id = :${deviceIdParam} AND d.token = :${tokenParam})`
    );
  });

  const rows = await getDataSource()
    .getRepository(PushNotificationDevice)
    .createQueryBuilder('d')
    .select('d.device_id', 'device_id')
    .addSelect('d.token', 'token')
    .addSelect('d.profile_id', 'profile_id')
    .where(`(${deviceAndTokenConditions.join(' OR ')})`, params)
    .getRawMany<{ device_id: string; token: string; profile_id: string }>();

  return rows.reduce((acc, row) => {
    const key = getDeviceTokenKey(row.device_id, row.token);
    if (!acc.has(key)) {
      acc.set(key, new Set());
    }
    acc.get(key)!.add(row.profile_id);
    return acc;
  }, new Map<string, Set<string>>());
}

export async function sendIdentityNotification(id: number) {
  logger.info(`Sending identity notification: ${id}`);

  const notification = await getDataSource()
    .getRepository(IdentityNotificationEntity)
    .findOneBy({ id });
  if (!notification) {
    logger.error(`Notification not found: ${id}`);
    return;
  }

  if (notification.read_at) {
    logger.info(
      `[ID ${notification.id}] Notification already read at ${notification.read_at}`
    );
    return;
  }

  if (notification.wave_id) {
    const readerMetric = await getDataSource()
      .getRepository(WaveReaderMetricEntity)
      .findOneBy({
        wave_id: notification.wave_id,
        reader_id: notification.identity_id
      });
    if (readerMetric?.muted) {
      logger.info(
        `[ID ${notification.id}] Wave ${notification.wave_id} is muted by user ${notification.identity_id}`
      );
      return;
    }
  }

  const userDevices = await getDataSource()
    .getRepository(PushNotificationDevice)
    .findBy({
      profile_id: notification.identity_id
    });

  if (userDevices.length === 0) {
    logger.info(
      `[ID ${notification.id}] No device token found for user ${notification.identity_id}`
    );
    return;
  }

  const profileIdsByDeviceToken =
    await getSharedDeviceTokenKeysForOtherProfiles(userDevices);
  const sharedDeviceTokenKeys = new Set(
    Array.from(profileIdsByDeviceToken.entries())
      .filter(([, profileIds]) =>
        Array.from(profileIds).some((id) => id !== notification.identity_id)
      )
      .map(([key]) => key)
  );
  const targetProfile = await getIdentityOrThrow(notification.identity_id);
  const targetProfileHandle =
    targetProfile.normalised_handle ??
    targetProfile.handle ??
    notification.identity_id;

  let multiProfileTitlePrefix: string | null = null;
  if (sharedDeviceTokenKeys.size > 0) {
    multiProfileTitlePrefix = buildMultiProfileTitlePrefix(targetProfileHandle);
  }

  const notificationData = await generateNotificationData(notification);
  if (notificationData) {
    const { title, body, data, imageUrl } = notificationData;

    await Promise.all(
      userDevices.map(async (device) => {
        const recipientSettings = await getDeviceSettings(
          notification.identity_id,
          device.device_id
        );
        if (
          !isNotificationEnabledForDevice(notification.cause, recipientSettings)
        ) {
          logger.info(
            `[ID ${notification.id}] Notification type ${notification.cause} disabled for device ${device.device_id}`
          );
          return;
        }

        const deviceKey = getDeviceTokenKey(device.device_id, device.token);
        const relevantProfiles =
          profileIdsByDeviceToken.get(deviceKey) ??
          new Set([notification.identity_id]);

        const contributions = await Promise.allSettled(
          Array.from(relevantProfiles).map(async (profileId) => {
            const settings = await getDeviceSettings(
              profileId,
              device.device_id
            );
            const enabledCauses = getEnabledCauses(settings);
            if (enabledCauses.length === 0) return 0;
            const eligibleGroupIds =
              await userGroupsService.getGroupsUserIsEligibleFor(profileId);
            const options: {
              includeNotificationId?: number;
              enabledCauses?: IdentityNotificationCause[];
            } = { enabledCauses };
            if (profileId === notification.identity_id) {
              options.includeNotificationId = notification.id;
            }
            return identityNotificationsDb.countUnreadNotificationsForIdentity(
              profileId,
              eligibleGroupIds,
              undefined,
              options
            );
          })
        );
        const badge = sumBadgeContributions(contributions);

        const shouldPrefixTitle =
          multiProfileTitlePrefix !== null &&
          sharedDeviceTokenKeys.has(deviceKey);
        const titleForDevice = shouldPrefixTitle
          ? `${multiProfileTitlePrefix} ${title}`
          : title;
        const dataForDevice = {
          ...data,
          target_profile_id: notification.identity_id,
          target_profile_handle: targetProfileHandle
        };

        try {
          await sendMessage(
            titleForDevice,
            body,
            device.token,
            notification.id,
            dataForDevice,
            badge,
            imageUrl ?? undefined
          );
        } catch (error: any) {
          if (
            error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token'
          ) {
            logger.warn(
              `[ID ${notification.id}] token-not-registered for profile ${notification.identity_id} device ${device.device_id}`
            );
            await getDataSource().getRepository(PushNotificationDevice).delete({
              device_id: device.device_id,
              profile_id: notification.identity_id,
              token: device.token
            });
            logger.info(
              `[ID ${notification.id}] Deleted unregistered token row for profile ${notification.identity_id} device ${device.device_id}`
            );
          } else {
            logger.error(`Failed to send notification: ${error.message}`, {
              error
            });
            throw error;
          }
        }
      })
    );
  } else {
    logger.error(`Failed to generate notification data: ${notification.id}`);
  }
}

async function generateNotificationData(
  notification: IdentityNotificationEntity
) {
  const additionalEntity = await getAdditionalIdOrThrow(notification);

  switch (notification.cause) {
    case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      return handleIdentitySubscribed(additionalEntity);
    case IdentityNotificationCause.IDENTITY_MENTIONED:
      return handleIdentityMentioned(notification, additionalEntity);
    case IdentityNotificationCause.IDENTITY_REP:
      return handleIdentityRep(notification, additionalEntity);
    case IdentityNotificationCause.IDENTITY_NIC:
      return handleIdentityNic(notification, additionalEntity);
    case IdentityNotificationCause.DROP_QUOTED:
      return handleDropQuoted(notification, additionalEntity);
    case IdentityNotificationCause.DROP_REPLIED:
      return handleDropReplied(notification, additionalEntity);
    case IdentityNotificationCause.DROP_VOTED:
      return handleDropVoted(notification, additionalEntity);
    case IdentityNotificationCause.DROP_REACTED:
      return handleDropReacted(notification, additionalEntity);
    case IdentityNotificationCause.DROP_BOOSTED:
      return handleDropBoosted(notification, additionalEntity);
    case IdentityNotificationCause.WAVE_CREATED:
      return handleWaveCreated(notification, additionalEntity);
    case IdentityNotificationCause.ALL_DROPS:
      return handleAllDrops(notification, additionalEntity);
    case IdentityNotificationCause.PRIORITY_ALERT:
      return handlePriorityAlert(notification, additionalEntity);
    default:
      return null;
  }
}

async function handleIdentitySubscribed(additionalEntity: ApiIdentity) {
  const title = `${additionalEntity.handle} is now following you`;
  const body = 'View profile';
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'profile',
    handle: additionalEntity.normalised_handle
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityRep(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const amount = (notification.additional_data as any).amount;
  const total = (notification.additional_data as any).total;
  const category = (notification.additional_data as any).category;
  const categoryText = category ? ` for category '${category}'` : '';
  const emoji = amount > 0 ? '🚀' : '💔';
  const title = `${emoji} Updated REP${categoryText}`;
  const sign = amount > 0 ? '+' : '';
  const body = `${additionalEntity.handle} updated your REP by ${sign}${Number(amount).toLocaleString()}\nNew Total: ${Number(total).toLocaleString()}`;
  const imageUrl = additionalEntity.pfp;
  const receiverProfile = await getIdentityOrThrow(notification.identity_id);
  const data = {
    redirect: 'profile',
    handle: receiverProfile.normalised_handle,
    subroute: 'rep'
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityNic(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const amount = (notification.additional_data as any).amount;
  const total = (notification.additional_data as any).total;
  const emoji = amount > 0 ? '🚀' : '💔';
  const title = `${emoji} Updated NIC Rating`;
  const sign = amount > 0 ? '+' : '';
  const body = `${additionalEntity.handle} updated your NIC by ${sign}${Number(amount).toLocaleString()}\nNew Total: ${Number(total).toLocaleString()}`;
  const imageUrl = additionalEntity.pfp;
  const receiverProfile = await getIdentityOrThrow(notification.identity_id);
  const data = {
    redirect: 'profile',
    handle: receiverProfile.normalised_handle,
    subroute: 'identity'
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityMentioned(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const userProfile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: notification.identity_id },
      {}
    );
  if (!userProfile?.id) {
    throw new Error(`[ID ${notification.id}] User profile not found`);
  }
  const dropPartMention = await getDropPart(notification, userProfile.handle!);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} mentioned you`;
  const body = await getDropBodyTextForPush(notification, dropPartMention);
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropQuoted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} quoted you`;
  const imageUrl = additionalEntity.pfp;
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropReplied(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} replied to your drop`;
  const body = await getDropBodyTextForPush(notification, dropPart);
  const imageUrl = additionalEntity.pfp;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropVoted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const vote = (notification.additional_data as any).vote;
  if (vote === 0) {
    return;
  }
  if (!vote) {
    throw new Error(`[ID ${notification.id}] Vote additional data not found`);
  }
  const title = `${additionalEntity.handle} rated your drop: ${
    vote > 0 ? '+' : '-'
  }${Math.abs(vote)}`;
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropReacted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const reaction: string = (notification.additional_data as any).reaction;
  if (!reaction) {
    throw new Error(
      `[ID ${notification.id}] Reaction additional data not found`
    );
  }
  const title = `${additionalEntity.handle} reacted ${reaction} to your drop`;
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropBoosted(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const title = `${additionalEntity.handle} boosted your drop 🔥`;
  const imageUrl = additionalEntity.pfp;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function getIdentityOrThrow(identityId: string | null) {
  if (!identityId) {
    throw new Error(`Identity id not provided`);
  }
  const profile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: identityId },
      {}
    );
  if (!profile?.id) {
    throw new Error(`Profile not found for identity ${identityId}`);
  }
  return profile;
}

async function getAdditionalIdOrThrow(
  notification: IdentityNotificationEntity
) {
  return getIdentityOrThrow(notification.additional_identity_id);
}

async function getDrop(notification: IdentityNotificationEntity) {
  const dropId = notification.related_drop_id;
  if (!dropId) {
    throw new Error(`[ID ${notification.id}] Drop id not found`);
  }
  const drop = await getDataSource().getRepository(DropEntity).findOneBy({
    id: dropId
  });
  return drop;
}

async function getDropPart(
  notification: IdentityNotificationEntity,
  handle?: string
) {
  const dropId = notification.related_drop_id;
  if (!dropId) {
    throw new Error(`[ID ${notification.id}] Drop id not found`);
  }
  const query: any = { drop_id: dropId };
  if (handle) {
    query['content'] = Like(`%@[${handle}]%`);
  }
  return getDataSource().getRepository(DropPartEntity).findOneBy(query);
}

async function getDropBodyTextForPush(
  notification: IdentityNotificationEntity,
  dropPart: DropPartEntity | null,
  emptyFallback = 'View drop'
): Promise<string> {
  const rawContent = dropPart?.content;
  const rawContentTrimmed = rawContent?.trim();
  const hasText = rawContentTrimmed != null && rawContentTrimmed !== '';
  const dropId = notification.related_drop_id;

  let mediaRows: DropMediaEntity[] = [];
  if (dropId) {
    const mediaRepo = getDataSource().getRepository(DropMediaEntity);
    if (dropPart?.drop_part_id != null) {
      mediaRows = await mediaRepo.find({
        where: { drop_id: dropId, drop_part_id: dropPart.drop_part_id },
        order: { id: 'ASC' }
      });
    }
    if (mediaRows.length === 0 && !dropPart) {
      mediaRows = await mediaRepo.find({
        where: { drop_id: dropId },
        order: { drop_part_id: 'ASC', id: 'ASC' }
      });
    }
  }

  if (hasText) {
    return rawContentTrimmed;
  }

  const mediaInfos = mediaRows.map((row) =>
    getDropMediaInfoForPush(row.url, row.mime_type)
  );
  const attachmentInfos = await getDropAttachmentInfosForPush(dropId, dropPart);
  const attachmentText = getAttachmentBodyText([
    ...mediaInfos,
    ...attachmentInfos
  ]);

  if (attachmentText) {
    return attachmentText;
  }
  return emptyFallback;
}

function getAttachmentBodyText(
  attachments: PushNotificationFileInfo[]
): string | null {
  if (attachments.length === 0) {
    return null;
  }
  if (attachments.length > 1) {
    return `${attachments.length} attachments`;
  }
  const attachment = attachments[0];
  const label = `${attachment.label} attachment`;
  return attachment.fileName ? `${label} · ${attachment.fileName}` : label;
}

async function getDropAttachmentInfosForPush(
  dropId: string | null,
  dropPart: DropPartEntity | null
): Promise<PushNotificationFileInfo[]> {
  if (!dropId) {
    return [];
  }
  const dropAttachmentRepo =
    getDataSource().getRepository(DropAttachmentEntity);
  let dropAttachments: DropAttachmentEntity[] = [];
  if (dropPart?.drop_part_id != null) {
    dropAttachments = await dropAttachmentRepo.find({
      where: { drop_id: dropId, drop_part_id: dropPart.drop_part_id }
    });
  }
  if (dropAttachments.length === 0 && !dropPart) {
    dropAttachments = await dropAttachmentRepo.find({
      where: { drop_id: dropId },
      order: { drop_part_id: 'ASC', attachment_id: 'ASC' }
    });
  }
  const attachmentIds = dropAttachments.map(
    (dropAttachment) => dropAttachment.attachment_id
  );
  if (attachmentIds.length === 0) {
    return [];
  }
  const attachments = await getDataSource()
    .getRepository(AttachmentEntity)
    .find({
      where: { id: In(attachmentIds) }
    });
  const attachmentsById = new Map(
    attachments.map((attachment) => [attachment.id, attachment])
  );
  return attachmentIds.map((attachmentId) =>
    getAttachmentInfoForPush(attachmentsById.get(attachmentId))
  );
}

function getAttachmentInfoForPush(
  attachment: AttachmentEntity | undefined
): PushNotificationFileInfo {
  if (!attachment) {
    return { label: 'File', fileName: null };
  }
  const label = getAttachmentLabelForPush(attachment.kind);
  const fileName = attachment.original_file_name?.trim();
  return {
    label,
    fileName: fileName ? truncatePushNotificationFileName(fileName) : null
  };
}

function getAttachmentLabelForPush(kind: AttachmentKind): string {
  switch (kind) {
    case AttachmentKind.PDF:
      return 'PDF';
    case AttachmentKind.CSV:
      return 'CSV';
    default:
      return 'Attachment';
  }
}

async function getDropSerialNo(dropId: string | null) {
  if (!dropId) {
    return null;
  }
  const drop = await getDataSource().getRepository(DropEntity).findOneBy({
    id: dropId
  });
  return drop?.serial_no ?? null;
}

async function handleWaveCreated(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const wave = await getWaveEntityOrThrow(
    notification.id,
    notification.wave_id
  );
  const waveDisplay = await getWaveDisplayForRecipient(notification, wave);

  const title = `${additionalEntity.handle} invited you to a wave: ${waveDisplay.name}`;
  const body = 'View wave';
  const imageUrl = waveDisplay.picture ?? undefined;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id
  };
  return { title, body, data, imageUrl };
}

async function getWaveEntityOrThrow(
  notificationId: number,
  waveId?: string | null
) {
  if (!waveId) {
    throw new Error(`[ID ${notificationId}] Wave id missing`);
  }
  const wave = await getDataSource()
    .getRepository(WaveEntity)
    .findOneBy({ id: waveId });
  if (!wave) {
    throw new Error(`[ID ${notificationId}] Wave with id ${waveId} not found`);
  }
  return wave;
}

async function getWaveDisplayForRecipient(
  notification: IdentityNotificationEntity,
  wave: WaveEntity
): Promise<{ name: string; picture: string | null }> {
  const displayByWaveId =
    await directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext({
      waveEntities: [wave],
      contextProfileId: notification.identity_id
    });
  const display = displayByWaveId[wave.id];
  return {
    name: display?.name ?? wave.name,
    picture: resolveWavePictureOverride(wave.picture, display)
  };
}

async function handleAllDrops(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const wave = await getWaveEntityOrThrow(
    notification.id,
    notification.wave_id
  );
  const waveDisplay = await getWaveDisplayForRecipient(notification, wave);
  const isRating =
    typeof (notification.additional_data as any).vote === 'number';

  let title;
  if (isRating) {
    const vote = (notification.additional_data as any).vote;
    title = `${additionalEntity.handle} rated a drop: ${
      vote > 0 ? '+' : '-'
    }${Math.abs(vote)}`;
  } else {
    title = `${additionalEntity.handle}`;
  }

  title += ` in ${waveDisplay.name}`;

  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = waveDisplay.picture ?? additionalEntity.pfp;
  const body = await getDropBodyTextForPush(notification, dropPart);
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handlePriorityAlert(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const wave = await getWaveEntityOrThrow(
    notification.id,
    notification.wave_id
  );
  const waveDisplay = await getWaveDisplayForRecipient(notification, wave);

  const drop = await getDrop(notification);
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = waveDisplay.picture ?? additionalEntity.pfp;
  const title = `🚨 ${drop?.title ?? 'Priority Alert'}`;
  const body = await getDropBodyTextForPush(
    notification,
    dropPart,
    'View alert'
  );
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}
