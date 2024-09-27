import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import * as admin from 'firebase-admin';
import { Message } from 'firebase-admin/lib/messaging/messaging-api';
import { getDataSource } from '../db';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '../entities/IIdentityNotification';
import { profilesService } from '../profiles/profiles.service';
import { DropPartEntity } from '../entities/IDrop';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { Like } from 'typeorm';
import { SQSHandler } from 'aws-lambda';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER');

function init() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    if (!projectId || !privateKey || !clientEmail) {
      throw new Error('MISSING FIREBASE CREDENTIALS');
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        privateKey,
        clientEmail
      })
    });
  }
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      init();
      await Promise.all(
        event.Records.map(async (record) => {
          const messageBody = record.body;
          await processNotification(messageBody);
        })
      );
    },
    {
      logger,
      entities: [
        IdentityNotificationEntity,
        PushNotificationDevice,
        DropPartEntity
      ]
    }
  );
};

const processNotification = async (messageBody: string) => {
  const notification = JSON.parse(messageBody);
  if (notification.identity_id) {
    await sendIdentityNotification(notification.identity_id);
  }
};

async function sendIdentityNotification(id: number) {
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

  async function getAdditionalIdOrThrow(
    notification: IdentityNotificationEntity
  ) {
    const mentionedById = notification.additional_identity_id;
    if (!mentionedById) {
      throw new Error(
        `[ID ${notification.id}] Mentioned by id not found ${mentionedById}`
      );
    }
    const mentionedBy = await profilesService.getProfileById(mentionedById);
    if (!mentionedBy) {
      throw new Error(
        `[ID ${notification.id}] Mentioned by not found ${mentionedById}`
      );
    }
    return mentionedBy;
  }

  function getDropPart(
    notification: IdentityNotificationEntity,
    handle?: string
  ) {
    const dropId = notification.related_drop_id;
    if (!dropId) {
      throw new Error(`[ID ${notification.id}] Drop id not found ${dropId}`);
    }
    const query: any = {
      drop_id: dropId
    };
    if (handle) {
      query['content'] = Like(`%@[${handle}]%`);
    }
    return getDataSource().getRepository(DropPartEntity).findOneBy(query);
  }

  let title: string | undefined;
  let body: string | undefined;
  let imageUrl: string | undefined;
  let redirect_type: string | undefined;
  let redirect_path: string | undefined;

  switch (notification.cause) {
    case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      const follower = await getAdditionalIdOrThrow(notification);
      title = 'New Follower';
      body = `User ${follower.handle} is now following you`;
      redirect_path = 'profile';
      redirect_path = follower.normalised_handle;
      break;
    case IdentityNotificationCause.IDENTITY_MENTIONED:
      const userProfile = await profilesService.getProfileById(
        notification.identity_id
      );
      if (!userProfile) {
        throw new Error(
          `[ID ${notification.id}] Mentioned User not found ${notification.identity_id}`
        );
      }

      const mentionedBy = await getAdditionalIdOrThrow(notification);

      title = `${mentionedBy.handle} mentioned you`;
      const dropPartMention = await getDropPart(
        notification,
        userProfile.normalised_handle
      );
      if (dropPartMention) {
        body = dropPartMention.content ?? '';
      }
      redirect_type = 'waves';
      redirect_path = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;
    case IdentityNotificationCause.DROP_QUOTED:
      const quotedBy = await getAdditionalIdOrThrow(notification);
      title = `${quotedBy.handle} quoted you`;
      const dropPartQuote = await getDropPart(notification);
      if (dropPartQuote) {
        body = dropPartQuote.content ?? '';
      }
      redirect_type = 'waves';
      redirect_path = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;
    case IdentityNotificationCause.DROP_REPLIED:
      const repliedBy = await getAdditionalIdOrThrow(notification);
      title = `${repliedBy.handle} replied to your drop`;
      const dropPartReply = await getDropPart(notification);
      if (dropPartReply) {
        body = dropPartReply.content ?? '';
      }
      redirect_type = 'waves';
      redirect_path = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;
    case IdentityNotificationCause.DROP_VOTED:
      const votedBy = await getAdditionalIdOrThrow(notification);
      console.log('i am notification', notification);
      const vote = (notification.additional_data as any).vote;
      if (!vote) {
        throw new Error(
          `[ID ${notification.id}] Vote additional data not found ${notification.additional_data}`
        );
      }
      title = `${votedBy.handle} rated your drop: ${
        vote > 0 ? `+` : `-`
      }${Math.abs(vote)}`;
      const dropPartVote = await getDropPart(notification);
      if (dropPartVote) {
        body = dropPartVote.content ?? '';
      }
      redirect_type = 'waves';
      redirect_path = `${notification.wave_id}?drop=${notification.related_drop_id}`;
      break;
  }

  if (title && body) {
    title = title.replace(/@\[(.+?)\]/, '@$1');
    body = body.replace(/@\[(.+?)\]/, '@$1');

    await sendMessage(
      title,
      body,
      token,
      imageUrl,
      redirect_type,
      redirect_path
    );
  }
}

async function sendMessage(
  title: string,
  body: string,
  token: string,
  imageUrl?: string,
  redirect_type?: string,
  redirect_path?: string
) {
  const message: Message = {
    notification: {
      title,
      body,
      imageUrl
    },
    token
  };

  const data: any = {};
  if (redirect_type) {
    data.redirect_type = redirect_type;
  }
  if (redirect_path) {
    data.redirect_path = redirect_path;
  }
  message.data = data;

  const response = await admin.messaging().send(message);
  logger.info(`Successfully sent notification: ${response}`);
}

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
