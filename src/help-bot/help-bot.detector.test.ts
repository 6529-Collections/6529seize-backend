import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { HelpBotInteractionTriggerType } from '@/entities/IHelpBotInteraction';
import { detectHelpBotTrigger } from './help-bot.detector';

function createRequest(
  content: string,
  options: {
    readonly replyToDropId?: string;
    readonly mentionedHandle?: string;
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
    mentioned_users: options.mentionedHandle
      ? [
          {
            mentioned_profile_id: 'bot-profile',
            handle_in_content: options.mentionedHandle
          }
        ]
      : [],
    metadata: [],
    signature: null
  };
}

function createDrop({
  id,
  authorId = 'user-profile',
  content = '',
  mentionedHandle
}: {
  readonly id: string;
  readonly authorId?: string;
  readonly content?: string;
  readonly mentionedHandle?: string;
}): ApiDrop {
  return {
    id,
    wave: {
      id: 'wave-1'
    },
    author: {
      id: authorId
    },
    parts: [
      {
        content
      }
    ],
    mentioned_users: mentionedHandle
      ? [
          {
            mentioned_profile_id: 'bot-profile',
            handle_in_content: mentionedHandle,
            current_handle: mentionedHandle
          }
        ]
      : []
  } as unknown as ApiDrop;
}

describe('detectHelpBotTrigger', () => {
  it('detects explicit raw text mentions and strips the bot handle', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('@help6529 what is TDH?'),
      createdDrop: createDrop({ id: 'drop-1' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger).toEqual({
      triggerDropId: 'drop-1',
      targetDropId: 'drop-1',
      waveId: 'wave-1',
      authorProfileId: 'user-profile',
      question: 'what is TDH?',
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  });

  it('detects bracketed markdown mentions and strips the bot handle', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('@[help6529] what is TDH?'),
      createdDrop: createDrop({ id: 'drop-1' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger).toEqual({
      triggerDropId: 'drop-1',
      targetDropId: 'drop-1',
      waveId: 'wave-1',
      authorProfileId: 'user-profile',
      question: 'what is TDH?',
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  });

  it('detects explicit payload mentions without raw text mention', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('How do subscriptions work?', {
        mentionedHandle: 'help6529'
      }),
      createdDrop: createDrop({ id: 'drop-2' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger?.triggerType).toBe(HelpBotInteractionTriggerType.MENTION);
    expect(trigger?.targetDropId).toBe('drop-2');
    expect(trigger?.question).toBe('How do subscriptions work?');
  });

  it('detects persisted mentions on the created drop', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('How do subscriptions work?'),
      createdDrop: createDrop({
        id: 'drop-2',
        mentionedHandle: 'help6529'
      }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger?.triggerType).toBe(HelpBotInteractionTriggerType.MENTION);
    expect(trigger?.targetDropId).toBe('drop-2');
    expect(trigger?.question).toBe('How do subscriptions work?');
  });

  it('uses the parent drop as the question target when a reply only tags the bot', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('@help6529', {
        replyToDropId: 'original-question'
      }),
      createdDrop: createDrop({ id: 'summon-drop', authorId: 'summoner' }),
      parentDrop: createDrop({
        id: 'original-question',
        authorId: 'question-author',
        content: 'what is tdh'
      }),
      authorProfileId: 'summoner',
      botProfileId: 'bot-profile'
    });

    expect(trigger).toEqual({
      triggerDropId: 'summon-drop',
      targetDropId: 'original-question',
      waveId: 'wave-1',
      authorProfileId: 'summoner',
      question: 'what is tdh',
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  });

  it('adds parent context for explicit validation prompts in reply threads', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('@help6529 is this right', {
        replyToDropId: 'claim-drop'
      }),
      createdDrop: createDrop({ id: 'summon-drop', authorId: 'summoner' }),
      parentDrop: createDrop({
        id: 'claim-drop',
        authorId: 'claim-author',
        content: 'TDH stands for Total Dynamic Head'
      }),
      authorProfileId: 'summoner',
      botProfileId: 'bot-profile'
    });

    expect(trigger).toEqual({
      triggerDropId: 'summon-drop',
      targetDropId: 'summon-drop',
      waveId: 'wave-1',
      authorProfileId: 'summoner',
      question:
        'is this right\n\nContext from the replied-to drop: TDH stands for Total Dynamic Head',
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  });

  it('detects direct replies to bot drops without requiring a mention', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('What defines eligibility?', {
        replyToDropId: 'bot-drop'
      }),
      createdDrop: createDrop({ id: 'drop-3' }),
      parentDrop: createDrop({ id: 'bot-drop', authorId: 'bot-profile' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger?.triggerType).toBe(HelpBotInteractionTriggerType.BOT_REPLY);
    expect(trigger?.targetDropId).toBe('drop-3');
    expect(trigger?.parentBotDropId).toBe('bot-drop');
  });

  it('ignores bot authored drops and acknowledgement replies', () => {
    expect(
      detectHelpBotTrigger({
        request: createRequest('@help6529 what is TDH?'),
        createdDrop: createDrop({ id: 'drop-4', authorId: 'bot-profile' }),
        authorProfileId: 'bot-profile',
        botProfileId: 'bot-profile'
      })
    ).toBeNull();

    expect(
      detectHelpBotTrigger({
        request: createRequest('thanks', { replyToDropId: 'bot-drop' }),
        createdDrop: createDrop({ id: 'drop-5' }),
        parentDrop: createDrop({ id: 'bot-drop', authorId: 'bot-profile' }),
        authorProfileId: 'user-profile',
        botProfileId: 'bot-profile'
      })
    ).toBeNull();
  });
});
