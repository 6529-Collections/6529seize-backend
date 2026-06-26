import {
  HelpBotInteractionStatus,
  HelpBotInteractionTriggerType
} from '@/entities/IHelpBotInteraction';
import {
  HELP_BOT_FAILURE_REACTION,
  HELP_BOT_SUCCESS_REACTION,
  HELP_BOT_TECHNICAL_FAILURE_REPLY
} from './help-bot.config';
import { HelpBotProcessorService } from './help-bot-processor.service';
import { HelpBotInteractionRow } from './help-bot-interactions.db';

describe('HelpBotProcessorService', () => {
  const previousTechTeamHandles = process.env.HELP_BOT_TECH_TEAM_HANDLES;

  afterEach(() => {
    if (previousTechTeamHandles === undefined) {
      delete process.env.HELP_BOT_TECH_TEAM_HANDLES;
      return;
    }
    process.env.HELP_BOT_TECH_TEAM_HANDLES = previousTechTeamHandles;
  });

  it('replies to the target drop and mentions resolved tech team profiles when no reliable source exists', async () => {
    process.env.HELP_BOT_TECH_TEAM_HANDLES = 'dev-team,@support';
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'summon-drop',
      target_drop_id: 'original-question-drop',
      wave_id: 'wave-1',
      author_id: 'summoner-profile',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'what is tdh',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markNoReliableSource: jest.fn(),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn()
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest
        .fn()
        .mockResolvedValue(['current-dev', 'support'])
    };
    const answer = jest.fn().mockResolvedValue({
      type: 'NO_RELIABLE_SOURCE',
      escalateToTechTeam: true
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(answer).toHaveBeenCalledWith({
      question: 'what is tdh',
      previousBotAnswer: null,
      baseUrl: 'https://6529.io'
    });
    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'original-question-drop',
        interactionId: 'interaction-1',
        message:
          "I don't have enough knowledge to help you here. I'm flagging this so the tech team can double-check: @[current-dev] @[support]",
        mentionedHandles: ['current-dev', 'support']
      },
      ctx
    );
    expect(mentionResolver.resolveMentionHandles).toHaveBeenCalledWith(
      ['dev-team', 'support'],
      ctx
    );
    expect(interactionsDb.markNoReliableSource).toHaveBeenCalledWith(
      {
        id: 'interaction-1',
        replyDropId: 'bot-reply-drop'
      },
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'original-question-drop',
        waveId: 'wave-1',
        reaction: HELP_BOT_FAILURE_REACTION
      },
      ctx
    );
  });

  it('does not add a review mention when tech team handles do not resolve', async () => {
    process.env.HELP_BOT_TECH_TEAM_HANDLES = 'dev-team,@support';
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'summon-drop',
      target_drop_id: 'original-question-drop',
      wave_id: 'wave-1',
      author_id: 'summoner-profile',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'what is tdh',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markNoReliableSource: jest.fn(),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn()
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest.fn().mockResolvedValue([])
    };
    const answer = jest.fn().mockResolvedValue({
      type: 'NO_RELIABLE_SOURCE',
      escalateToTechTeam: true
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'original-question-drop',
        interactionId: 'interaction-1',
        message: "I don't have enough knowledge to help you here.",
        mentionedHandles: []
      },
      ctx
    );
    expect(mentionResolver.resolveMentionHandles).toHaveBeenCalledWith(
      ['dev-team', 'support'],
      ctx
    );
  });

  it('does not mention tech team handles for out-of-scope questions', async () => {
    process.env.HELP_BOT_TECH_TEAM_HANDLES = 'dev-team,@support';
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'question-drop',
      target_drop_id: null,
      wave_id: 'wave-1',
      author_id: 'profile-1',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'when was the first moon landing?',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markNoReliableSource: jest.fn(),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn()
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest.fn()
    };
    const answer = jest.fn().mockResolvedValue({
      type: 'NO_RELIABLE_SOURCE',
      escalateToTechTeam: false
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'question-drop',
        interactionId: 'interaction-1',
        message: 'I can only help with 6529 product questions.',
        mentionedHandles: []
      },
      ctx
    );
    expect(mentionResolver.resolveMentionHandles).not.toHaveBeenCalled();
  });

  it('appends a tech-team review mention for uncertain knowledge answers', async () => {
    process.env.HELP_BOT_TECH_TEAM_HANDLES = 'dev-team,@support';
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'question-drop',
      target_drop_id: null,
      wave_id: 'wave-1',
      author_id: 'profile-1',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'weakbot',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markAnswered: jest.fn(),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn()
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest
        .fn()
        .mockResolvedValue(['current-dev', 'support'])
    };
    const answer = jest.fn().mockResolvedValue({
      type: 'ANSWER',
      answer:
        'I might not be fully sure on this one, so here is my best answer.',
      record: {},
      escalateToTechTeam: true
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'question-drop',
        interactionId: 'interaction-1',
        message:
          "I might not be fully sure on this one, so here is my best answer.\n\nI'm flagging this so the tech team can double-check: @[current-dev] @[support]",
        mentionedHandles: ['current-dev', 'support']
      },
      ctx
    );
    expect(interactionsDb.markAnswered).toHaveBeenCalledWith(
      {
        id: 'interaction-1',
        replyDropId: 'bot-reply-drop'
      },
      ctx
    );
    expect(mentionResolver.resolveMentionHandles).toHaveBeenCalledWith(
      ['dev-team', 'support'],
      ctx
    );
  });

  it('does not post a technical-failure reply when the success reaction fails', async () => {
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'question-drop',
      target_drop_id: null,
      wave_id: 'wave-1',
      author_id: 'profile-1',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'what is tdh',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markAnswered: jest.fn(),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn().mockRejectedValue(new Error('reaction failed'))
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest.fn()
    };
    const answer = jest.fn().mockResolvedValue({
      type: 'ANSWER',
      answer: 'TDH stands for Total Days Held.'
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(dropWriter.reply).toHaveBeenCalledTimes(1);
    expect(interactionsDb.markAnswered).toHaveBeenCalledWith(
      {
        id: 'interaction-1',
        replyDropId: 'bot-reply-drop'
      },
      ctx
    );
    expect(interactionsDb.markFailed).not.toHaveBeenCalled();
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'question-drop',
        waveId: 'wave-1',
        reaction: HELP_BOT_SUCCESS_REACTION
      },
      ctx
    );
  });

  it('posts the technical-failure reply when answering throws', async () => {
    const ctx = {} as never;
    const interaction: HelpBotInteractionRow = {
      id: 'interaction-1',
      trigger_drop_id: 'question-drop',
      target_drop_id: null,
      wave_id: 'wave-1',
      author_id: 'profile-1',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'how many memes are in szn1?',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'test',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null
    };
    const interactionsDb = {
      claimForAnswering: jest.fn().mockResolvedValue(interaction),
      markFailed: jest.fn()
    };
    const reactionService = {
      setReaction: jest.fn()
    };
    const dropWriter = {
      reply: jest.fn().mockResolvedValue({ id: 'bot-reply-drop' })
    };
    const profileResolver = {
      resolveBotProfileId: jest.fn().mockResolvedValue('bot-profile')
    };
    const creditsService = {
      refundQuestionCredit: jest.fn()
    };
    const mentionResolver = {
      resolveMentionHandles: jest.fn()
    };
    const answerError = new Error('db timeout');
    const answer = jest.fn().mockRejectedValue(answerError);
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never,
      creditsService as never,
      mentionResolver
    );

    await service.processInteraction('interaction-1', ctx);

    expect(dropWriter.reply).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        waveId: 'wave-1',
        replyToDropId: 'question-drop',
        interactionId: 'interaction-1',
        message: HELP_BOT_TECHNICAL_FAILURE_REPLY
      },
      ctx
    );
    expect(interactionsDb.markFailed).toHaveBeenCalledWith(
      {
        id: 'interaction-1',
        replyDropId: 'bot-reply-drop',
        failureReason: 'db timeout'
      },
      ctx
    );
    expect(reactionService.setReaction).toHaveBeenCalledWith(
      {
        botProfileId: 'bot-profile',
        dropId: 'question-drop',
        waveId: 'wave-1',
        reaction: HELP_BOT_FAILURE_REACTION
      },
      ctx
    );
    expect(creditsService.refundQuestionCredit).toHaveBeenCalledWith(
      {
        profileId: 'profile-1',
        interactionId: 'interaction-1'
      },
      ctx
    );
  });
});
