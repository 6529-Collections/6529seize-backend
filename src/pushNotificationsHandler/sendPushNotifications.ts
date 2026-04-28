import * as admin from 'firebase-admin';
import {
  Message,
  Notification
} from 'firebase-admin/lib/messaging/messaging-api';
import { Logger } from '../logging';
import { numbers } from '../numbers';
import { emojify } from './emojify';
import { sanitizePushNotificationText } from './push-notification-text';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');

const MAX_TITLE_LENGTH = 50;
const MAX_BODY_LENGTH = 250;

const DEFAULT_PUSH_NOTIFICATION_TITLE = 'New notification';
const DEFAULT_PUSH_NOTIFICATION_BODY = 'View drop';

function preparePushNotificationLine(value: string | null | undefined): string {
  const raw = value == null ? '' : String(value);
  return emojify(
    sanitizePushNotificationText(raw).replace(/@\[(.+?)\]/g, '@$1')
  ).trim();
}

function isFcmAcceptableImageUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

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

  title = preparePushNotificationLine(title) || DEFAULT_PUSH_NOTIFICATION_TITLE;
  body = preparePushNotificationLine(body) || DEFAULT_PUSH_NOTIFICATION_BODY;

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
  if (isFcmAcceptableImageUrl(imageUrl)) {
    notification.imageUrl = imageUrl!.trim();
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
    if (imageUrl && error.code === 'messaging/invalid-payload') {
      logger.info(
        `Invalid payload (e.g. imageUrl), retrying without image: ${error.message}`
      );
      return sendMessage(title, body, token, notification_id, extra_data);
    }
    logger.error(`Error sending notification: ${error}`);
    throw error;
  }
}
