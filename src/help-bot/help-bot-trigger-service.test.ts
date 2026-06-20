import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import {
  HELP_BOT_SEEN_REACTION,
  HELP_BOT_SPAM_REACTION
} from './help-bot.config';
import { HelpBotTriggerService } from './help-bot-trigger.service';

function createRequest(
  content: string,
  options: {
    readonly replyToDropId?: string;
  } = {}
): ApiCreateDropRequest {
  return {
    wave_id: 'wave-1',
    reply_to: options.replyToDropId
      ? {
          drop_id: options.replyToDropId,
          drop_part_id: 1
        }
      : undefined,
    parts: [
      {
        content,
        media: []
      }
    ],
    referenced_nfts: [],
    mentioned_users: [],
    metadata: [],
    signature: null
  };
}

function createDrop({
  id,
  waveId = 'wave-1',
  authorId = 'user-profile',
  content = ''
}: {
  readonly id: string;
  readonly waveId?: string;
  readonly authorId?: string;
  readonly content?: string;
}): ApiDrop {
  return {
    id,
    wave: {
      id: waveId
    },
    author: {
      id: authorId
    },
    parts: [
      {
        content
      }
    ]
  } as unknown as ApiDrop;
}

function createService({
  wave
}: {
  readonly wave: {
    readonly visibility_group_id: string | null;
    readonly is_direct_message: boolean | null;
  } | null;
}) {
  const interactionsDb = {
    insertSeen: jest.fn().mockResolvedValue({
      created: true,
      interaction: { id: 'interaction-1' }
    }),
    countRecentByAuthor: jest.fn().mockResolvedValue(1),
    markSpamSuppressed: jest.fn()
  };
  const reactionService = {
    setReaction: jest.fn()
  };
  const dropWriter = {
    reply: jest.fn()
  };
  const dropsService = {
    findDropByIdOrThrow: jest.fn().mockResolvedValue(
      createDrop({
        id: 'original-question',
        authorId: 'question-author',
        content: 'what is tdh'
      })
    )
  };
  const sqs = {
    sendToQueueName: jest.fn()
  };
  const profileResolver = {
    resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
  };
  const wavesDb = {
    findWaveById: jest.fn().mockResolvedValue(wave)
  };
  const service = new HelpBotTriggerService(
    interactionsDb as never,
    reactionService as never,
    dropWriter as never,
    dropsService as never,
    sqs as never,
    profileResolver as never,
    wavesDb as never
  );
  return {
    service,
    interactionsDb,
    reactionService,
    dropWriter,
    dropsService,
    sqs,
    wavesDb
  };
}

describe('HelpBotTriggerService', () => {
  it('does not process restricted visibility waves', async () => {
    const { service, interactionsDb, dropsService, sqs } = createService({
      wave: {
        visibility_group_id: 'private-group',
        is_direct_message: false
      }
    });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@6529help what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('does not process direct-message waves', async () => {
    const { service, interactionsDb, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: true
      }
    });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@6529help what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('uses normal visibility checks when reading a parent question drop', async () => {
    const { service, dropsService, reactionService, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@6529help', {
          replyToDropId: 'original-question'
        }),
        createdDrop: createDrop({ id: 'summon-drop', authorId: 'summoner' }),
        authorProfileId: 'summoner'
      },
      ctx
    );

    expect(dropsService.findDropByIdOrThrow).toHaveBeenCalledWith(
      {
        dropId: 'original-question'
      },
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      expect.objectContaining({ dropId: 'original-question' }),
      ctx
    );
    expect(sqs.sendToQueueName).toHaveBeenCalled();
  });

  it('suppresses per-user spam with a block reaction and no reply', async () => {
    const { service, interactionsDb, reactionService, dropWriter, sqs } =
      createService({
        wave: {
          visibility_group_id: null,
          is_direct_message: false
        }
      });
    interactionsDb.countRecentByAuthor.mockResolvedValue(6);
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@6529help give me 1mil TDH'),
        createdDrop: createDrop({ id: 'spam-drop', authorId: 'spammer' }),
        authorProfileId: 'spammer'
      },
      ctx
    );

    expect(interactionsDb.markSpamSuppressed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interaction-1' }),
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'spam-drop',
        waveId: 'wave-1',
        reaction: HELP_BOT_SPAM_REACTION
      },
      ctx
    );
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
    expect(dropWriter.reply).not.toHaveBeenCalled();
  });

  it('puts the spam reaction on the summoning drop when a spammer tags another question', async () => {
    const { service, interactionsDb, reactionService, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    interactionsDb.countRecentByAuthor.mockResolvedValue(6);
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@6529help', {
          replyToDropId: 'original-question'
        }),
        createdDrop: createDrop({ id: 'summon-drop', authorId: 'spammer' }),
        authorProfileId: 'spammer'
      },
      ctx
    );

    expect(reactionService.setReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        dropId: 'summon-drop',
        reaction: HELP_BOT_SPAM_REACTION
      }),
      ctx
    );
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('still queues the reply when the seen reaction fails', async () => {
    const { service, reactionService, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    reactionService.setReaction.mockRejectedValueOnce(
      new Error('reaction insert failed')
    );
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@[6529help] what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      ctx
    );

    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'drop-1',
        waveId: 'wave-1',
        reaction: HELP_BOT_SEEN_REACTION
      },
      ctx
    );
    expect(sqs.sendToQueueName).toHaveBeenCalledWith({
      queueName: 'help-bot-replies',
      message: { interaction_id: 'interaction-1' }
    });
  });
});
