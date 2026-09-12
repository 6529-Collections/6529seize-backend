import { sendBadgeUpdate, sendMessages } from './sendPushNotifications';

const send = jest.fn();
const sendEach = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [{}],
  messaging: () => ({ send, sendEach })
}));

beforeEach(() => {
  send.mockReset().mockResolvedValue('message-id');
  sendEach.mockReset().mockResolvedValue({
    successCount: 1,
    failureCount: 0,
    responses: [{ success: true }]
  });
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

it('tags Android notifications with the payload profile, notification and wave identity', async () => {
  await sendMessages([
    {
      title: 'Hello',
      body: 'World',
      token: 'token',
      notification_id: 42,
      extra_data: { target_profile_id: 'profile:A', wave_id: 'wave/1' }
    }
  ]);
  expect(sendEach.mock.calls[0][0][0].android.notification).toEqual({
    sound: 'default',
    tag: '6529:v1:profile%3AA:42:wave%2F1'
  });
});

it('keeps two profiles separate even when their Android native notification IDs coincide', async () => {
  await sendMessages(
    ['A', 'B'].map((profile) => ({
      title: 'Hello',
      body: 'World',
      token: 'token',
      notification_id: 42,
      extra_data: { target_profile_id: profile }
    }))
  );
  expect(
    sendEach.mock.calls[0][0].map(
      (message: { android: { notification: { tag: string } } }) =>
        message.android.notification.tag
    )
  ).toEqual(['6529:v1:A:42:', '6529:v1:B:42:']);
});

it.each([false, true])(
  'preserves profile identity and badge policy while fitting oversized previews, omitBadge=%s',
  async (omitBadge) => {
    const body = 'Large notification preview '.repeat(1000);
    await sendMessages([
      {
        title: 'Hello',
        body,
        token: 'token',
        notification_id: 42,
        extra_data: { target_profile_id: 'profile:A', wave_id: 'wave/1' },
        badge: 2,
        omitBadge
      }
    ]);
    const message = sendEach.mock.calls[0][0][0];
    expect(message.notification.body.length).toBeLessThan(body.length);
    expect(message.android.notification).toEqual({
      sound: 'default',
      tag: '6529:v1:profile%3AA:42:wave%2F1'
    });
    expect(message.data).toEqual({
      notification_id: '42',
      target_profile_id: 'profile:A',
      wave_id: 'wave/1'
    });
    expect(message.apns.payload.aps).toEqual(
      omitBadge ? { sound: 'default' } : { badge: 2, sound: 'default' }
    );
    const { token: _token, ...payload } = message;
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
      3584
    );
  }
);
