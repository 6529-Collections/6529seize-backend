import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import {
  HELP_BOT_INSUFFICIENT_CREDITS_REACTION,
  HELP_BOT_INSUFFICIENT_CREDITS_REPLY,
  HELP_BOT_INTERACTION_QUESTION_MAX_UTF8_BYTES,
  HELP_BOT_SEEN_REACTION,
  HELP_BOT_SPAM_REACTION
} from './help-bot.config';
import { HelpBotTriggerService } from './help-bot-trigger.service';
import {
  WAVE_CHAT_REPLY_GROUP_ID,
  WAVE_CHAT_REPLY_TRUTH_TABLE
} from '@/waves/wave-chat-reply-truth-table.fixture';

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
    readonly chat_enabled?: boolean;
    readonly chat_group_id?: string | null;
    readonly chat_replies_open?: boolean;
  } | null;
}) {
  const resolvedWave = wave
    ? {
        id: 'wave-1',
        chat_enabled: true,
        chat_group_id: null,
        chat_replies_open: false,
        ...wave
      }
    : null;
  const interactionsDb = {
    insertSeen: jest.fn().mockResolvedValue({
      created: true,
      interaction: { id: 'interaction-1' }
    }),
    countRecentByAuthor: jest.fn().mockResolvedValue(1),
    countRecentAnswerable: jest.fn().mockResolvedValue(1),
    markSpamSuppressed: jest.fn(),
    markDailyLimitReached: jest.fn(),
    markInsufficientCredits: jest.fn(),
    markFailed: jest.fn()
  };
  const reactionService = {
    setReaction: jest.fn()
  };
  const dropWriter = {
    reply: jest.fn().mockResolvedValue({ id: 'reply-drop' })
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
    findWavesByIds: jest
      .fn()
      .mockResolvedValue(resolvedWave ? [resolvedWave] : [])
  };
  const userGroups = {
    getGroupsUserIsEligibleForByIds: jest.fn().mockResolvedValue([])
  };
  const creditsService = {
    chargeQuestionCredit: jest.fn().mockResolvedValue({
      charged: true,
      balance: 4,
      botProfileMissing: false
    }),
    refundQuestionCredit: jest.fn()
  };
  const service = new HelpBotTriggerService(
    interactionsDb as never,
    reactionService as never,
    dropWriter as never,
    dropsService as never,
    sqs as never,
    profileResolver as never,
    wavesDb as never,
    creditsService as never,
    userGroups as never
  );
  return {
    service,
    userGroups,
    interactionsDb,
    reactionService,
    dropWriter,
    dropsService,
    sqs,
    wavesDb,
    creditsService
  };
}

