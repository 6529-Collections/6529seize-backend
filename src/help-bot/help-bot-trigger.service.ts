import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { sqs, SQS } from '@/sqs';
import {
  HELP_BOT_FAILURE_REACTION,
  HELP_BOT_REPLY_QUEUE_NAME,
  HELP_BOT_SEEN_REACTION,
  HELP_BOT_TECHNICAL_FAILURE_REPLY
} from './help-bot.config';
import { detectHelpBotTrigger } from './help-bot.detector';
import {
  helpBotDropWriterService,
  HelpBotDropWriterService
} from './help-bot-drop-writer.service';
import { errorToMessage } from './help-bot.errors';
import {
  helpBotInteractionsDb,
  HelpBotInteractionsDb
} from './help-bot-interactions.db';
import {
  helpBotReactionService,
  HelpBotReactionService
} from './help-bot-reaction.service';
import {
  helpBotProfileResolver,
  HelpBotProfileResolver
} from './help-bot-profile-resolver';

export class HelpBotTriggerService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly interactionsDb: HelpBotInteractionsDb,
    private readonly reactionService: HelpBotReactionService,
    private readonly dropWriter: HelpBotDropWriterService,
    private readonly dropsService: DropsApiService,
    private readonly sqs: SQS,
    private readonly profileResolver: HelpBotProfileResolver
  ) {}

  public async handleCreatedDrop(
    {
      createDropRequest,
      createdDrop,
      authorProfileId
    }: {
      readonly createDropRequest: ApiCreateDropRequest;
      readonly createdDrop: ApiDrop;
      readonly authorProfileId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      const botProfileId = await this.profileResolver.resolveBotProfileId(ctx);
      if (!botProfileId) {
        return;
      }
      const parentDrop = await this.findParentDrop(createDropRequest, ctx);
      const trigger = detectHelpBotTrigger({
        request: createDropRequest,
        createdDrop,
        authorProfileId,
        botProfileId,
        parentDrop
      });
      if (!trigger) {
        return;
      }

      const { interaction, created } = await this.interactionsDb.insertSeen(
        {
          triggerDropId: trigger.triggerDropId,
          targetDropId: trigger.targetDropId,
          waveId: trigger.waveId,
          authorProfileId: trigger.authorProfileId,
          triggerType: trigger.triggerType,
          question: trigger.question,
          parentBotDropId: trigger.parentBotDropId
        },
        ctx
      );
      if (!created) {
        return;
      }

      await this.reactionService.setReaction(
        {
          botProfileId,
          dropId: trigger.targetDropId,
          waveId: trigger.waveId,
          reaction: HELP_BOT_SEEN_REACTION
        },
        ctx
      );

      try {
        await this.sqs.sendToQueueName({
          queueName: HELP_BOT_REPLY_QUEUE_NAME,
          message: { interaction_id: interaction.id }
        });
      } catch (error) {
        await this.handleEnqueueFailure({
          botProfileId,
          interactionId: interaction.id,
          targetDropId: trigger.targetDropId,
          waveId: trigger.waveId,
          error,
          ctx
        });
      }
    } catch (error) {
      this.logger.error(
        `Help bot trigger failed for drop ${createdDrop.id}`,
        error
      );
    }
  }

  private async findParentDrop(
    createDropRequest: ApiCreateDropRequest,
    ctx: RequestContext
  ): Promise<ApiDrop | null> {
    const parentDropId = createDropRequest.reply_to?.drop_id;
    if (!parentDropId) {
      return null;
    }
    try {
      return await this.dropsService.findDropByIdOrThrow(
        {
          dropId: parentDropId,
          skipEligibilityCheck: true
        },
        ctx
      );
    } catch (error) {
      this.logger.warn(
        `Could not resolve parent drop ${parentDropId} for help bot trigger detection`,
        error
      );
      return null;
    }
  }

  private async handleEnqueueFailure({
    botProfileId,
    interactionId,
    targetDropId,
    waveId,
    error,
    ctx
  }: {
    readonly botProfileId: string;
    readonly interactionId: string;
    readonly targetDropId: string;
    readonly waveId: string;
    readonly error: unknown;
    readonly ctx: RequestContext;
  }): Promise<void> {
    this.logger.error(
      `Failed to enqueue help bot interaction ${interactionId}`,
      error
    );
    try {
      await this.reactionService.setReaction(
        {
          botProfileId,
          dropId: targetDropId,
          waveId,
          reaction: HELP_BOT_FAILURE_REACTION
        },
        ctx
      );
      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId,
          replyToDropId: targetDropId,
          interactionId,
          message: HELP_BOT_TECHNICAL_FAILURE_REPLY
        },
        ctx
      );
      await this.interactionsDb.markFailed(
        {
          id: interactionId,
          replyDropId: reply.id,
          failureReason: `Failed to enqueue help bot answer: ${errorToMessage(
            error
          )}`
        },
        ctx
      );
    } catch (failureReplyError) {
      this.logger.error(
        `Failed to post help bot enqueue-failure reply for interaction ${interactionId}`,
        failureReplyError
      );
    }
  }
}

export const helpBotTriggerService = new HelpBotTriggerService(
  helpBotInteractionsDb,
  helpBotReactionService,
  helpBotDropWriterService,
  dropsService,
  sqs,
  helpBotProfileResolver
);
