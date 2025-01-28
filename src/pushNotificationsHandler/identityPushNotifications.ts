import { Like } from 'typeorm';
import { getDataSource } from '../db';
import { DropEntity, DropPartEntity } from '../entities/IDrop';
import {
  IdentityNotificationEntity,
  IdentityNotificationCause
} from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { profilesService } from '../profiles/profiles.service';
import { sendMessage } from './sendPushNotifications';
import { Logger } from '../logging';
import { Profile } from '../entities/IProfile';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');

export async function sendIdentityNotification(id: number) {
  logger.info(`Sending identity notification: ${id}`);

  const notification = await getDataSource()
    .getRepository(IdentityNotificationEntity)
    .findOneBy({ id });
  if (!notification) {
    throw new Error(`Notification not found: ${id}`);
  }

  if (notification.read_at) {
    logger.info(
      `[ID ${notification.id}] Notification already read at ${notification.read_at}`
    );
    return;
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

  const notificationData = await generateNotificationData(notification);
  if (notificationData) {
    const { title, body, data, imageUrl } = notificationData;

    await Promise.all(
      userDevices.map((device) =>
        sendMessage(
          title,
          body,
          device.token,
          notification.id,
          data,
          imageUrl
        ).catch(async (error) => {
          if (
            error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/invalid-registration-token'
          ) {
            logger.warn(`Token not registered: ${device.token}`);
            await getDataSource()
              .getRepository(PushNotificationDevice)
              .delete({ device_id: device.device_id });
            logger.info(`Deleted token: ${device.token}`);
          } else {
            logger.error(`Failed to send notification: ${error.message}`, {
              error
            });
            throw error;
          }
        })
      )
    );
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
    case IdentityNotificationCause.DROP_QUOTED:
      return handleDropQuoted(notification, additionalEntity);
    case IdentityNotificationCause.DROP_REPLIED:
      return handleDropReplied(notification, additionalEntity);
    case IdentityNotificationCause.DROP_VOTED:
      return handleDropVoted(notification, additionalEntity);
    default:
      return null;
  }
}

async function handleIdentitySubscribed(additionalEntity: Profile) {
  const title = `${additionalEntity.handle} is now following you`;
  const body = 'View profile';
  const imageUrl = additionalEntity.pfp_url;
  const data = {
    redirect: 'profile',
    handle: additionalEntity.normalised_handle
  };
  return { title, body, data, imageUrl };
}

async function handleIdentityMentioned(
  notification: IdentityNotificationEntity,
  additionalEntity: Profile
) {
  const userProfile = await profilesService.getProfileById(
    notification.identity_id
  );
  if (!userProfile) {
    throw new Error(`[ID ${notification.id}] User profile not found`);
  }
  const dropPartMention = await getDropPart(notification, userProfile.handle);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} mentioned you`;
  const body = dropPartMention?.content ?? 'View drop';
  const imageUrl = additionalEntity.pfp_url;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropQuoted(
  notification: IdentityNotificationEntity,
  additionalEntity: Profile
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} quoted you`;
  const imageUrl = additionalEntity.pfp_url;
  const body = dropPart?.content ?? 'View drop';
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropReplied(
  notification: IdentityNotificationEntity,
  additionalEntity: Profile
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} replied to your drop`;
  const body = dropPart?.content ?? 'View drop';
  const imageUrl = additionalEntity.pfp_url;
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function handleDropVoted(
  notification: IdentityNotificationEntity,
  additionalEntity: Profile
) {
  const vote = (notification.additional_data as any).vote;
  if (!vote) {
    throw new Error(`[ID ${notification.id}] Vote additional data not found`);
  }
  const title = `${additionalEntity.handle} rated your drop: ${
    vote > 0 ? '+' : '-'
  }${Math.abs(vote)}`;
  const imageUrl = additionalEntity.pfp_url;
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const body = dropPart?.content ?? 'View drop';
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}

async function getAdditionalIdOrThrow(
  notification: IdentityNotificationEntity
) {
  const additionalId = notification.additional_identity_id;
  if (!additionalId) {
    throw new Error(`[ID ${notification.id}] Additional id not found`);
  }
  const additionalProfile = await profilesService.getProfileById(additionalId);
  if (!additionalProfile) {
    throw new Error(`[ID ${notification.id}] Additional profile not found`);
  }
  return additionalProfile;
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

async function getDropSerialNo(dropId: string | null) {
  if (!dropId) {
    return null;
  }
  const drop = await getDataSource().getRepository(DropEntity).findOneBy({
    id: dropId
  });
  return drop?.serial_no ?? null;
}
