import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
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
    })
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
});
