import { HELP_BOT_INTERACTIONS_TABLE } from '@/constants';
import {
  HelpBotInteractionStatus,
  HelpBotInteractionTriggerType
} from '@/entities/IHelpBotInteraction';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import { HELP_BOT_KNOWLEDGE_VERSION } from './help-bot.config';

export interface HelpBotInteractionRow {
  readonly id: string;
  readonly trigger_drop_id: string;
  readonly wave_id: string;
  readonly author_id: string;
  readonly trigger_type: HelpBotInteractionTriggerType;
  readonly question: string;
  readonly parent_bot_drop_id: string | null;
  readonly bot_reply_drop_id: string | null;
  readonly status: HelpBotInteractionStatus;
  readonly knowledge_version: string;
  readonly failure_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly answer_started_at: number | null;
  readonly completed_at: number | null;
}

export interface InsertHelpBotInteractionRequest {
  readonly triggerDropId: string;
  readonly waveId: string;
  readonly authorProfileId: string;
  readonly triggerType: HelpBotInteractionTriggerType;
  readonly question: string;
  readonly parentBotDropId: string | null;
}

export interface InsertHelpBotInteractionResult {
  readonly interaction: HelpBotInteractionRow;
  readonly created: boolean;
}

function affectedRows(result: unknown): number {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows?: unknown }).affectedRows ?? 0);
  }
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

export class HelpBotInteractionsDb extends LazyDbAccessCompatibleService {
  public async insertSeen(
    request: InsertHelpBotInteractionRequest,
    ctx: RequestContext
  ): Promise<InsertHelpBotInteractionResult> {
    const now = Time.currentMillis();
    const id = randomUUID();
    const result = await this.db.execute(
      `
        INSERT IGNORE INTO ${HELP_BOT_INTERACTIONS_TABLE}
          (
            id,
            trigger_drop_id,
            wave_id,
            author_id,
            trigger_type,
            question,
            parent_bot_drop_id,
            status,
            knowledge_version,
            created_at,
            updated_at
          )
        VALUES
          (
            :id,
            :triggerDropId,
            :waveId,
            :authorProfileId,
            :triggerType,
            :question,
            :parentBotDropId,
            :status,
            :knowledgeVersion,
            :now,
            :now
          )
      `,
      {
        id,
        triggerDropId: request.triggerDropId,
        waveId: request.waveId,
        authorProfileId: request.authorProfileId,
        triggerType: request.triggerType,
        question: request.question,
        parentBotDropId: request.parentBotDropId,
        status: HelpBotInteractionStatus.SEEN,
        knowledgeVersion: HELP_BOT_KNOWLEDGE_VERSION,
        now
      },
      { wrappedConnection: ctx.connection }
    );
    const interaction = await this.findByTriggerDropIdOrThrow(
      request.triggerDropId,
      ctx
    );
    return {
      interaction,
      created: affectedRows(result) > 0
    };
  }

  public async findById(
    id: string,
    ctx: RequestContext
  ): Promise<HelpBotInteractionRow | null> {
    return await this.db.oneOrNull<HelpBotInteractionRow>(
      `
        SELECT *
        FROM ${HELP_BOT_INTERACTIONS_TABLE}
        WHERE id = :id
      `,
      { id },
      { wrappedConnection: ctx.connection }
    );
  }

  private async findByTriggerDropIdOrThrow(
    triggerDropId: string,
    ctx: RequestContext
  ): Promise<HelpBotInteractionRow> {
    const row = await this.db.oneOrNull<HelpBotInteractionRow>(
      `
        SELECT *
        FROM ${HELP_BOT_INTERACTIONS_TABLE}
        WHERE trigger_drop_id = :triggerDropId
      `,
      { triggerDropId },
      { wrappedConnection: ctx.connection }
    );
    if (!row) {
      throw new Error(
        `Help bot interaction not found for trigger_drop_id=${triggerDropId}`
      );
    }
    return row;
  }

  public async claimForAnswering(
    id: string,
    ctx: RequestContext
  ): Promise<HelpBotInteractionRow | null> {
    const now = Time.currentMillis();
    const result = await this.db.execute(
      `
        UPDATE ${HELP_BOT_INTERACTIONS_TABLE}
        SET
          status = :answeringStatus,
          answer_started_at = :now,
          updated_at = :now
        WHERE id = :id
          AND status = :seenStatus
      `,
      {
        id,
        answeringStatus: HelpBotInteractionStatus.ANSWERING,
        seenStatus: HelpBotInteractionStatus.SEEN,
        now
      },
      { wrappedConnection: ctx.connection }
    );
    if (affectedRows(result) === 0) {
      return null;
    }
    return await this.findById(id, ctx);
  }

  public async markAnswered(
    {
      id,
      replyDropId
    }: {
      readonly id: string;
      readonly replyDropId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.markCompleted(
      {
        id,
        status: HelpBotInteractionStatus.ANSWERED,
        replyDropId,
        failureReason: null
      },
      ctx
    );
  }

  public async markNoReliableSource(
    {
      id,
      replyDropId
    }: {
      readonly id: string;
      readonly replyDropId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.markCompleted(
      {
        id,
        status: HelpBotInteractionStatus.NO_RELIABLE_SOURCE,
        replyDropId,
        failureReason: null
      },
      ctx
    );
  }

  public async markFailed(
    {
      id,
      replyDropId,
      failureReason
    }: {
      readonly id: string;
      readonly replyDropId: string | null;
      readonly failureReason: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.markCompleted(
      {
        id,
        status: HelpBotInteractionStatus.FAILED,
        replyDropId,
        failureReason
      },
      ctx
    );
  }

  private async markCompleted(
    {
      id,
      status,
      replyDropId,
      failureReason
    }: {
      readonly id: string;
      readonly status: HelpBotInteractionStatus;
      readonly replyDropId: string | null;
      readonly failureReason: string | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
        UPDATE ${HELP_BOT_INTERACTIONS_TABLE}
        SET
          status = :status,
          bot_reply_drop_id = :replyDropId,
          failure_reason = :failureReason,
          completed_at = :now,
          updated_at = :now
        WHERE id = :id
      `,
      {
        id,
        status,
        replyDropId,
        failureReason,
        now
      },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const helpBotInteractionsDb = new HelpBotInteractionsDb(dbSupplier);
