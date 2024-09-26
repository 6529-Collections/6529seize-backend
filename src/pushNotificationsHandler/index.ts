import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import * as admin from 'firebase-admin';

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

interface NotificationPayload {
  token: string;
  notification: {
    title: string;
    body: string;
  };
  data?: {
    redirectUrl: string;
  };
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      init();
      await sendMessage();
    },
    { logger, entities: [] }
  );
});

async function sendMessage() {
  const message: NotificationPayload = {
    notification: {
      title: 'Local Test',
      body: 'This should take you to /6529-gradient'
    },
    data: {
      redirectUrl: '/6529-gradient'
    },
    token:
      'fEMuW-umr0mfghPULbN_eF:APA91bHPOaWUuX0Tw0jhhuvKTTFOhQVZHj-S-hXtJ0xTZOsE-wowCwXCht4rGA0oO73QcpxK3uxr3_0HhaMAhLuEmKCvkiwK2832Usf4ZAPhbGprALgsO2NScysLXqjLKOvPkkGxXi6n'
  };

  try {
    const response = await admin.messaging().send(message);
    logger.info('Successfully sent notification:', response);
  } catch (error: any) {
    logger.error('Error sending notification:', error);
    throw new Error(`Failed to send notification: ${error.message}`);
  }
}
