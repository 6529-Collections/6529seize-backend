import {
  Message,
  Notification
} from 'firebase-admin/lib/messaging/messaging-api';

// FCM device messages and APNs payloads allow 4096 bytes. Count the serialized
// application envelope conservatively, reserving 512 bytes for provider-added
// keys/platform translation. The recipient token is transport, not payload.
const APPLICATION_PAYLOAD_BUDGET_BYTES = 4096 - 512;
const ELLIPSIS = '...';
const ELLIPSIS_BYTES = jsonTextBytes(ELLIPSIS);

type NotificationMessage = Message & { notification: Notification };

function payloadBytes(message: NotificationMessage): number {
  return Buffer.byteLength(JSON.stringify({ ...message, token: undefined }));
}

function jsonTextBytes(text: string): number {
  // The envelope already counts the empty string's two surrounding quotes.
  // Only the escaped content adds bytes when that field is filled in.
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

function fitText(text: string, budget: number): string {
  if (jsonTextBytes(text) <= budget) return text;

  let bytes = ELLIPSIS_BYTES;
  const prefix: string[] = [];
  for (const character of Array.from(text)) {
    const characterBytes = jsonTextBytes(character);
    if (bytes + characterBytes > budget) break;
    prefix.push(character);
    bytes += characterBytes;
  }
  return prefix.join('') + ELLIPSIS;
}

/**
 * Mutate this freshly built message's visible text/image to fit the budget.
 * Routing data, badge, and sound settings are unchanged, including on failure.
 */
export function fitPushNotificationPayload(
  message: NotificationMessage
): Message {
  if (payloadBytes(message) <= APPLICATION_PAYLOAD_BUDGET_BYTES) return message;

  const notification = message.notification;
  const title = notification.title ?? '';
  const body = notification.body ?? '';
  notification.title = fitText(title, ELLIPSIS_BYTES);
  notification.body = fitText(body, ELLIPSIS_BYTES);

  // An optional oversized image must not prevent delivery of the text.
  if (payloadBytes(message) > APPLICATION_PAYLOAD_BUDGET_BYTES) {
    delete notification.imageUrl;
  }
  if (payloadBytes(message) > APPLICATION_PAYLOAD_BUDGET_BYTES) {
    throw Object.assign(
      new Error('Push notification metadata exceeds the payload budget'),
      { code: 'messaging/payload-size-limit-exceeded' }
    );
  }

  // Keep the full title whenever possible; shorten the body first. Only an
  // unusually large title needs trimming to leave space for the body marker.
  notification.title = '';
  notification.title = fitText(
    title,
    APPLICATION_PAYLOAD_BUDGET_BYTES - payloadBytes(message)
  );
  notification.body = '';
  notification.body = fitText(
    body,
    APPLICATION_PAYLOAD_BUDGET_BYTES - payloadBytes(message)
  );
  return message;
}
