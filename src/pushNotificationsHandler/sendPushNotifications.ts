import * as admin from 'firebase-admin';
import { Message } from 'firebase-admin/lib/messaging/messaging-api';
import { Logger } from '../logging';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');

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
  imageUrl?: string
) {
  init();
  title = title.replace(/@\[(.+?)\]/, '@$1');
  body = body.replace(/@\[(.+?)\]/, '@$1');

  logger.info(`Sending notification with imageUrl: ${imageUrl}`);

  const message: Message = {
    notification: {
      title,
      body,
      imageUrl
    },
    token
  };

  const data: any = {
    notification_id,
    ...extra_data
  };
  message.data = data;

  const response = await admin.messaging().send(message);
  logger.info(`Successfully sent notification: ${response}`);
}
