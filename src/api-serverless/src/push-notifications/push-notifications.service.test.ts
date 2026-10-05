const sendMock = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({
    send: sendMock
  })),
  SendMessageBatchCommand: jest.fn().mockImplementation((params) => params)
}));

jest.mock('../../../logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      error: jest.fn()
    })
  }
}));

describe('sendIdentityPushNotifications', () => {
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
  });

  it('deduplicates notification ids before batching', async () => {
    const { sendIdentityPushNotifications } =
      await import('./push-notifications.service');

    await sendIdentityPushNotifications([101, 101, 202]);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].Entries).toEqual([
      {
        Id: 'identity-notification-101',
        MessageBody: JSON.stringify({
          identity_notification_id: 101
        })
      },
      {
        Id: 'identity-notification-202',
        MessageBody: JSON.stringify({
          identity_notification_id: 202
        })
      }
    ]);
  });

  it('continues sending later chunks when one chunk fails', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce({});
    const { sendIdentityPushNotifications } =
      await import('./push-notifications.service');

    await sendIdentityPushNotifications([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][0].Entries).toHaveLength(10);
    expect(sendMock.mock.calls[1][0].Entries).toEqual([
      {
        Id: 'identity-notification-11',
        MessageBody: JSON.stringify({
          identity_notification_id: 11
        })
      }
    ]);
  });
});

describe('requestDeviceBadgeRefresh', () => {
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });
  afterEach(() => {
    delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
  });

  it('queues only the profile id, never a precomputed count', async () => {
    const { requestDeviceBadgeRefresh } =
      await import('./push-notifications.service');
    await requestDeviceBadgeRefresh('profile-a');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Entries: [
          {
            Id: 'badge-refresh',
            MessageBody: JSON.stringify({
              type: 'badge_refresh',
              profile_id: 'profile-a'
            })
          }
        ]
      })
    );
  });
  it('skips enqueue when push delivery is disabled', async () => {
    delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
    const { requestDeviceBadgeRefresh } =
      await import('./push-notifications.service');
    await requestDeviceBadgeRefresh('profile-a');
    expect(sendMock).not.toHaveBeenCalled();
  });
  it.each(['transport', 'partial batch'])(
    'does not fail an already persisted read on %s failure',
    async (failure) => {
      if (failure === 'transport')
        sendMock.mockRejectedValue(new Error('SQS unavailable'));
      else sendMock.mockResolvedValue({ Failed: [{ Id: 'badge-refresh' }] });
      const { requestDeviceBadgeRefresh } =
        await import('./push-notifications.service');
      await expect(
        requestDeviceBadgeRefresh('profile-a')
      ).resolves.toBeUndefined();
    }
  );
});

describe('sendIdentityPushNotificationsStrict', () => {
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    sendMock.mockReset().mockResolvedValue({});
  });
  afterEach(() => delete process.env.PUSH_NOTIFICATIONS_ACTIVATED);

  it.each(['transport', 'partial batch'])(
    'rejects %s failure so a durable receipt cannot be acknowledged',
    async (failure) => {
      if (failure === 'transport')
        sendMock.mockRejectedValue(new Error('provider failure'));
      else
        sendMock.mockResolvedValue({
          Failed: [{ Id: 'identity-notification-1' }]
        });
      const { sendIdentityPushNotificationsStrict } =
        await import('./push-notifications.service');
      await expect(sendIdentityPushNotificationsStrict([1])).rejects.toThrow();
    }
  );

  it('keeps the original IDs across a retry after an earlier chunk succeeded', async () => {
    const { sendIdentityPushNotificationsStrict } =
      await import('./push-notifications.service');
    const ids = Array.from({ length: 12 }, (_, index) => index + 1);
    sendMock
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Failed: [{ Id: 'identity-notification-11' }] });
    await expect(
      sendIdentityPushNotificationsStrict(ids)
    ).rejects.toMatchObject({ code: 'PUSH_QUEUE_PARTIAL_FAILURE' });
    await expect(
      sendIdentityPushNotificationsStrict(ids)
    ).resolves.toBeUndefined();
    expect(sendMock.mock.calls[2][0]).toEqual(sendMock.mock.calls[0][0]);
    expect(sendMock.mock.calls[3][0]).toEqual(sendMock.mock.calls[1][0]);
  });
});
