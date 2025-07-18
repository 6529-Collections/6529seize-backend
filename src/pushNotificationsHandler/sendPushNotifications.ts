import * as admin from 'firebase-admin';
import {
  Message,
  Notification
} from 'firebase-admin/lib/messaging/messaging-api';
import { Logger } from '../logging';
import { numbers } from '../numbers';
import { emojify } from './emojify';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');

const MAX_TITLE_LENGTH = 50;
const MAX_BODY_LENGTH = 250;

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

export async function sendMessage(
  title: string,
  body: string,
  token: string,
  notification_id: number,
  extra_data: any,
  badge?: number,
  imageUrl?: string
) {
  init();
  title = emojify(title.replace(/@\[(.+?)\]/g, '@$1'));
  body = emojify(body.replace(/@\[(.+?)\]/g, '@$1'));

  const badgeNumber = numbers.parseIntOrNull(badge) ?? 1;

  if (title.length > MAX_TITLE_LENGTH) {
    title = title.substring(0, MAX_TITLE_LENGTH) + '...';
  }

  if (body.length > MAX_BODY_LENGTH) {
    body = body.substring(0, MAX_BODY_LENGTH) + '...';
  }

  const notification: Notification = {
    title,
    body
  };
  if (imageUrl) {
    notification.imageUrl = imageUrl;
  }

  const data: any = {
    notification_id: notification_id.toString(),
    ...extra_data
  };

  const message: Message = {
    notification,
    token,
    data,
    android: {
      notification: {
        sound: 'default'
      }
    },
    apns: {
      payload: {
        aps: {
          badge: badgeNumber,
          sound: 'default'
        }
      }
    }
  };

  try {
    const response = await admin.messaging().send(message);
    logger.info(`Successfully sent notification: ${response}`);
  } catch (error: any) {
    // if the error is invalid payload and we have imageUrl, try to resend without it
    if (imageUrl && error.code === 'messaging/invalid-payload') {
      logger.info('Invalid payload, trying to resend without imageUrl');
      return sendMessage(title, body, token, notification_id, extra_data);
    }

    throw error;
  }
}
