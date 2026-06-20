import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { sqs, SQS } from '@/sqs';
import { Time } from '@/time';
import {
  HELP_BOT_FAILURE_REACTION,
  HELP_BOT_INSUFFICIENT_CREDITS_REACTION,
  HELP_BOT_INSUFFICIENT_CREDITS_REPLY,
  HELP_BOT_REPLY_QUEUE_NAME,
  HELP_BOT_SEEN_REACTION,
  HELP_BOT_SPAM_REACTION,
  HELP_BOT_USER_SPAM_MAX_TRIGGERS_PER_WINDOW,
  HELP_BOT_USER_SPAM_WINDOW_MS,
  HELP_BOT_TECHNICAL_FAILURE_REPLY
} from './help-bot.config';
import {
  helpBotCreditsService,
  HelpBotCreditsService
} from './help-bot-credits.service';
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
    private readonly profileResolver: HelpBotProfileResolver,
    private readonly wavesDb: WavesApiDb,
    private readonly creditsService: HelpBotCreditsService
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
        this.logger.info(
          `Help bot trigger skipped for drop ${createdDrop.id}: bot profile not resolved`
        );
        return;
      }
      if (!(await this.isPublicHelpBotWave(createdDrop.wave.id, ctx))) {
        this.logger.info(
          `Help bot trigger skipped for drop ${createdDrop.id}: non-public wave ${createdDrop.wave.id}`
        );
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
        this.logger.info(
          `Help bot trigger skipped for drop ${createdDrop.id}: no trigger detected`
        );
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
        this.logger.info(
          `Help bot trigger skipped for drop ${createdDrop.id}: interaction ${interaction.id} already exists`
        );
        return;
      }

      if (await this.isSpamSuppressed(trigger.authorProfileId, ctx)) {
        await this.interactionsDb.markSpamSuppressed(
          {
            id: interaction.id,
            failureReason: `Author exceeded ${HELP_BOT_USER_SPAM_MAX_TRIGGERS_PER_WINDOW} help bot triggers in ${HELP_BOT_USER_SPAM_WINDOW_MS}ms`
          },
          ctx
        );
        await this.trySetReaction(
          {
            botProfileId,
            dropId: trigger.triggerDropId,
            waveId: trigger.waveId,
            reaction: HELP_BOT_SPAM_REACTION
          },
          ctx
        );
        this.logger.info(
          `Help bot trigger spam-suppressed drop ${createdDrop.id} interaction ${interaction.id}`
        );
        return;
      }

      const chargeResult = await this.tryChargeQuestionCredit(
        {
          botProfileId,
          interaction,
          authorProfileId: trigger.authorProfileId,
          triggerDropId: trigger.triggerDropId,
          waveId: trigger.waveId
        },
        ctx
      );
      if (!chargeResult) {
        return;
      }

      await this.trySetReaction(
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
        this.logger.info(
          `Help bot trigger queued drop ${createdDrop.id} interaction ${interaction.id}`
        );
      } catch (error) {
        await this.handleEnqueueFailure({
          botProfileId,
          interactionId: interaction.id,
          targetDropId: trigger.targetDropId,
          waveId: trigger.waveId,
          authorProfileId: trigger.authorProfileId,
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
          dropId: parentDropId
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

  private async isPublicHelpBotWave(
    waveId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const wave = await this.wavesDb.findWaveById(waveId, ctx.connection);
    if (!wave) {
      this.logger.warn(`Could not resolve wave ${waveId} for help bot trigger`);
      return false;
    }
    if (wave.visibility_group_id || wave.is_direct_message === true) {
      return false;
    }
    return true;
  }

  private async isSpamSuppressed(
    authorProfileId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const recentInteractionCount =
      await this.interactionsDb.countRecentByAuthor(
        {
          authorProfileId,
          sinceMillis: Time.currentMillis() - HELP_BOT_USER_SPAM_WINDOW_MS
        },
        ctx
      );
    return recentInteractionCount > HELP_BOT_USER_SPAM_MAX_TRIGGERS_PER_WINDOW;
  }

  private async trySetReaction(
    {
      botProfileId,
      dropId,
      waveId,
      reaction
    }: {
      readonly botProfileId: string;
      readonly dropId: string;
      readonly waveId: string;
      readonly reaction: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      await this.reactionService.setReaction(
        {
          botProfileId,
          dropId,
          waveId,
          reaction
        },
        ctx
      );
    } catch (error) {
      this.logger.error(
        `Failed to set help bot reaction ${reaction} on drop ${dropId}`,
        error
      );
    }
  }

  private async tryChargeQuestionCredit(
    {
      botProfileId,
      interaction,
      authorProfileId,
      triggerDropId,
      waveId
    }: {
      readonly botProfileId: string;
      readonly interaction: { readonly id: string };
      readonly authorProfileId: string;
      readonly triggerDropId: string;
      readonly waveId: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      const chargeResult = await this.creditsService.chargeQuestionCredit(
        {
          profileId: authorProfileId,
          interactionId: interaction.id
        },
        ctx
      );
      if (chargeResult.charged) {
        return true;
      }
      await this.handleInsufficientCredits({
        botProfileId,
        interactionId: interaction.id,
        triggerDropId,
        waveId,
        balance: chargeResult.balance,
        ctx
      });
      return false;
    } catch (error) {
      await this.handleEnqueueFailure({
        botProfileId,
        interactionId: interaction.id,
        targetDropId: triggerDropId,
        waveId,
        authorProfileId,
        error,
        ctx
      });
      return false;
    }
  }

  private async handleInsufficientCredits({
    botProfileId,
    interactionId,
    triggerDropId,
    waveId,
    balance,
    ctx
  }: {
    readonly botProfileId: string;
    readonly interactionId: string;
    readonly triggerDropId: string;
    readonly waveId: string;
    readonly balance: number | null;
    readonly ctx: RequestContext;
  }): Promise<void> {
    await this.trySetReaction(
      {
        botProfileId,
        dropId: triggerDropId,
        waveId,
        reaction: HELP_BOT_INSUFFICIENT_CREDITS_REACTION
      },
      ctx
    );
    let replyDropId: string | null = null;
    try {
      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId,
          replyToDropId: triggerDropId,
          interactionId,
          message: HELP_BOT_INSUFFICIENT_CREDITS_REPLY
        },
        ctx
      );
      replyDropId = reply.id;
    } catch (error) {
      this.logger.error(
        `Failed to post help bot insufficient-credits reply for interaction ${interactionId}`,
        error
      );
    }
    await this.interactionsDb.markInsufficientCredits(
      {
        id: interactionId,
        replyDropId,
        failureReason: `Help bot credit balance ${balance ?? 'unknown'} is below the question cost`
      },
      ctx
    );
  }

  private async handleEnqueueFailure({
    botProfileId,
    interactionId,
    targetDropId,
    waveId,
    authorProfileId,
    error,
    ctx
  }: {
    readonly botProfileId: string;
    readonly interactionId: string;
    readonly targetDropId: string;
    readonly waveId: string;
    readonly authorProfileId: string;
    readonly error: unknown;
    readonly ctx: RequestContext;
  }): Promise<void> {
    this.logger.error(
      `Failed to enqueue help bot interaction ${interactionId}`,
      error
    );
    await this.trySetReaction(
      {
        botProfileId,
        dropId: targetDropId,
        waveId,
        reaction: HELP_BOT_FAILURE_REACTION
      },
      ctx
    );
    try {
      await this.creditsService.refundQuestionCredit(
        {
          profileId: authorProfileId,
          interactionId
        },
        ctx
      );
    } catch (refundError) {
      this.logger.error(
        `Failed to refund help bot credit for enqueue failure ${interactionId}`,
        refundError
      );
    }
    try {
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
  helpBotProfileResolver,
  wavesApiDb,
  helpBotCreditsService
);
