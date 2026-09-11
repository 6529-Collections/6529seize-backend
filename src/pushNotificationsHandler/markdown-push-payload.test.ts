import * as admin from 'firebase-admin';
import { formatDropMarkdownForPush } from '@/pushNotificationsHandler/markdown-push-notification-text';
import { sendMessages } from '@/pushNotificationsHandler/sendPushNotifications';

jest.mock('firebase-admin', () => ({
  apps: [{}],
  messaging: jest.fn()
}));

jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), error: jest.fn() }) }
}));

describe('Markdown push payload', () => {
  const sendEach = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (admin.messaging as jest.Mock).mockReturnValue({ sendEach });
    sendEach.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'test-message' }]
    });
  });

  it('sends readable text before the length limit while retaining title and routing', async () => {
    const text =
      '# Heading\n\n**Hello** @[prxt0] :wave: ' + '**👋**'.repeat(260);
    const body = formatDropMarkdownForPush(text);
    await sendMessages([
      {
        title: '[prxt0] snake_case messaged you · DM',
        body,
        token: 'test-token',
        notification_id: 123,
        extra_data: { wave_id: 'test-wave', redirect: 'waves' },
        badge: 2
      }
    ]);

    const message = sendEach.mock.calls[0][0][0];
    const expectedText = 'Heading\nHello @prxt0 👋 ' + '👋'.repeat(260);
    expect(message.notification).toEqual({
      title: '[prxt0] snake_case messaged you · DM',
      body: Array.from(expectedText).slice(0, 247).join('') + '...'
    });
    expect(Array.from(message.notification.body)).toHaveLength(250);
    expect(message.data).toEqual({
      notification_id: '123',
      wave_id: 'test-wave',
      redirect: 'waves'
    });
    expect(message.apns.payload.aps.badge).toBe(2);
    expect(text).toContain('**Hello**');
  });

  it('retains the default body when formatting leaves no preview text', async () => {
    await sendMessages([
      {
        title: 'New message',
        body: formatDropMarkdownForPush('#\n\n---'),
        token: 'test-token',
        notification_id: 124,
        extra_data: {}
      }
    ]);
    expect(sendEach.mock.calls[0][0][0].notification.body).toBe('View drop');
  });
});
