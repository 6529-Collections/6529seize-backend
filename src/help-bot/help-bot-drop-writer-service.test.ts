import { DropType } from '@/entities/IDrop';
import { HelpBotDropWriterService } from './help-bot-drop-writer.service';

describe('HelpBotDropWriterService', () => {
  it('creates help bot replies with link previews hidden', async () => {
    const connection = {} as never;
    const createOrUpdateDrop = {
      execute: jest.fn().mockResolvedValue({
        drop_id: 'reply-drop',
        pending_push_notification_ids: []
      })
    };
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback(connection)
      ),
      updateHideLinkPreview: jest.fn().mockResolvedValue(true)
    };
    const apiDrop = { id: 'reply-drop', hide_link_preview: true };
    const dropsService = {
      findDropByIdOrThrow: jest.fn().mockResolvedValue(apiDrop)
    };
    const wsListenersNotifier = {
      notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
    };
    const service = new HelpBotDropWriterService(
      createOrUpdateDrop as never,
      dropsDb as never,
      dropsService as never,
      wsListenersNotifier as never
    );

    await expect(
      service.reply(
        {
          botProfileId: 'bot-profile',
          waveId: 'wave-1',
          replyToDropId: 'source-drop',
          interactionId: 'interaction-1',
          message: 'See [TDH](https://6529.io/network/tdh).'
        },
        {}
      )
    ).resolves.toBe(apiDrop);

    expect(createOrUpdateDrop.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        drop_type: DropType.CHAT,
        reply_to: {
          drop_id: 'source-drop',
          drop_part_id: 1
        }
      }),
      false,
      expect.objectContaining({
        connection,
        bypassChatLinkRestrictions: true,
        bypassChatSlowModeRestrictions: true
      })
    );
    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      {
        drop_id: 'reply-drop',
        hide_link_preview: true
      },
      {
        timer: undefined,
        connection
      }
    );
    expect(
      dropsDb.updateHideLinkPreview.mock.invocationCallOrder[0]
    ).toBeLessThan(
      dropsService.findDropByIdOrThrow.mock.invocationCallOrder[0]
    );
    expect(dropsService.findDropByIdOrThrow).toHaveBeenCalledWith(
      {
        dropId: 'reply-drop',
        skipEligibilityCheck: true
      },
      expect.objectContaining({
        connection
      })
    );
  });
});
