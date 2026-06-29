import { DropType } from '@/entities/IDrop';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { HelpBotDropWriterService } from './help-bot-drop-writer.service';

describe('HelpBotDropWriterService', () => {
  it('creates help bot replies with link previews hidden', async () => {
    const connection = {} as never;
    const createOrUpdateDrop = {
      execute: jest.fn().mockResolvedValue({
        drop_id: 'reply-drop',
        wave_id: 'wave-1',
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
    const enqueueDirtyWaveScoreRefreshSpy = jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
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
          message:
            "I don't have enough knowledge to help you here. I'm flagging this so the tech team can double-check: @[current-dev] @[support]",
          mentionedHandles: ['current-dev', 'support']
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
    const model = createOrUpdateDrop.execute.mock.calls[0]?.[0];
    expect(model.parts[0].content).toBe(
      "I don't have enough knowledge to help you here. I'm flagging this so the tech team can double-check: @[current-dev] @[support]"
    );
    expect(model.mentioned_users).toEqual([
      { handle: 'current-dev' },
      { handle: 'support' }
    ]);
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
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      apiDrop,
      expect.objectContaining({
        authenticationContext: expect.anything()
      })
    );
    expect(
      dropsService.findDropByIdOrThrow.mock.invocationCallOrder[0]
    ).toBeLessThan(
      wsListenersNotifier.notifyAboutDropUpdate.mock.invocationCallOrder[0]
    );
    expect(enqueueDirtyWaveScoreRefreshSpy).toHaveBeenCalledWith(
      ['wave-1'],
      'DROP_CHANGED',
      {}
    );
  });
});
