import { Like } from 'typeorm';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { ApiIdentity } from '../api-serverless/src/generated/models/ApiIdentity';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import { getDataSource } from '../db';
import { DropEntity, DropPartEntity } from '../entities/IDrop';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { WaveEntity } from '../entities/IWave';
import { WaveReaderMetricEntity } from '../entities/IWaveReaderMetric';
import { Logger } from '../logging';
import { IdentityNotificationsDb } from '../notifications/identity-notifications.db';
import { dbSupplier } from '../sql-executor';
import { sendMessage } from './sendPushNotifications';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');

const identityNotificationsDb = new IdentityNotificationsDb(dbSupplier);

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

  const notificationData = await generateNotificationData(notification);
  if (notificationData) {
    const { title, body, data, imageUrl } = notificationData;

    const eligibleGroupIds = await userGroupsService.getGroupsUserIsEligibleFor(
      notification.identity_id
    );
    const badge =
      await identityNotificationsDb.countUnreadNotificationsForIdentity(
        notification.identity_id,
        eligibleGroupIds
      );

    await Promise.all(
      userDevices.map((device) =>
        sendMessage(
          title,
          body,
          device.token,
          notification.id,
          data,
          badge,
          imageUrl ?? undefined
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
  const body = dropPartMention?.content ?? 'View drop';
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
  additionalEntity: ApiIdentity
) {
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const title = `${additionalEntity.handle} replied to your drop`;
  const body = dropPart?.content ?? 'View drop';
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
  const body = dropPart?.content ?? 'View drop';
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
  const body = dropPart?.content ?? 'View drop';
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
  const title = `${additionalEntity.handle} boosted your drop`;
  const imageUrl = additionalEntity.pfp;
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
  const additionalProfile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      {
        identityKey: additionalId
      },
      {}
    );
  if (!additionalProfile?.id) {
    throw new Error(`[ID ${notification.id}] Additional profile not found`);
  }
  return additionalProfile;
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

  const title = `${additionalEntity.handle} invited you to a wave: ${wave.name}`;
  const body = 'View wave';
  const imageUrl = wave.picture ?? undefined;
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

async function handleAllDrops(
  notification: IdentityNotificationEntity,
  additionalEntity: ApiIdentity
) {
  const wave = await getWaveEntityOrThrow(
    notification.id,
    notification.wave_id
  );
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

  title += ` in ${wave.name}`;

  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = wave.picture ?? additionalEntity.pfp;
  const body = dropPart?.content ?? 'View drop';
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

  const drop = await getDrop(notification);
  const dropPart = await getDropPart(notification);
  const dropSerialNo = await getDropSerialNo(notification.related_drop_id);
  const imageUrl = wave.picture ?? additionalEntity.pfp;
  const title = `🚨 ${drop?.title ?? 'Priority Alert'}`;
  const body = dropPart?.content ?? 'View alert';
  const data = {
    redirect: 'waves',
    wave_id: notification.wave_id,
    drop_id: dropSerialNo
  };
  return { title, body, data, imageUrl };
}
