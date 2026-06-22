import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  HELP_BOT_BASE_URL,
  HELP_BOT_BEDROCK_MODEL_ID,
  HELP_BOT_FAILURE_REACTION,
  HELP_BOT_OUT_OF_SCOPE_REPLY,
  HELP_BOT_SUCCESS_REACTION,
  HELP_BOT_TECHNICAL_FAILURE_REPLY,
  buildHelpBotNoReliableSourceReply,
  getHelpBotTechTeamMentionHandles
} from './help-bot.config';
import { HelpBotAnswerer, HelpBotLlmRenderer } from './help-bot.answerer';
import { HelpBotBedrockRenderer } from './help-bot.bedrock-renderer';
import { HelpBotCalendarService } from './help-bot-calendar.service';
import {
  HelpBotPublicDataLlm,
  HelpBotPublicDataService
} from './help-bot-public-data.service';
import {
  helpBotDropWriterService,
  HelpBotDropWriterService
} from './help-bot-drop-writer.service';
import {
  HelpBotInteractionRow,
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
import { withHelpBotAuthentication } from './help-bot.auth';
import { errorToMessage } from './help-bot.errors';
import {
  helpBotCreditsService,
  HelpBotCreditsService
} from './help-bot-credits.service';
import {
  helpBotMentionResolver,
  HelpBotMentionResolver
} from './help-bot-mention-resolver';

function buildRenderer(): HelpBotLlmRenderer & HelpBotPublicDataLlm {
  return new HelpBotBedrockRenderer(HELP_BOT_BEDROCK_MODEL_ID);
}

function extractDropText(drop: ApiDrop): string {
  return drop.parts
    .map((part) => part.content ?? '')
    .join('\n')
    .trim();
}

function getInteractionTargetDropId(
  interaction: HelpBotInteractionRow
): string {
  return interaction.target_drop_id ?? interaction.trigger_drop_id;
}

export class HelpBotProcessorService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly interactionsDb: HelpBotInteractionsDb,
    private readonly reactionService: HelpBotReactionService,
    private readonly dropWriter: HelpBotDropWriterService,
    private readonly dropsService: DropsApiService,
    private readonly profileResolver: HelpBotProfileResolver,
    private readonly answererFactory: () => HelpBotAnswerer,
    private readonly creditsService: HelpBotCreditsService,
    private readonly mentionResolver: HelpBotMentionResolver
  ) {}

  public async processInteraction(
    interactionId: string,
    ctx: RequestContext
  ): Promise<void> {
    const botProfileId = await this.profileResolver.resolveBotProfileId(ctx);
    if (!botProfileId) {
      this.logger.warn(
        `Help bot profile could not be resolved; skipping interaction ${interactionId}`
      );
      return;
    }

    const interaction = await this.interactionsDb.claimForAnswering(
      interactionId,
      ctx
    );
    if (!interaction) {
      return;
    }

    try {
      const previousBotAnswer = await this.getPreviousBotAnswer(
        interaction,
        botProfileId,
        ctx
      );
      const answer = await this.answererFactory().answer({
        question: interaction.question,
        previousBotAnswer,
        baseUrl: HELP_BOT_BASE_URL
      });
      if (answer.type === 'NO_RELIABLE_SOURCE') {
        await this.replyWithNoReliableSource({
          botProfileId,
          interaction,
          escalateToTechTeam: answer.escalateToTechTeam,
          ctx
        });
        return;
      }

      const reviewedAnswer = await this.buildReviewedAnswer({
        answer: answer.answer,
        escalateToTechTeam: answer.escalateToTechTeam ?? false,
        ctx
      });
      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId: interaction.wave_id,
          replyToDropId: getInteractionTargetDropId(interaction),
          interactionId: interaction.id,
          message: reviewedAnswer.message,
          mentionedHandles: reviewedAnswer.mentionedHandles
        },
        ctx
      );
      await this.interactionsDb.markAnswered(
        {
          id: interaction.id,
          replyDropId: reply.id
        },
        ctx
      );
      await this.trySetReaction(
        {
          botProfileId,
          dropId: getInteractionTargetDropId(interaction),
          waveId: interaction.wave_id,
          reaction: HELP_BOT_SUCCESS_REACTION
        },
        ctx
      );
    } catch (error) {
      await this.replyWithTechnicalFailure({
        botProfileId,
        interaction,
        error,
        ctx
      });
    }
  }

  private async getPreviousBotAnswer(
    interaction: HelpBotInteractionRow,
    botProfileId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    if (!interaction.parent_bot_drop_id) {
      return null;
    }
    try {
      const drop = await this.dropsService.findDropByIdOrThrow(
        {
          dropId: interaction.parent_bot_drop_id,
          skipEligibilityCheck: true
        },
        withHelpBotAuthentication(botProfileId, ctx)
      );
      return extractDropText(drop);
    } catch (error) {
      this.logger.warn(
        `Could not load parent help bot drop ${interaction.parent_bot_drop_id}`,
        error
      );
      return null;
    }
  }

  private async replyWithNoReliableSource({
    botProfileId,
    interaction,
    escalateToTechTeam,
    ctx
  }: {
    readonly botProfileId: string;
    readonly interaction: HelpBotInteractionRow;
    readonly escalateToTechTeam: boolean;
    readonly ctx: RequestContext;
  }): Promise<void> {
    const mentionedHandles = escalateToTechTeam
      ? await this.resolveTechTeamMentionHandles(ctx)
      : [];
    const reply = await this.dropWriter.reply(
      {
        botProfileId,
        waveId: interaction.wave_id,
        replyToDropId: getInteractionTargetDropId(interaction),
        interactionId: interaction.id,
        message: escalateToTechTeam
          ? buildHelpBotNoReliableSourceReply(mentionedHandles)
          : HELP_BOT_OUT_OF_SCOPE_REPLY,
        mentionedHandles
      },
      ctx
    );
    await this.interactionsDb.markNoReliableSource(
      {
        id: interaction.id,
        replyDropId: reply.id
      },
      ctx
    );
    await this.trySetReaction(
      {
        botProfileId,
        dropId: getInteractionTargetDropId(interaction),
        waveId: interaction.wave_id,
        reaction: HELP_BOT_FAILURE_REACTION
      },
      ctx
    );
  }

  private async buildReviewedAnswer({
    answer,
    escalateToTechTeam,
    ctx
  }: {
    readonly answer: string;
    readonly escalateToTechTeam: boolean;
    readonly ctx: RequestContext;
  }): Promise<{
    readonly message: string;
    readonly mentionedHandles: string[];
  }> {
    if (!escalateToTechTeam) {
      return { message: answer, mentionedHandles: [] };
    }
    const mentionedHandles = await this.resolveTechTeamMentionHandles(ctx);
    if (!mentionedHandles.length) {
      return { message: answer, mentionedHandles: [] };
    }
    const reviewLine = `I'm flagging this so the tech team can double-check: ${mentionedHandles
      .map((handle) => `@[${handle}]`)
      .join(' ')}`;
    return {
      message: `${answer}\n\n${reviewLine}`,
      mentionedHandles
    };
  }

  private async resolveTechTeamMentionHandles(
    ctx: RequestContext
  ): Promise<string[]> {
    const configuredHandles = getHelpBotTechTeamMentionHandles();
    if (!configuredHandles.length) {
      return [];
    }
    try {
      const resolvedHandles = await this.mentionResolver.resolveMentionHandles(
        configuredHandles,
        ctx
      );
      if (!resolvedHandles.length) {
        this.logger.warn(
          `No configured help bot tech team handles resolved to profiles`
        );
      }
      return resolvedHandles;
    } catch (error) {
      this.logger.error(`Failed to resolve help bot tech team handles`, error);
      return [];
    }
  }

  private async replyWithTechnicalFailure({
    botProfileId,
    interaction,
    error,
    ctx
  }: {
    readonly botProfileId: string;
    readonly interaction: HelpBotInteractionRow;
    readonly error: unknown;
    readonly ctx: RequestContext;
  }): Promise<void> {
    this.logger.error(
      `Help bot failed to answer interaction ${interaction.id}`,
      error
    );
    await this.tryRefundQuestionCredit(interaction, ctx);
    let replyDropId: string | null = null;
    try {
      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId: interaction.wave_id,
          replyToDropId: getInteractionTargetDropId(interaction),
          interactionId: interaction.id,
          message: HELP_BOT_TECHNICAL_FAILURE_REPLY
        },
        ctx
      );
      replyDropId = reply.id;
      await this.trySetReaction(
        {
          botProfileId,
          dropId: getInteractionTargetDropId(interaction),
          waveId: interaction.wave_id,
          reaction: HELP_BOT_FAILURE_REACTION
        },
        ctx
      );
    } catch (replyError) {
      this.logger.error(
        `Help bot failed to post technical failure reply for interaction ${interaction.id}`,
        replyError
      );
    }
    await this.interactionsDb.markFailed(
      {
        id: interaction.id,
        replyDropId,
        failureReason: errorToMessage(error)
      },
      ctx
    );
  }

  private async tryRefundQuestionCredit(
    interaction: HelpBotInteractionRow,
    ctx: RequestContext
  ): Promise<void> {
    try {
      await this.creditsService.refundQuestionCredit(
        {
          profileId: interaction.author_id,
          interactionId: interaction.id
        },
        ctx
      );
    } catch (error) {
      this.logger.error(
        `Failed to refund help bot credit for interaction ${interaction.id}`,
        error
      );
    }
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
}

export const helpBotProcessorService = new HelpBotProcessorService(
  helpBotInteractionsDb,
  helpBotReactionService,
  helpBotDropWriterService,
  dropsService,
  helpBotProfileResolver,
  () => {
    const renderer = buildRenderer();
    return new HelpBotAnswerer(
      renderer,
      undefined,
      new HelpBotPublicDataService(renderer),
      new HelpBotCalendarService()
    );
  },
  helpBotCreditsService,
  helpBotMentionResolver
);
