import {
  DEFAULT_PROFILE_PREFERENCES,
  ProfileNotificationLevel,
  ProfilePreferencesData
} from '@/entities/IProfilePreferences';
import {
  buildE2eeWakeInput,
  E2eeWakeDeps,
  isE2eeWakeEnabled,
  parseE2eeWakeMessage,
  sendE2eeWakes
} from '@/pushNotificationsHandler/e2ee-wake';
import { PushNotificationMessageInput } from '@/pushNotificationsHandler/sendPushNotifications';

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
      title: '6529',
      body: 'New encrypted message',
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
        { device_id: 'd1', profile_id: 'alice', token: 't1' },
        { device_id: 'd2', profile_id: 'alice', token: 't2' },
        { device_id: 'd3', profile_id: 'bob', token: 't3' },
        { device_id: 'd4', profile_id: 'carol', token: 't4' }
      ],
      loadHandles: async () => new Map([['alice', 'alice-handle']]),
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
    expect(sent.map((input) => [input.token, input.body])).toEqual([
      ['t1', 'New encrypted message'],
      ['t2', 'New encrypted message'],
      ['t3', 'You were added to an encrypted chat']
    ]);
    expect(sent[0].extra_data.target_profile_handle).toBe('alice-handle');
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
});
