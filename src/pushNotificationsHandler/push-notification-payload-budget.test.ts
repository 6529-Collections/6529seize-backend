import { Message } from 'firebase-admin/lib/messaging/messaging-api';
import { fitPushNotificationPayload } from '@/pushNotificationsHandler/push-notification-payload-budget';

const BUDGET = 3584;

function makeMessage(body: string, title = 'New message') {
  return {
    token: 'test-token',
    notification: { title, body },
    data: { notification_id: '123', wave_id: 'test-wave' },
    android: { notification: { sound: 'default' } },
    apns: { payload: { aps: { badge: 2, sound: 'default' } } }
  };
}

function size(message: Message): number {
  return Buffer.byteLength(JSON.stringify({ ...message, token: undefined }));
}

describe('push notification payload budget', () => {
  it.each([-1, 0, 1])(
    'handles an ASCII payload at budget %+i bytes',
    (delta) => {
      const message = makeMessage('');
      const body = 'a'.repeat(BUDGET - size(message) + delta);
      message.notification.body = body;

      const fitted = fitPushNotificationPayload(message);

      expect(size(fitted)).toBeLessThanOrEqual(BUDGET);
      expect(fitted.notification?.body).toBe(
        delta <= 0 ? body : body.slice(0, -4) + '...'
      );
      expect(size(fitted)).toBe(delta <= 0 ? BUDGET + delta : BUDGET);
    }
  );

  it.each(['👋', '界', '"', '\\', '\n', '\u0000'])(
    'counts UTF-8 and JSON escaping for %j without splitting code points',
    (character) => {
      const body = character.repeat(5000);
      const message = makeMessage(body);
      const originalData = { ...message.data };
      const fitted = fitPushNotificationPayload(message);
      const preview = fitted.notification!.body!;

      expect(size(fitted)).toBeLessThanOrEqual(BUDGET);
      expect(preview.endsWith('...')).toBe(true);
      expect(preview.slice(0, -3)).toBe(
        character.repeat(Array.from(preview).length - 3)
      );
      expect(
        size({
          ...message,
          notification: {
            ...message.notification,
            body: preview.slice(0, -3) + character + '...'
          }
        })
      ).toBeGreaterThan(BUDGET);
      expect(fitted.data).toEqual(originalData);
      expect(fitted.android).toEqual({ notification: { sound: 'default' } });
      expect(fitted.apns).toEqual({
        payload: { aps: { badge: 2, sound: 'default' } }
      });
    }
  );

  it('preserves titles beyond 50 characters and bodies beyond 250 when they fit', () => {
    const message = makeMessage('body '.repeat(200), 'title '.repeat(30));
    const before = JSON.stringify(message);
    expect(JSON.stringify(fitPushNotificationPayload(message))).toBe(before);
  });

  it('accounts for metadata and image URLs without truncating either', () => {
    const plain = makeMessage('x'.repeat(5000));
    const rich = {
      ...makeMessage(plain.notification.body),
      notification: {
        ...plain.notification,
        imageUrl: 'https://example.com/image.jpg'
      },
      data: { ...plain.data, extra: '界'.repeat(200) }
    };
    fitPushNotificationPayload(plain);
    fitPushNotificationPayload(rich);
    expect(rich.notification.body.length).toBeLessThan(
      plain.notification.body.length
    );
    expect(rich.notification.imageUrl).toBe('https://example.com/image.jpg');
    expect(rich.data.extra).toBe('界'.repeat(200));
    expect(size(rich)).toBe(BUDGET);
  });

  it('trims an oversized title and uses the remaining bytes for the body', () => {
    const fitted = fitPushNotificationPayload(
      makeMessage('long body', '界'.repeat(5000))
    );
    expect(fitted.notification?.title?.endsWith('...')).toBe(true);
    expect(fitted.notification?.body).toBe('lo...');
    expect(size(fitted)).toBeLessThanOrEqual(BUDGET);
  });

  it('drops an image that cannot fit even with minimal text, retaining the text', () => {
    const message = {
      ...makeMessage('Hello'),
      notification: {
        title: 'Title',
        body: 'Hello',
        imageUrl: 'https://example.com/' + 'x'.repeat(5000)
      }
    };
    expect(fitPushNotificationPayload(message).notification).toEqual({
      title: 'Title',
      body: 'Hello'
    });
  });

  it('rejects metadata that cannot fit without silently damaging routing data', () => {
    const message = {
      ...makeMessage('Hello'),
      data: { redirect: 'x'.repeat(4096) }
    };
    expect(() => fitPushNotificationPayload(message)).toThrow(
      'metadata exceeds'
    );
    expect(message.data.redirect).toHaveLength(4096);
  });

  it('excludes the recipient token from the delivered payload budget', () => {
    const message = { ...makeMessage('Hello'), token: 'x'.repeat(5000) };
    expect(fitPushNotificationPayload(message).notification?.body).toBe(
      'Hello'
    );
    expect(message.token).toHaveLength(5000);
  });
});
