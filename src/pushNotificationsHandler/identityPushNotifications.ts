import { logger } from 'ethers';
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

export async function sendIdentityNotification(id: number) {
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
  let title: string | undefined;
  let body: string | undefined;
  let imageUrl: string | undefined;
  let redirectType: string | undefined;
  let redirectPath: string | undefined;

  const additionalEntity = await getAdditionalIdOrThrow(notification);

  switch (notification.cause) {
    case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      title = 'New Follower';
      body = `User ${additionalEntity.handle} is now following you`;
      redirectType = 'profile';
      redirectPath = additionalEntity.normalised_handle;
      break;

    case IdentityNotificationCause.IDENTITY_MENTIONED:
      const dropPartMention = await getDropPart(
        notification,
        additionalEntity.normalised_handle
      );
      title = `${additionalEntity.handle} mentioned you`;
      body = dropPartMention?.content ?? '';
      redirectType = 'waves';
      redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;

    case IdentityNotificationCause.DROP_QUOTED:
      title = `${additionalEntity.handle} quoted you`;
      body = (await getDropPart(notification))?.content ?? '';
      redirectType = 'waves';
      redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;

    case IdentityNotificationCause.DROP_REPLIED:
      title = `${additionalEntity.handle} replied to your drop`;
      body = (await getDropPart(notification))?.content ?? '';
      redirectType = 'waves';
      redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;

    case IdentityNotificationCause.DROP_VOTED:
      const vote = (notification.additional_data as any).vote;
      if (!vote) {
        throw new Error(
          `[ID ${notification.id}] Vote additional data not found`
        );
      }
      title = `${additionalEntity.handle} rated your drop: ${
        vote > 0 ? '+' : '-'
      }${Math.abs(vote)}`;
      body = (await getDropPart(notification))?.content ?? '';
      redirectType = 'waves';
      redirectPath = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;
  }

  if (title && body) {
    return {
      title: title.replace(/@\[(.+?)\]/, '@$1'),
      body: body.replace(/@\[(.+?)\]/, '@$1'),
      imageUrl,
      redirectType,
      redirectPath
    };
  }

  return null;
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
