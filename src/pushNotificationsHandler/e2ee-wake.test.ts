import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import {
  buildE2eeWakeInput,
  defaultE2eeWakeDeps,
  E2eeWakeDeps,
  isE2eeWakeEnabled,
  parseE2eeWakeMessage,
  sendE2eeWakes
} from '@/pushNotificationsHandler/e2ee-wake';
import { PushNotificationMessageInput } from '@/pushNotificationsHandler/sendPushNotifications';
import { PUSH_NOTIFICATION_DEVICES_TABLE } from '@/constants/db-tables';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/pushNotificationsHandler/sendPushNotifications', () => ({
  sendMessages: jest.fn()
}));

describe('content-free E2EE wakes', () => {
  it('builds a payload without sender, group or text', () => {
    const input = buildE2eeWakeInput({
      token: 'fcm-token',
      profileId: 'profile-1',
      handle: 'alice',
      reason: 'message'
    });
    expect(input).toEqual({
      title: 'New encrypted message',
      body: 'Open 6529 Mobile to view',
      token: 'fcm-token',
      notification_id: 0,
      omitBadge: true,
      extra_data: {
        redirect: 'e2ee',
        target_profile_id: 'profile-1',
        target_profile_handle: 'alice',
        notification_id: 'e2ee'
      }
    });
    expect(input.imageUrl).toBeUndefined();
    expect(
      buildE2eeWakeInput({
        token: 't',
        profileId: 'p',
        handle: 'h',
        reason: 'added'
      }).body
    ).toBe('You were added to an encrypted chat');
  });

  it.each([
    ['development', 'staging', 'Open 6529 Staging to view'],
    [
      'development',
      'pushNotificationsHandler_prod',
      'Open 6529 Staging to view'
    ],
    ['development', undefined, 'Open 6529 Staging to view'],
    [
      'production',
      'pushNotificationsHandler_staging',
      'Open 6529 Mobile to view'
    ],
    ['production', undefined, 'Open 6529 Mobile to view']
  ])(
    'uses NODE_ENV=%s independently of Sentry=%s',
    (nodeEnv, sentryEnv, expectedBody) => {
      const previous = process.env;
      try {
        process.env = { ...previous, NODE_ENV: nodeEnv };
        if (sentryEnv === undefined) delete process.env.SENTRY_ENVIRONMENT;
        else process.env.SENTRY_ENVIRONMENT = sentryEnv;
        expect(
          buildE2eeWakeInput({
            token: 'token',
            profileId: 'p',
            handle: 'h',
            reason: 'message'
          })
        ).toMatchObject({
          title: 'New encrypted message',
          body: expectedBody
        });
        expect(
          buildE2eeWakeInput({
            token: 'token',
            profileId: 'p',
            handle: 'h',
            reason: 'added'
          }).body
        ).toBe('You were added to an encrypted chat');
      } finally {
        process.env = previous;
      }
    }
  );

  it('parses only well-formed e2ee_wake bodies', () => {
    expect(
      parseE2eeWakeMessage({
        type: 'e2ee_wake',
        profile_ids: ['a', 'a', '', 7, 'b'],
        reason: 'message'
      })
    ).toEqual({ profileIds: ['a', 'b'], reason: 'message' });
    expect(
      parseE2eeWakeMessage({
        type: 'e2ee_wake',
        profile_ids: ['a'],
        reason: 'mention'
      })
    ).toBeNull();
    expect(parseE2eeWakeMessage({ identity_notification_id: 5 })).toBeNull();
    expect(parseE2eeWakeMessage(null)).toBeNull();
  });

  it('follows the direct-message notification preference', () => {
    expect(isE2eeWakeEnabled(undefined)).toBe(true);
    expect(isE2eeWakeEnabled(DEFAULT_PROFILE_PREFERENCES)).toBe(true);
    expect(
      isE2eeWakeEnabled({
        ...DEFAULT_PROFILE_PREFERENCES,
        notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY
      })
    ).toBe(false);
    expect(
      isE2eeWakeEnabled({
        ...DEFAULT_PROFILE_PREFERENCES,
        notifications: {
          ...DEFAULT_PROFILE_PREFERENCES.notifications,
          direct_messages: false
        }
      })
    ).toBe(false);
  });

  it('only marks a registration as shared when another profile has the same device and token', async () => {
    const profileId = 'e2ee-wake-recipient';
    const otherProfileId = 'e2ee-wake-other-profile';
    const registrations = [
      { device_id: 'wake-shared', profile_id: profileId, token: 'wake-shared' },
      {
        device_id: 'wake-shared',
        profile_id: otherProfileId,
        token: 'wake-shared'
      },
      {
        device_id: 'wake-changed-token',
        profile_id: profileId,
        token: 'wake-new'
      },
      {
        device_id: 'wake-changed-token',
        profile_id: otherProfileId,
        token: 'wake-NEW'
      },
      {
        device_id: 'wake-other-device',
        profile_id: profileId,
        token: 'wake-shared'
      }
    ];
    await sqlExecutor.bulkInsert(
      PUSH_NOTIFICATION_DEVICES_TABLE,
      registrations,
      ['device_id', 'profile_id', 'token']
    );
    try {
      const devices = await defaultE2eeWakeDeps.loadDevices([profileId]);
      expect(devices).toHaveLength(3);
      expect(
        Object.fromEntries(
          devices.map((device) => [device.device_id, device.is_multi_profile])
        )
      ).toEqual({
        'wake-shared': 1,
        'wake-changed-token': 0,
        'wake-other-device': 0
      });
    } finally {
      await sqlExecutor.execute(
        `delete from ${PUSH_NOTIFICATION_DEVICES_TABLE} where profile_id in (:profileIds)`,
        { profileIds: [profileId, otherProfileId] }
      );
    }
  });

  it('keeps a generic title when the recipient has no handle', () => {
    const input = buildE2eeWakeInput({
      token: 'token',
      profileId: 'profile-id',
      reason: 'message',
      showRecipient: true
    });
    expect(input.title).toBe('New encrypted message');
    expect(input.extra_data.target_profile_handle).toBe('profile-id');
  });

  it('wakes every device of enabled profiles and removes unregistered tokens', async () => {
    const sent: PushNotificationMessageInput[] = [];
    const deleted: string[] = [];
    const muted: ProfilePreferencesData = {
      ...DEFAULT_PROFILE_PREFERENCES,
      notifications: {
        ...DEFAULT_PROFILE_PREFERENCES.notifications,
        direct_messages: false
      }
    };
    const deps: E2eeWakeDeps = {
      loadDevices: async () => [
        {
          device_id: 'd1',
          profile_id: 'alice',
          token: 't1',
          is_multi_profile: 1
        },
        {
          device_id: 'd2',
          profile_id: 'alice',
          token: 't2',
          is_multi_profile: 0
        },
        {
          device_id: 'd3',
          profile_id: 'bob',
          token: 't3',
          is_multi_profile: 1
        },
        {
          device_id: 'd4',
          profile_id: 'carol',
          token: 't4',
          is_multi_profile: 0
        }
      ],
      loadHandles: async () =>
        new Map([
          ['alice', '@alice-handle'],
          ['bob', 'bob']
        ]),
      loadPreferences: async () => new Map([['carol', muted]]),
      send: async (inputs) => {
        sent.push(...inputs);
        return inputs.map((input) => ({
          input,
          response:
            input.token === 't2'
              ? {
                  success: false,
                  error: {
                    code: 'messaging/registration-token-not-registered'
                  } as never
                }
              : { success: true, messageId: 'm' }
        }));
      },
      deleteDevice: async (device) => {
        deleted.push(device.device_id);
      }
    };
    await sendE2eeWakes(
      [
        { profileIds: ['alice', 'bob'], reason: 'message' },
        { profileIds: ['bob', 'carol'], reason: 'added' }
      ],
      deps
    );
    expect(sent.map((input) => [input.token, input.title, input.body])).toEqual(
      [
        [
          't1',
          '[alice-handle] New encrypted message',
          'Open 6529 Mobile to view'
        ],
        ['t2', 'New encrypted message', 'Open 6529 Mobile to view'],
        ['t3', '6529', 'You were added to an encrypted chat']
      ]
    );
    expect(sent[0].extra_data.target_profile_handle).toBe('@alice-handle');
    expect(sent[2].extra_data.target_profile_handle).toBe('bob');
    expect(deleted).toEqual(['d2']);
    for (const input of sent) {
      expect(Object.keys(input.extra_data).sort()).toEqual([
        'notification_id',
        'redirect',
        'target_profile_handle',
        'target_profile_id'
      ]);
    }
  });

  it('does not rethrow when the send fails part-way, so SQS does not redeliver', async () => {
    const deps: E2eeWakeDeps = {
      loadDevices: async () => [
        {
          device_id: 'd1',
          profile_id: 'alice',
          token: 't1',
          is_multi_profile: 0
        }
      ],
      loadHandles: async () => new Map(),
      loadPreferences: async () => new Map(),
      send: async () => {
        throw new Error('second FCM chunk failed');
      },
      deleteDevice: async () => undefined
    };
    await expect(
      sendE2eeWakes([{ profileIds: ['alice'], reason: 'message' }], deps)
    ).resolves.toBeUndefined();
  });

  it('still throws when a lookup fails before anything was sent', async () => {
    const deps: E2eeWakeDeps = {
      loadDevices: async () => {
        throw new Error('db down');
      },
      loadHandles: async () => new Map(),
      loadPreferences: async () => new Map(),
      send: async () => [],
      deleteDevice: async () => undefined
    };
    await expect(
      sendE2eeWakes([{ profileIds: ['alice'], reason: 'message' }], deps)
    ).rejects.toThrow('db down');
  });
});
