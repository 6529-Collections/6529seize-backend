import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import * as admin from 'firebase-admin';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { DropPartEntity } from '../entities/IDrop';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { SQSHandler } from 'aws-lambda';
import { sendIdentityNotification } from './identityPushNotifications';

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

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
