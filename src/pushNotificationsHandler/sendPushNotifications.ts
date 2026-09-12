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
import { fitPushNotificationPayload } from './push-notification-payload-budget';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');

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
  /** Preserve the existing badge when the registration platform cannot be identified. */
  omitBadge?: boolean;
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

/** A badge update has no alert, sound, feed notification, or background wakeup. */
export async function sendBadgeUpdate(
  token: string,
  count: number
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid device badge count');
  }
  init();
  await admin.messaging().send({
    token,
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-collapse-id': 'device-badge-refresh',
        // Do not store a count for later delivery to an offline device.
        'apns-expiration': '0'
      },
      payload: { aps: { badge: count } }
    }
  });
}

export async function sendMessages(
  inputs: PushNotificationMessageInput[]
): Promise<PushNotificationSendResult[]> {
  init();

  const results: PushNotificationSendResult[] = [];
  for (let i = 0; i < inputs.length; i += FCM_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + FCM_BATCH_SIZE);
    results.push(...(await sendChunk(chunk)));
  }
  return results;
}

function prepareMessage(input: PushNotificationMessageInput) {
  try {
    return { input, message: buildMessage(input, true) };
  } catch (error) {
    logger.error(`Failed to prepare push notification: ${error}`);
    return { input, result: buildFailedSendResult(input, error) };
  }
}

async function sendChunk(
  chunk: PushNotificationMessageInput[]
): Promise<PushNotificationSendResult[]> {
  const prepared = chunk.map(prepareMessage);
  const sendable = prepared.filter(
    (item): item is { input: PushNotificationMessageInput; message: Message } =>
      item.message !== undefined
  );
  const sent = await sendPreparedMessages(sendable);
  let next = 0;
  return prepared.map((item) => item.result ?? sent[next++]);
}

async function sendPreparedMessages(
  prepared: { input: PushNotificationMessageInput; message: Message }[]
): Promise<PushNotificationSendResult[]> {
  if (prepared.length === 0) return [];

  let response: BatchResponse;
  try {
    response = await admin
      .messaging()
      .sendEach(prepared.map((item) => item.message));
  } catch (error) {
    logger.error(`Error sending notification batch: ${error}`);
    return prepared.map(({ input }) => buildFailedSendResult(input, error));
  }

  logger.info(
    `Sent notification batch: ${response.successCount} succeeded, ${response.failureCount} failed`
  );

  return await Promise.all(
    response.responses.map((sendResponse, index) =>
      handleSendResponse(prepared[index].input, sendResponse)
    )
  );
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
  const title =
    preparePushNotificationLine(input.title) || DEFAULT_PUSH_NOTIFICATION_TITLE;
  const body =
    preparePushNotificationLine(input.body) || DEFAULT_PUSH_NOTIFICATION_BODY;

  const notification: Notification = { title, body };
  if (includeImage && isFcmAcceptableImageUrl(input.imageUrl)) {
    notification.imageUrl = input.imageUrl!.trim();
  }

  const data = buildMessageData(input);
  const targetProfileId = data.target_profile_id;
  // Android's delivered-notification API exposes the native tag, but may omit
  // FCM custom data. Keep profile/read identity available without a native update.
  const tag = targetProfileId
    ? `6529:v1:${encodeURIComponent(targetProfileId)}:${data.notification_id}:${encodeURIComponent(data.wave_id ?? '')}`
    : undefined;
  return fitPushNotificationPayload({
    notification,
    token: input.token,
    data,
    android: {
      notification: {
        sound: 'default',
        ...(tag ? { tag } : {})
      }
    },
    apns: {
      payload: {
        aps: {
          ...(input.omitBadge
            ? {}
            : { badge: numbers.parseIntOrNull(input.badge) ?? 1 }),
          sound: 'default'
        }
      }
    }
  });
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
