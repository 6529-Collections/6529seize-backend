import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';

describe('WsListenersNotifier', () => {
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
