import { sendBadgeUpdate, sendMessages } from './sendPushNotifications';

const send = jest.fn();
const sendEach = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [{}],
  messaging: () => ({ send, sendEach })
}));

beforeEach(() => {
  send.mockReset().mockResolvedValue('message-id');
});

it.each([0, 1, 2])(
  'sends a badge-only APNs payload with exact count %s',
  async (count) => {
    await sendBadgeUpdate('ios-token', count);
    expect(send).toHaveBeenCalledWith({
      token: 'ios-token',
      apns: {
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '5',
          'apns-collapse-id': 'device-badge-refresh',
          'apns-expiration': '0'
        },
        payload: { aps: { badge: count } }
      }
    });
  }
);

it.each([-1, NaN, Infinity, 1.2])(
  'never sends invalid count %s',
  async (count) => {
    await expect(sendBadgeUpdate('ios-token', count)).rejects.toThrow(
      'Invalid device badge count'
    );
    expect(send).not.toHaveBeenCalled();
  }
);

it('propagates Firebase failure so the worker retries', async () => {
  send.mockRejectedValue(new Error('unavailable'));
  await expect(sendBadgeUpdate('ios-token', 1)).rejects.toThrow('unavailable');
});

it('omits the APNs badge rather than guessing for an unknown platform', async () => {
  sendEach.mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true }]
  });
  await sendMessages([
    {
      title: 'Hello',
      body: 'World',
      token: 'token',
      notification_id: 1,
      extra_data: {},
      omitBadge: true
    }
  ]);
  const payload = sendEach.mock.calls[0][0][0];
  expect(payload.apns.payload.aps).toEqual({ sound: 'default' });
  expect(payload.android).toEqual({ notification: { sound: 'default' } });
});