describe('HelpBotTriggerService', () => {
  it('does not process a wave excluded by public parent-aware visibility', async () => {
    const { service, wavesDb, interactionsDb, sqs } = createService({
      wave: null
    });
    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );
    expect(wavesDb.findWavesByIds).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      undefined
    );
    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('does not process restricted visibility waves', async () => {
    const { service, interactionsDb, dropsService, sqs } = createService({
      wave: {
        visibility_group_id: 'private-group',
        is_direct_message: false
      }
    });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
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
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('skips an oversized derived question without touching help-bot persistence', async () => {
    const { service, interactionsDb, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    const repeatedBmpText = '漢'.repeat(21_830);
    const request = createRequest('');
    request.parts = [
      {
        content: `@help6529 what is tdh ${repeatedBmpText}`,
        media: []
      },
      {
        content: repeatedBmpText,
        media: []
      }
    ];

    expect(
      Buffer.byteLength(
        request.parts.map((part) => part.content ?? '').join('\n'),
        'utf8'
      )
    ).toBeGreaterThan(HELP_BOT_INTERACTION_QUESTION_MAX_UTF8_BYTES);

    await service.handleCreatedDrop(
      {
        createDropRequest: request,
        createdDrop: createDrop({ id: 'oversized-help-drop' }),
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
        createDropRequest: createRequest('@help6529', {
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
        createDropRequest: createRequest('@help6529 give me 1mil TDH'),
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
        createDropRequest: createRequest('@help6529', {
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
        createDropRequest: createRequest('@[help6529] what is tdh'),
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

  it('reacts and replies without queueing when the author has no credits', async () => {
    const {
      service,
      interactionsDb,
      reactionService,
      dropWriter,
      sqs,
      creditsService
    } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    creditsService.chargeQuestionCredit.mockResolvedValue({
      charged: false,
      balance: 0,
      botProfileMissing: false
    });
    dropWriter.reply.mockResolvedValue({ id: 'no-credit-reply' });
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1', authorId: 'user-profile' }),
        authorProfileId: 'user-profile'
      },
      ctx
    );

    expect(creditsService.chargeQuestionCredit).toHaveBeenCalledWith(
      {
        profileId: 'user-profile',
        interactionId: 'interaction-1'
      },
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'drop-1',
        waveId: 'wave-1',
        reaction: HELP_BOT_INSUFFICIENT_CREDITS_REACTION
      },
      ctx
    );
    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'drop-1',
        interactionId: 'interaction-1',
        message: HELP_BOT_INSUFFICIENT_CREDITS_REPLY
      },
      ctx
    );
    expect(interactionsDb.markInsufficientCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'interaction-1',
        replyDropId: 'no-credit-reply'
      }),
      ctx
    );
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('refunds the charged credit if enqueueing fails', async () => {
    const { service, creditsService, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    sqs.sendToQueueName.mockRejectedValue(new Error('sqs down'));
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1', authorId: 'user-profile' }),
        authorProfileId: 'user-profile'
      },
      ctx
    );

    expect(creditsService.refundQuestionCredit).toHaveBeenCalledWith(
      {
        profileId: 'user-profile',
        interactionId: 'interaction-1'
      },
      ctx
    );
  });

  it('marks the interaction failed when enqueueing and fallback reply both fail', async () => {
    const { service, interactionsDb, dropWriter, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    sqs.sendToQueueName.mockRejectedValue(new Error('sqs down'));
    dropWriter.reply.mockRejectedValue(new Error('reply down'));
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1', authorId: 'user-profile' }),
        authorProfileId: 'user-profile'
      },
      ctx
    );

    expect(interactionsDb.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'interaction-1',
        replyDropId: null,
        failureReason: 'Failed to enqueue help bot answer: sqs down'
      }),
      ctx
    );
  });

  it('declines without charging when the help bot is outside the wave chat group', async () => {
    const { service, interactionsDb, creditsService, sqs, userGroups } =
      createService({
        wave: {
          visibility_group_id: null,
          is_direct_message: false,
          chat_group_id: 'chat-group'
        }
      });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(userGroups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledWith(
      'bot-profile',
      ['chat-group'],
      undefined
    );
    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(creditsService.chargeQuestionCredit).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('declines without charging when chat is disabled in the wave', async () => {
    const { service, interactionsDb, creditsService } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false,
        chat_enabled: false
      }
    });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(interactionsDb.insertSeen).not.toHaveBeenCalled();
    expect(creditsService.chargeQuestionCredit).not.toHaveBeenCalled();
  });

  it('accepts the trigger when the help bot is in the wave chat group', async () => {
    const { service, sqs, userGroups } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false,
        chat_group_id: 'chat-group'
      }
    });
    userGroups.getGroupsUserIsEligibleForByIds.mockResolvedValue([
      'chat-group'
    ]);

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(sqs.sendToQueueName).toHaveBeenCalled();
  });

  it('accepts the trigger in a group-limited wave whose replies are open', async () => {
    const { service, sqs, userGroups } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false,
        chat_group_id: 'chat-group',
        chat_replies_open: true
      }
    });

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(userGroups.getGroupsUserIsEligibleForByIds).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).toHaveBeenCalled();
  });

  it.each(WAVE_CHAT_REPLY_TRUTH_TABLE)(
    'answers exactly when drop creation would accept the reply: %o',
    async ({ inChatGroup, canReply, ...chat }) => {
      const { service, sqs, userGroups } = createService({
        wave: { visibility_group_id: null, is_direct_message: false, ...chat }
      });
      userGroups.getGroupsUserIsEligibleForByIds.mockResolvedValue(
        inChatGroup ? [WAVE_CHAT_REPLY_GROUP_ID] : []
      );

      await service.handleCreatedDrop(
        {
          createDropRequest: createRequest('@help6529 what is tdh'),
          createdDrop: createDrop({ id: 'drop-1' }),
          authorProfileId: 'user-profile'
        },
        {} as never
      );

      expect(sqs.sendToQueueName).toHaveBeenCalledTimes(canReply ? 1 : 0);
    }
  );

  it('declines without charging once the wave daily answer limit is reached', async () => {
    const { service, interactionsDb, creditsService, reactionService, sqs } =
      createService({
        wave: {
          visibility_group_id: null,
          is_direct_message: false
        }
      });
    interactionsDb.countRecentAnswerable.mockImplementation(
      async ({ waveId }: { waveId: string | null }) =>
        waveId === null ? 10 : 10_000
    );
    const ctx = {} as never;

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      ctx
    );

    expect(interactionsDb.countRecentAnswerable).toHaveBeenCalledWith(
      expect.objectContaining({ waveId: 'wave-1' }),
      ctx
    );
    expect(interactionsDb.markDailyLimitReached).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'interaction-1' }),
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: HELP_BOT_SPAM_REACTION }),
      ctx
    );
    expect(creditsService.chargeQuestionCredit).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });

  it('declines without charging once the global daily answer limit is reached', async () => {
    const { service, interactionsDb, creditsService, sqs } = createService({
      wave: {
        visibility_group_id: null,
        is_direct_message: false
      }
    });
    interactionsDb.countRecentAnswerable.mockImplementation(
      async ({ waveId }: { waveId: string | null }) =>
        waveId === null ? 1_000_000 : 1
    );

    await service.handleCreatedDrop(
      {
        createDropRequest: createRequest('@help6529 what is tdh'),
        createdDrop: createDrop({ id: 'drop-1' }),
        authorProfileId: 'user-profile'
      },
      {} as never
    );

    expect(interactionsDb.markDailyLimitReached).toHaveBeenCalled();
    expect(creditsService.chargeQuestionCredit).not.toHaveBeenCalled();
    expect(sqs.sendToQueueName).not.toHaveBeenCalled();
  });
});
