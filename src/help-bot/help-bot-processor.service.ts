import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  getHelpBotConfig,
  HELP_BOT_FAILURE_REACTION,
  HELP_BOT_NO_RELIABLE_SOURCE_REPLY,
  HELP_BOT_SUCCESS_REACTION,
  HELP_BOT_TECHNICAL_FAILURE_REPLY,
  isHelpBotRuntimeReady
} from './help-bot.config';
import { HelpBotAnswerer, HelpBotLlmRenderer } from './help-bot.answerer';
import { HelpBotBedrockRenderer } from './help-bot.bedrock-renderer';
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
import { withHelpBotAuthentication } from './help-bot.auth';
import { errorToMessage } from './help-bot.errors';

function buildRenderer(): HelpBotLlmRenderer | null {
  const modelId = getHelpBotConfig().bedrockModelId;
  return modelId ? new HelpBotBedrockRenderer(modelId) : null;
}

function extractDropText(drop: ApiDrop): string {
  return drop.parts
    .map((part) => part.content ?? '')
    .join('\n')
    .trim();
}

export class HelpBotProcessorService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly interactionsDb: HelpBotInteractionsDb,
    private readonly reactionService: HelpBotReactionService,
    private readonly dropWriter: HelpBotDropWriterService,
    private readonly dropsService: DropsApiService,
    private readonly answererFactory: () => HelpBotAnswerer
  ) {}

  public async processInteraction(
    interactionId: string,
    ctx: RequestContext
  ): Promise<void> {
    const config = getHelpBotConfig();
    const botProfileId = config.botProfileId;
    if (!isHelpBotRuntimeReady(config) || !botProfileId) {
      this.logger.warn(
        `Help bot runtime is not configured; skipping interaction ${interactionId}`
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
        baseUrl: config.baseUrl
      });
      if (answer.type === 'NO_RELIABLE_SOURCE') {
        await this.replyWithNoReliableSource({
          botProfileId,
          interaction,
          ctx
        });
        return;
      }

      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId: interaction.wave_id,
          triggerDropId: interaction.trigger_drop_id,
          interactionId: interaction.id,
          message: answer.answer
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
      await this.reactionService.setReaction(
        {
          botProfileId,
          dropId: interaction.trigger_drop_id,
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
    ctx
  }: {
    readonly botProfileId: string;
    readonly interaction: HelpBotInteractionRow;
    readonly ctx: RequestContext;
  }): Promise<void> {
    const reply = await this.dropWriter.reply(
      {
        botProfileId,
        waveId: interaction.wave_id,
        triggerDropId: interaction.trigger_drop_id,
        interactionId: interaction.id,
        message: HELP_BOT_NO_RELIABLE_SOURCE_REPLY
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
    await this.reactionService.setReaction(
      {
        botProfileId,
        dropId: interaction.trigger_drop_id,
        waveId: interaction.wave_id,
        reaction: HELP_BOT_FAILURE_REACTION
      },
      ctx
    );
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
    let replyDropId: string | null = null;
    try {
      const reply = await this.dropWriter.reply(
        {
          botProfileId,
          waveId: interaction.wave_id,
          triggerDropId: interaction.trigger_drop_id,
          interactionId: interaction.id,
          message: HELP_BOT_TECHNICAL_FAILURE_REPLY
        },
        ctx
      );
      replyDropId = reply.id;
      await this.reactionService.setReaction(
        {
          botProfileId,
          dropId: interaction.trigger_drop_id,
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
}

export const helpBotProcessorService = new HelpBotProcessorService(
  helpBotInteractionsDb,
  helpBotReactionService,
  helpBotDropWriterService,
  dropsService,
  () => new HelpBotAnswerer(buildRenderer())
);
