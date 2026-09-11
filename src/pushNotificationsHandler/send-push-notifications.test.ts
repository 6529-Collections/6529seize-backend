import * as admin from 'firebase-admin';
import { Message } from 'firebase-admin/lib/messaging/messaging-api';
import {
  PushNotificationMessageInput,
  sendMessages
} from '@/pushNotificationsHandler/sendPushNotifications';

jest.mock('firebase-admin', () => ({ apps: [{}], messaging: jest.fn() }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), error: jest.fn() }) }
}));

function input(
  id: number,
  extra: Partial<PushNotificationMessageInput> = {}
): PushNotificationMessageInput {
  return {
    title: 'Message',
    body: 'Hello',
    token: `token-${id}`,
    notification_id: id,
    extra_data: {},
    ...extra
  };
}

describe('sending budgeted push messages', () => {
  const sendEach = jest.fn();
  const send = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    (admin.messaging as jest.Mock).mockReturnValue({ sendEach, send });
    sendEach.mockImplementation(async (messages: Message[]) => ({
      successCount: messages.length,
      failureCount: 0,
      responses: messages.map((_, index) => ({
        success: true,
        messageId: `sent-${index}`
      }))
    }));
  });

  it('isolates oversized metadata and returns results in the original input order', async () => {
    const inputs = [
      input(1),
      input(2, { extra_data: { redirect: 'x'.repeat(4096) } }),
      input(3)
    ];
    const results = await sendMessages(inputs);
    expect(
      sendEach.mock.calls[0][0].map(
        (message: Message) => message.data?.notification_id
      )
    ).toEqual(['1', '3']);
    expect(results.map((result) => result.input)).toEqual(inputs);
    expect(results.map((result) => result.response.success)).toEqual([
      true,
      false,
      true
    ]);
    expect(results[1].response.error?.code).toBe(
      'messaging/payload-size-limit-exceeded'
    );
    expect(results[2].response.messageId).toBe('sent-1');
  });

  it('does not call Firebase when no messages fit', async () => {
    const results = await sendMessages([
      input(1, { extra_data: { redirect: 'x'.repeat(4096) } })
    ]);
    expect(sendEach).not.toHaveBeenCalled();
    expect(results[0].response.success).toBe(false);
  });

  it('preserves per-input failures when a sendable batch also fails', async () => {
    const networkError = new Error('network unavailable');
    sendEach.mockRejectedValue(networkError);
    const results = await sendMessages([
      input(1),
      input(2, { extra_data: { redirect: 'x'.repeat(4096) } }),
      input(3)
    ]);
    expect(results.map((result) => result.response.success)).toEqual([
      false,
      false,
      false
    ]);
    expect(results[0].response.error).toBe(networkError);
    expect(results[1].response.error?.code).toBe(
      'messaging/payload-size-limit-exceeded'
    );
    expect(results[2].response.error).toBe(networkError);
  });

  it('budgets image retries again and preserves both platform settings', async () => {
    sendEach.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: { code: 'messaging/invalid-payload' } }
      ]
    });
    send.mockResolvedValue('retry-success');
    const results = await sendMessages([
      input(1, {
        body: '👋'.repeat(5000),
        imageUrl: 'https://example.com/image.jpg',
        badge: 3,
        extra_data: { target_profile_id: 'profile:A', wave_id: 'wave/1' }
      })
    ]);
    const initial = sendEach.mock.calls[0][0][0];
    const retry = send.mock.calls[0][0];
    for (const message of [initial, retry]) {
      expect(
        Buffer.byteLength(JSON.stringify({ ...message, token: undefined }))
      ).toBeLessThanOrEqual(3584);
      expect(message.android.notification.sound).toBe('default');
      expect(message.android.notification.tag).toBe(
        '6529:v1:profile%3AA:1:wave%2F1'
      );
      expect(message.apns.payload.aps).toEqual({ badge: 3, sound: 'default' });
      expect(message.data).toEqual({
        notification_id: '1',
        target_profile_id: 'profile:A',
        wave_id: 'wave/1'
      });
    }
    expect(initial.notification.imageUrl).toBeDefined();
    expect(retry.notification.imageUrl).toBeUndefined();
    expect(retry.notification.body.length).toBeGreaterThan(
      initial.notification.body.length
    );
    expect(results[0].response).toEqual({
      success: true,
      messageId: 'retry-success'
    });
  });

  it('retains the 500-message batch limit and input/result mapping', async () => {
    const inputs = Array.from({ length: 501 }, (_, index) => input(index));
    const results = await sendMessages(inputs);
    expect(sendEach.mock.calls.map(([messages]) => messages.length)).toEqual([
      500, 1
    ]);
    expect(results.map((result) => result.input)).toEqual(inputs);
    expect(results.every((result) => result.response.success)).toBe(true);
  });
});
