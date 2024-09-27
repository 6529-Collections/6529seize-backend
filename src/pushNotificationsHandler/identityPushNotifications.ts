import { Like } from 'typeorm';
import { getDataSource } from '../db';
import { DropPartEntity } from '../entities/IDrop';
import {
  IdentityNotificationEntity,
  IdentityNotificationCause
} from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { profilesService } from '../profiles/profiles.service';
import { sendMessage } from './sendPushNotifications';
import { Logger } from '../logging';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');

export async function sendIdentityNotification(id: number) {
  logger.info(`Sending identity notification: ${id}`);

  const notification = await getDataSource()
    .getRepository(IdentityNotificationEntity)
    .findOneBy({ id });
  if (!notification) {
    throw new Error(`Notification not found: ${id}`);
  }

  const userDevice = await getDataSource()
    .getRepository(PushNotificationDevice)
    .findOneBy({
      profile_id: notification.identity_id
    });

  if (!userDevice?.token) {
    logger.info(
      `[ID ${notification.id}] No device token found for user ${notification.identity_id}`
    );
    return;
  }

  const token = userDevice.token;

  const notificationData = await generateNotificationData(notification);
  if (notificationData) {
    const { title, body, imageUrl, redirectType, redirectPath } =
      notificationData;
    await sendMessage(title, body, token, imageUrl, redirectType, redirectPath);
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

async function handleIdentitySubscribed(additionalEntity: any) {
  const title = `${additionalEntity.handle} is now following you`;
  const body = 'View profile';
  const redirectType = 'profile';
  const redirectPath = additionalEntity.normalised_handle;
  return { title, body, imageUrl: undefined, redirectType, redirectPath };
}

async function handleIdentityMentioned(
  notification: IdentityNotificationEntity,
  additionalEntity: any
) {
  const dropPartMention = await getDropPart(
    notification,
    additionalEntity.normalised_handle
  );
  const title = `${additionalEntity.handle} mentioned you`;
  const body = dropPartMention?.content ?? 'View drop';
  const redirectType = 'waves';
  const redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
  return { title, body, imageUrl: undefined, redirectType, redirectPath };
}

async function handleDropQuoted(
  notification: IdentityNotificationEntity,
  additionalEntity: any
) {
  const dropPart = await getDropPart(notification);
  const title = `${additionalEntity.handle} quoted you`;
  const body = dropPart?.content ?? 'View drop';
  const redirectType = 'waves';
  const redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
  return { title, body, imageUrl: undefined, redirectType, redirectPath };
}

async function handleDropReplied(
  notification: IdentityNotificationEntity,
  additionalEntity: any
) {
  const dropPart = await getDropPart(notification);
  const title = `${additionalEntity.handle} replied to your drop`;
  const body = dropPart?.content ?? 'View drop';
  const redirectType = 'waves';
  const redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
  return { title, body, imageUrl: undefined, redirectType, redirectPath };
}

async function handleDropVoted(
  notification: IdentityNotificationEntity,
  additionalEntity: any
) {
  const vote = (notification.additional_data as any).vote;
  if (!vote) {
    throw new Error(`[ID ${notification.id}] Vote additional data not found`);
  }
  const title = `${additionalEntity.handle} rated your drop: ${
    vote > 0 ? '+' : '-'
  }${Math.abs(vote)}`;
  const dropPart = await getDropPart(notification);
  const body = dropPart?.content ?? 'View drop';
  const redirectType = 'waves';
  const redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
  return { title, body, imageUrl: undefined, redirectType, redirectPath };
}

async function getAdditionalIdOrThrow(
  notification: IdentityNotificationEntity
) {
  const mentionedById = notification.additional_identity_id;
  if (!mentionedById) {
    throw new Error(`[ID ${notification.id}] Mentioned by id not found`);
  }
  const mentionedBy = await profilesService.getProfileById(mentionedById);
  if (!mentionedBy) {
    throw new Error(`[ID ${notification.id}] Mentioned by not found`);
  }
  return mentionedBy;
}

function getDropPart(
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
