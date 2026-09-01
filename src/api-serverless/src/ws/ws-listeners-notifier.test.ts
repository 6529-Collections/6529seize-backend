import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import {
  serializeDropMessageForRecipient,
  serializeDropRatingUpdateForRecipient,
  serializeDropReactionUpdateForRecipient,
  serializeDropUpdateForRecipient,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import {
  DROP_UPDATE_MAX_UTF8_BYTES,
  DropUpdateRefType,
  WsMessageType
} from '@/api/ws/ws-message';
import { Logger } from '@/logging';

function createDrop(content: string, dropType = ApiDropType.Chat) {
  return {
    id: 'drop-1',
    serial_no: 42,
    drop_type: dropType,
    author: { id: 'author-1', subscribed_actions: [] },
    wave: {
      id: 'wave-1',
      visibility_group_id: null,
      voting_credit_type: ApiWaveCreditType.Tdh,
      voting_credit_scope: ApiWaveCreditScope.Wave
    },
    parts: [{ content }]
  } as any;
}

function findMaximumSafeAsciiContentLength(
  creditLeft: number,
  dropType = ApiDropType.Chat,
  updateType: DropUpdateRefType = WsMessageType.DROP_UPDATE,
  reason?: string
): number {
  let low = 0;
  let high = 40_000;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const serialized =
      updateType === WsMessageType.DROP_UPDATE
        ? serializeDropUpdateForRecipient(
            createDrop('a'.repeat(candidate), dropType),
            creditLeft,
            reason
          )
        : serializeDropMessageForRecipient(
            createDrop('a'.repeat(candidate), dropType),
            creditLeft,
            updateType
          );
    const message = JSON.parse(serialized);
    if (message.type === updateType) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  return low;
}

describe('WsListenersNotifier', () => {
  it('resolves wave listeners once and sends every bulk drop deletion in order', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      getCurrentlyOnlineCommunityMemberConnectionIds: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', profileId: 'profile-1' },
          { connectionId: 'connection-2', profileId: 'profile-2' }
        ])
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );
    const deletedDrops = [
      { drop_id: 'drop-1', wave_id: 'wave-1', drop_serial: 10 },
      { drop_id: 'drop-2', wave_id: 'wave-1', drop_serial: 12 }
    ];

    await notifier.notifyAboutDropDeletes(deletedDrops, 'visibility-group', {});

    expect(
      wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds
    ).toHaveBeenCalledTimes(1);
    expect(
      wsConnectionRepository.getCurrentlyOnlineCommunityMemberConnectionIds
    ).toHaveBeenCalledWith(
      { groupId: 'visibility-group', waveId: 'wave-1' },
      {}
    );
    expect(appWebSockets.send).toHaveBeenCalledTimes(4);
    expect(
      appWebSockets.send.mock.calls.map(([call]) => ({
        connectionId: call.connectionId,
        message: JSON.parse(call.message)
      }))
    ).toEqual([
      {
        connectionId: 'connection-1',
        message: { type: WsMessageType.DROP_DELETE, data: deletedDrops[0] }
      },
      {
        connectionId: 'connection-2',
        message: { type: WsMessageType.DROP_DELETE, data: deletedDrops[0] }
      },
      {
        connectionId: 'connection-1',
        message: { type: WsMessageType.DROP_DELETE, data: deletedDrops[1] }
      },
      {
        connectionId: 'connection-2',
        message: { type: WsMessageType.DROP_DELETE, data: deletedDrops[1] }
      }
    ]);
  });

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

  it('uses pre-resolved direct-message recipients without repeating the connection lookup', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      findNotificationConnectionIdsByIdentityIds: jest.fn()
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );
    const unreadState = {
      profile_id: 'profile-1',
      wave_id: 'wave-1',
      unread_count: 2,
      first_unread_drop_serial_no: 10,
      latest_drop_serial_no: 11,
      latest_read_serial_no: 9,
      version: 3
    };

    await notifier.notifyAboutDmUnreadStateChanged(
      [unreadState],
      [{ connectionId: 'connection-1', identityId: 'profile-1' }]
    );

    expect(
      wsConnectionRepository.findNotificationConnectionIdsByIdentityIds
    ).not.toHaveBeenCalled();
    expect(appWebSockets.send).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      message: JSON.stringify({
        type: 'DM_UNREAD_STATE_CHANGED',
        data: unreadState
      })
    });
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
    expect(message.type).toBe(WsMessageType.DROP_UPDATE);
    expect(message.data.poll).toMatchObject({
      anonymous: true,
      voted: [],
      options: [{ option_no: 1, option_string: 'First', votes: 4 }]
    });
  });

  it.each([
    WsMessageType.DROP_UPDATE,
    WsMessageType.DROP_RATING_UPDATE,
    WsMessageType.DROP_REACTION_UPDATE
  ] as DropUpdateRefType[])(
    'switches at the documented UTF-8 ceiling for %s',
    (updateType) => {
      const safeContentLength = findMaximumSafeAsciiContentLength(
        0,
        ApiDropType.Chat,
        updateType
      );
      const safeMessage = serializeDropMessageForRecipient(
        createDrop('a'.repeat(safeContentLength)),
        0,
        updateType
      );
      const oversizedMessage = serializeDropMessageForRecipient(
        createDrop('a'.repeat(safeContentLength + 1)),
        0,
        updateType
      );

      expect(Buffer.byteLength(safeMessage, 'utf8')).toBe(
        DROP_UPDATE_MAX_UTF8_BYTES
      );
      expect(JSON.parse(safeMessage).type).toBe(updateType);
      expect(JSON.parse(oversizedMessage)).toEqual({
        type: WsMessageType.DROP_UPDATE_REF,
        data: {
          drop_id: 'drop-1',
          wave_id: 'wave-1',
          author_id: 'author-1',
          serial_no: 42,
          update_type: updateType
        }
      });
      expect(oversizedMessage).not.toContain('a'.repeat(10));
    }
  );

  it('preserves the original reason in an oversized content update ref', () => {
    const safeContentLength = findMaximumSafeAsciiContentLength(
      0,
      ApiDropType.Chat,
      WsMessageType.DROP_UPDATE,
      'POLL_RESPONSE'
    );
    const message = JSON.parse(
      serializeDropUpdateForRecipient(
        createDrop('a'.repeat(safeContentLength + 1)),
        0,
        'POLL_RESPONSE'
      )
    );

    expect(message).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE,
        reason: 'POLL_RESPONSE'
      }
    });
  });

  it('keeps rating and reaction refs distinct when they share a serial', () => {
    const content = 'a'.repeat(
      findMaximumSafeAsciiContentLength(
        0,
        ApiDropType.Chat,
        WsMessageType.DROP_RATING_UPDATE
      ) + 1
    );
    const drop = createDrop(content);
    const rating = JSON.parse(serializeDropRatingUpdateForRecipient(drop, 0));
    const reaction = JSON.parse(
      serializeDropReactionUpdateForRecipient(drop, 0)
    );

    expect(rating).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_RATING_UPDATE
      }
    });
    expect(reaction).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_REACTION_UPDATE
      }
    });
  });

  it('measures recipient-specific final payloads independently', async () => {
    const appWebSockets = {
      send: jest.fn().mockResolvedValue(undefined)
    };
    const wsConnectionRepository = {
      getCurrentlyOnlineCommunityMemberConnectionIds: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-small', profileId: 'profile-small' },
          { connectionId: 'connection-large', profileId: 'profile-large' }
        ]),
      getCreditLeftForProfilesForTdhBasedWave: jest.fn().mockResolvedValue({
        'profile-small': 0,
        'profile-large': Number.MAX_SAFE_INTEGER
      })
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );
    const contentLength = findMaximumSafeAsciiContentLength(
      0,
      ApiDropType.Participatory
    );

    await notifier.notifyAboutDropUpdate(
      createDrop('a'.repeat(contentLength), ApiDropType.Participatory),
      {}
    );

    const messagesByConnection = Object.fromEntries(
      appWebSockets.send.mock.calls.map(([call]) => [
        call.connectionId,
        JSON.parse(call.message)
      ])
    );
    expect(messagesByConnection['connection-small'].type).toBe(
      WsMessageType.DROP_UPDATE
    );
    expect(messagesByConnection['connection-large']).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE
      }
    });
  });

  it('does not reject the notification operation when a recipient send fails', async () => {
    const appWebSockets = {
      send: jest
        .fn()
        .mockRejectedValueOnce(new Error('simulated send failure'))
        .mockResolvedValueOnce(undefined)
    };
    const wsConnectionRepository = {
      getCurrentlyOnlineCommunityMemberConnectionIds: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', profileId: null },
          { connectionId: 'connection-2', profileId: null }
        ])
    };
    const notifier = new WsListenersNotifier(
      appWebSockets as any,
      wsConnectionRepository as any
    );

    await expect(
      notifier.notifyAboutDropUpdate(createDrop('ordinary update'), {})
    ).resolves.toBeUndefined();
    expect(appWebSockets.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'DROP_UPDATE',
      notify: (notifier: WsListenersNotifier, drop: any) =>
        notifier.notifyAboutDropUpdate(drop, {})
    },
    {
      label: 'DROP_RATING_UPDATE',
      notify: (notifier: WsListenersNotifier, drop: any) =>
        notifier.notifyAboutDropRatingUpdate(drop, {})
    },
    {
      label: 'DROP_REACTION_UPDATE',
      notify: (notifier: WsListenersNotifier, drop: any) =>
        notifier.notifyAboutDropReactionUpdate(drop, {})
    }
  ])(
    'does not log drop content when $label notification fails',
    async ({ label, notify }) => {
      const secret = 'storm-content-secret-that-must-not-be-logged';
      const logger = Logger.get(WsListenersNotifier.name);
      const loggerError = jest
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      const appWebSockets = {
        send: jest.fn().mockRejectedValue(new Error('send failed'))
      };
      const wsConnectionRepository = {
        getCurrentlyOnlineCommunityMemberConnectionIds: jest
          .fn()
          .mockResolvedValue([
            { connectionId: 'connection-1', profileId: null }
          ])
      };
      const notifier = new WsListenersNotifier(
        appWebSockets as any,
        wsConnectionRepository as any
      );
      const drop = {
        ...createDrop(secret),
        serial_no: 77,
        wave: { ...createDrop(secret).wave, id: 'wave-secret' }
      };

      await notify(notifier, drop);

      expect(loggerError).toHaveBeenCalledTimes(1);
      const message = String(loggerError.mock.calls[0][0]);
      expect(message).toContain(label);
      expect(message).toContain('drop_id=drop-1');
      expect(message).toContain('wave_id=wave-secret');
      expect(message).toContain('serial_no=77');
      expect(message).not.toContain(secret);
      loggerError.mockRestore();
    }
  );
});
