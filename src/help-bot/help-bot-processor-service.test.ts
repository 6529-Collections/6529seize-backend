import {
  HelpBotInteractionStatus,
  HelpBotInteractionTriggerType
} from '@/entities/IHelpBotInteraction';
import { HELP_BOT_FAILURE_REACTION } from './help-bot.config';
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

  it('replies to the target drop and mentions tech team handles when no reliable source exists', async () => {
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
    const answer = jest.fn().mockResolvedValue({
      type: 'NO_RELIABLE_SOURCE'
    });
    const service = new HelpBotProcessorService(
      interactionsDb as never,
      reactionService as never,
      dropWriter as never,
      {} as never,
      profileResolver as never,
      () => ({ answer }) as never
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
          "I don't have enough knowledge to help you here. @dev-team @support",
        mentionedHandles: ['dev-team', 'support']
      },
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
});
