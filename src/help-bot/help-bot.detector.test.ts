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
  authorId = 'user-profile'
}: {
  readonly id: string;
  readonly authorId?: string;
}): ApiDrop {
  return {
    id,
    wave: {
      id: 'wave-1'
    },
    author: {
      id: authorId
    },
    parts: []
  } as unknown as ApiDrop;
}

describe('detectHelpBotTrigger', () => {
  it('detects explicit raw text mentions and strips the bot handle', () => {
    const trigger = detectHelpBotTrigger({
      request: createRequest('@6529help what is TDH?'),
      createdDrop: createDrop({ id: 'drop-1' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger).toEqual({
      triggerDropId: 'drop-1',
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
        mentionedHandle: '6529help'
      }),
      createdDrop: createDrop({ id: 'drop-2' }),
      authorProfileId: 'user-profile',
      botProfileId: 'bot-profile'
    });

    expect(trigger?.triggerType).toBe(HelpBotInteractionTriggerType.MENTION);
    expect(trigger?.question).toBe('How do subscriptions work?');
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
    expect(trigger?.parentBotDropId).toBe('bot-drop');
  });

  it('ignores bot authored drops and acknowledgement replies', () => {
    expect(
      detectHelpBotTrigger({
        request: createRequest('@6529help what is TDH?'),
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
