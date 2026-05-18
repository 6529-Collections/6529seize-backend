import * as admin from 'firebase-admin';
import {
  BatchResponse,
  Message,
  Notification,
  SendResponse
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
const FCM_BATCH_SIZE = 500;

export interface PushNotificationMessageInput {
  title: string;
  body: string;
  token: string;
  notification_id: number;
  extra_data: Record<string, string | number | null | undefined>;
  badge?: number;
  imageUrl?: string;
}

export interface PushNotificationSendResult {
  input: PushNotificationMessageInput;
  response: SendResponse;
}

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

export async function sendMessages(
  inputs: PushNotificationMessageInput[]
): Promise<PushNotificationSendResult[]> {
  init();

  const results: PushNotificationSendResult[] = [];
  for (let i = 0; i < inputs.length; i += FCM_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + FCM_BATCH_SIZE);
    const messages = chunk.map((input) => buildMessage(input, true));

    let response: BatchResponse;
    try {
      response = await admin.messaging().sendEach(messages);
    } catch (error) {
      logger.error(`Error sending notification batch: ${error}`);
      results.push(
        ...chunk.map((input) => buildFailedSendResult(input, error))
      );
      continue;
    }

    logger.info(
      `Sent notification batch: ${response.successCount} succeeded, ${response.failureCount} failed`
    );

    const retryResults = await Promise.all(
      response.responses.map((sendResponse, index) =>
        handleSendResponse(chunk[index], sendResponse)
      )
    );
    results.push(...retryResults);
  }
  return results;
}

function buildFailedSendResult(
  input: PushNotificationMessageInput,
  error: unknown
): PushNotificationSendResult {
  return {
    input,
    response: {
      success: false,
      error: error as SendResponse['error']
    }
  };
}

function buildMessage(
  input: PushNotificationMessageInput,
  includeImage: boolean
): Message {
  const title = truncatePreparedLine(
    preparePushNotificationLine(input.title) || DEFAULT_PUSH_NOTIFICATION_TITLE,
    MAX_TITLE_LENGTH
  );
  const body = truncatePreparedLine(
    preparePushNotificationLine(input.body) || DEFAULT_PUSH_NOTIFICATION_BODY,
    MAX_BODY_LENGTH
  );

  const notification: Notification = { title, body };
  if (includeImage && isFcmAcceptableImageUrl(input.imageUrl)) {
    notification.imageUrl = input.imageUrl!.trim();
  }

  return {
    notification,
    token: input.token,
    data: buildMessageData(input),
    android: {
      notification: {
        sound: 'default'
      }
    },
    apns: {
      payload: {
        aps: {
          badge: numbers.parseIntOrNull(input.badge) ?? 1,
          sound: 'default'
        }
      }
    }
  };
}

function buildMessageData(
  input: PushNotificationMessageInput
): Record<string, string> {
  const data: Record<string, string> = {
    notification_id: input.notification_id.toString()
  };
  const extraData = input.extra_data ?? {};
  for (const [key, value] of Object.entries(extraData)) {
    if (value == null) {
      continue;
    }
    data[key] = String(value);
  }
  return data;
}

function truncatePreparedLine(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return characters.slice(0, maxLength).join('');
  }
  return `${characters.slice(0, maxLength - 3).join('')}...`;
}

async function handleSendResponse(
  input: PushNotificationMessageInput,
  response: SendResponse
): Promise<PushNotificationSendResult> {
  if (response.success) {
    logger.info(`Successfully sent notification: ${response.messageId}`);
    return { input, response };
  }

  const error = response.error;
  if (input.imageUrl && error?.code === 'messaging/invalid-payload') {
    logger.info(
      `Invalid payload (e.g. imageUrl), retrying without image: ${error.message}`
    );
    return retryMessageWithoutImage(input);
  }

  logger.error(`Error sending notification: ${error}`);
  return { input, response };
}

async function retryMessageWithoutImage(
  input: PushNotificationMessageInput
): Promise<PushNotificationSendResult> {
  try {
    const messageId = await admin.messaging().send(buildMessage(input, false));
    logger.info(`Successfully sent notification without image: ${messageId}`);
    return {
      input,
      response: {
        success: true,
        messageId
      }
    };
  } catch (error: any) {
    logger.error(`Error sending notification without image: ${error}`);
    return {
      input,
      response: {
        success: false,
        error
      }
    };
  }
}
