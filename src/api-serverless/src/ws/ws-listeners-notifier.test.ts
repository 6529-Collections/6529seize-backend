import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';

describe('WsListenersNotifier', () => {
  it('sends each direct-message unread state only to sessions synced for that profile', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      findNotificationConnectionIdsByIdentityIds: jest.fn().mockResolvedValue([
        { connectionId: 'shared-connection', identityId: 'profile-1' },
        { connectionId: 'shared-connection', identityId: 'profile-2' },
        { connectionId: 'profile-1-device-2', identityId: 'profile-1' }
      ])
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );
    const profileOneState = {
      profile_id: 'profile-1',
      wave_id: 'wave-1',
      unread_count: 2,
      first_unread_drop_serial_no: 10,
      latest_drop_serial_no: 11,
      latest_read_serial_no: 9,
      version: 3
    };
    const profileTwoState = {
      ...profileOneState,
      profile_id: 'profile-2',
      unread_count: 1
    };

    await notifier.notifyAboutDmUnreadStateChanged([
      profileOneState,
      profileTwoState
    ]);

    expect(
      wsConnectionRepository.findNotificationConnectionIdsByIdentityIds
    ).toHaveBeenCalledWith(['profile-1', 'profile-2']);
    expect(appWebSockets.send).toHaveBeenCalledTimes(3);
    const sends = appWebSockets.send.mock.calls.map(([call]) => ({
      connectionId: call.connectionId,
      message: JSON.parse(call.message)
    }));
    expect(sends).toEqual([
      {
        connectionId: 'shared-connection',
        message: {
          type: 'DM_UNREAD_STATE_CHANGED',
          data: profileOneState
        }
      },
      {
        connectionId: 'shared-connection',
        message: {
          type: 'DM_UNREAD_STATE_CHANGED',
          data: profileTwoState
        }
      },
      {
        connectionId: 'profile-1-device-2',
        message: {
          type: 'DM_UNREAD_STATE_CHANGED',
          data: profileOneState
        }
      }
    ]);
  });

  it('sends notification invalidations only to subscribed recipient connections', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      findNotificationConnectionIdsByIdentityIds: jest.fn().mockResolvedValue([
        { connectionId: 'connection-1', identityId: 'profile-1' },
        { connectionId: 'connection-2', identityId: 'profile-2' }
      ])
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );

    await notifier.notifyAboutIdentityNotificationsChanged([
      'profile-1',
      'profile-2',
      'profile-1'
    ]);

    expect(
      wsConnectionRepository.findNotificationConnectionIdsByIdentityIds
    ).toHaveBeenCalledWith(['profile-1', 'profile-2']);
    expect(appWebSockets.send).toHaveBeenCalledTimes(2);
    expect(appWebSockets.send.mock.calls.map(([call]) => call)).toEqual([
      {
        connectionId: 'connection-1',
        message: JSON.stringify({
          type: 'IDENTITY_NOTIFICATIONS_CHANGED',
          data: { profile_id: 'profile-1' }
        })
      },
      {
        connectionId: 'connection-2',
        message: JSON.stringify({
          type: 'IDENTITY_NOTIFICATIONS_CHANGED',
          data: { profile_id: 'profile-2' }
        })
      }
    ]);
  });

  it('removes viewer poll selections from anonymous poll drop updates', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      getCurrentlyOnlineCommunityMemberConnectionIds: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', profileId: 'viewer-1' }
        ])
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );

    await notifier.notifyAboutDropUpdate(
      {
        id: 'drop-1',
        drop_type: ApiDropType.Chat,
        author: { id: 'author-1', subscribed_actions: [] },
        wave: {
          id: 'wave-1',
          visibility_group_id: null
        },
        parts: [],
        poll: {
          id: 'poll-1',
          options: [{ option_no: 1, option_string: 'First', votes: 4 }],
          voted: [1],
          multichoice: false,
          anonymous: true,
          closing_time: 2_000,
          is_open: true
        }
      } as any,
      {}
    );

    const message = JSON.parse(appWebSockets.send.mock.calls[0][0].message);
    expect(message.data.poll).toMatchObject({
      anonymous: true,
      voted: [],
      options: [{ option_no: 1, option_string: 'First', votes: 4 }]
    });
  });
});
