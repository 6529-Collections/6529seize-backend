import {
  HELP_BOT_CREDIT_EVENTS_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { HelpBotCreditEventType } from '@/entities/IHelpBotCreditEvent';
import { RateMatter } from '@/entities/IRating';
import { revokeRepBasedDropOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import {
  HELP_BOT_AUTO_CREDIT_CAP,
  HELP_BOT_CREDIT_CATEGORY,
  HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
  HELP_BOT_PROFILE_SETUP_CREDIT_GRANT,
  HELP_BOT_QUESTION_CREDIT_COST,
  HELP_BOT_SIGNUP_CREDIT_GRANT
} from './help-bot.config';
import {
  helpBotProfileResolver,
  HelpBotProfileResolver
} from './help-bot-profile-resolver';

export interface HelpBotCreditGrantResult {
  readonly amountGranted: number;
  readonly balance: number | null;
  readonly alreadyGranted: boolean;
  readonly botProfileMissing: boolean;
}

export interface HelpBotCreditChargeResult {
  readonly charged: boolean;
  readonly balance: number | null;
  readonly botProfileMissing: boolean;
}

interface AutomaticCreditGrantRequest {
  readonly profileId: string;
  readonly eventType: HelpBotCreditEventType;
  readonly sourceId: string;
  readonly amount: number;
}

export function getHelpBotDailyActivitySourceId(
  nowMillis: number = Time.currentMillis()
): string {
  return new Date(nowMillis).toISOString().slice(0, 10);
}

export class HelpBotCreditsService extends LazyDbAccessCompatibleService {
  public constructor(
    sqlExecutorGetter: () => SqlExecutor,
    private readonly profileResolver: HelpBotProfileResolver
  ) {
    super(sqlExecutorGetter);
  }

  public async grantSignupCredits(
    {
      profileId
    }: {
      readonly profileId: string;
    },
    ctx: RequestContext
  ): Promise<HelpBotCreditGrantResult> {
    return await this.grantAutomaticCredits(
      {
        profileId,
        eventType: HelpBotCreditEventType.SIGNUP_GRANT,
        sourceId: profileId,
        amount: HELP_BOT_SIGNUP_CREDIT_GRANT
      },
      ctx
    );
  }

  public async grantProfileSetupCredits(
    {
      profileId
    }: {
      readonly profileId: string;
    },
    ctx: RequestContext
  ): Promise<HelpBotCreditGrantResult> {
    return await this.grantAutomaticCredits(
      {
        profileId,
        eventType: HelpBotCreditEventType.PROFILE_SETUP_GRANT,
        sourceId: profileId,
        amount: HELP_BOT_PROFILE_SETUP_CREDIT_GRANT
      },
      ctx
    );
  }

  public async grantDailyActivityCredits(
    {
      profileId,
      nowMillis
    }: {
      readonly profileId: string;
      readonly nowMillis?: number;
    },
    ctx: RequestContext
  ): Promise<HelpBotCreditGrantResult> {
    return await this.grantAutomaticCredits(
      {
        profileId,
        eventType: HelpBotCreditEventType.DAILY_ACTIVITY_GRANT,
        sourceId: getHelpBotDailyActivitySourceId(nowMillis),
        amount: HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT
      },
      ctx
    );
  }

  public async chargeQuestionCredit(
    {
      profileId,
      interactionId
    }: {
      readonly profileId: string;
      readonly interactionId: string;
    },
    ctx: RequestContext
  ): Promise<HelpBotCreditChargeResult> {
    const botProfileId = await this.resolveBotProfileId(ctx);
    if (!botProfileId) {
      return {
        charged: false,
        balance: null,
        botProfileMissing: true
      };
    }

    return await this.withConnection(ctx, async (connection) => {
      await this.ensureBotRatingRow({ botProfileId, profileId }, connection);
      await this.getBotRatingForUpdate({ botProfileId, profileId }, connection);
      const balance = await this.getCategoryBalance(profileId, connection);
      if (balance < HELP_BOT_QUESTION_CREDIT_COST) {
        return {
          charged: false,
          balance,
          botProfileMissing: false
        };
      }

      const inserted = await this.insertCreditEvent(
        {
          profileId,
          botProfileId,
          eventType: HelpBotCreditEventType.QUESTION_SPEND,
          sourceId: interactionId,
          amount: -HELP_BOT_QUESTION_CREDIT_COST
        },
        connection
      );
      if (!inserted) {
        return {
          charged: true,
          balance,
          botProfileMissing: false
        };
      }

      await this.applyBotRatingDelta(
        {
          botProfileId,
          profileId,
          delta: -HELP_BOT_QUESTION_CREDIT_COST
        },
        connection
      );

      return {
        charged: true,
        balance: balance - HELP_BOT_QUESTION_CREDIT_COST,
        botProfileMissing: false
      };
    });
  }

  public async refundQuestionCredit(
    {
      profileId,
      interactionId
    }: {
      readonly profileId: string;
      readonly interactionId: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    const botProfileId = await this.resolveBotProfileId(ctx);
    if (!botProfileId) {
      return false;
    }

    return await this.withConnection(ctx, async (connection) => {
      const spend = await this.db.oneOrNull<{ readonly amount: number }>(
        `
          SELECT amount
          FROM ${HELP_BOT_CREDIT_EVENTS_TABLE}
          WHERE profile_id = :profileId
            AND event_type = :spendEventType
            AND source_id = :interactionId
          FOR UPDATE
        `,
        {
          profileId,
          spendEventType: HelpBotCreditEventType.QUESTION_SPEND,
          interactionId
        },
        { wrappedConnection: connection }
      );
      if (!spend || Number(spend.amount) >= 0) {
        return false;
      }

      const refundAmount = Math.abs(Number(spend.amount));
      const inserted = await this.insertCreditEvent(
        {
          profileId,
          botProfileId,
          eventType: HelpBotCreditEventType.QUESTION_REFUND,
          sourceId: interactionId,
          amount: refundAmount
        },
        connection
      );
      if (!inserted) {
        return false;
      }

      await this.ensureBotRatingRow({ botProfileId, profileId }, connection);
      await this.getBotRatingForUpdate({ botProfileId, profileId }, connection);
      await this.applyBotRatingDelta(
        { botProfileId, profileId, delta: refundAmount },
        connection
      );
      return true;
    });
  }

  private async grantAutomaticCredits(
    request: AutomaticCreditGrantRequest,
    ctx: RequestContext
  ): Promise<HelpBotCreditGrantResult> {
    const botProfileId = await this.resolveBotProfileId(ctx);
    if (!botProfileId) {
      return {
        amountGranted: 0,
        balance: null,
        alreadyGranted: false,
        botProfileMissing: true
      };
    }

    return await this.withConnection(ctx, async (connection) => {
      const inserted = await this.insertCreditEvent(
        {
          profileId: request.profileId,
          botProfileId,
          eventType: request.eventType,
          sourceId: request.sourceId,
          amount: 0
        },
        connection
      );
      if (!inserted) {
        return {
          amountGranted: 0,
          balance: await this.getCategoryBalance(request.profileId, connection),
          alreadyGranted: true,
          botProfileMissing: false
        };
      }

      await this.ensureBotRatingRow(
        { botProfileId, profileId: request.profileId },
        connection
      );
      await this.getBotRatingForUpdate(
        { botProfileId, profileId: request.profileId },
        connection
      );
      const currentBalance = await this.getCategoryBalance(
        request.profileId,
        connection
      );
      const amountGranted = Math.max(
        0,
        Math.min(request.amount, HELP_BOT_AUTO_CREDIT_CAP - currentBalance)
      );
      if (amountGranted > 0) {
        await this.applyBotRatingDelta(
          {
            botProfileId,
            profileId: request.profileId,
            delta: amountGranted
          },
          connection
        );
        await this.updateCreditEventAmount(
          {
            profileId: request.profileId,
            eventType: request.eventType,
            sourceId: request.sourceId,
            amount: amountGranted
          },
          connection
        );
      }

      return {
        amountGranted,
        balance: currentBalance + amountGranted,
        alreadyGranted: false,
        botProfileMissing: false
      };
    });
  }

  private async resolveBotProfileId(
    ctx: RequestContext
  ): Promise<string | null> {
    return await this.profileResolver.resolveBotProfileId(ctx);
  }

  private async withConnection<T>(
    ctx: RequestContext,
    executable: (connection: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    if (ctx.connection) {
      return await executable(ctx.connection);
    }
    return await this.executeNativeQueriesInTransaction(executable);
  }

  private async insertCreditEvent(
    {
      profileId,
      botProfileId,
      eventType,
      sourceId,
      amount
    }: {
      readonly profileId: string;
      readonly botProfileId: string;
      readonly eventType: HelpBotCreditEventType;
      readonly sourceId: string;
      readonly amount: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<boolean> {
    const result = await this.db.execute(
      `
        INSERT IGNORE INTO ${HELP_BOT_CREDIT_EVENTS_TABLE}
          (id, profile_id, bot_profile_id, event_type, source_id, amount, created_at)
        VALUES
          (:id, :profileId, :botProfileId, :eventType, :sourceId, :amount, :createdAt)
      `,
      {
        id: randomUUID(),
        profileId,
        botProfileId,
        eventType,
        sourceId,
        amount,
        createdAt: Time.currentMillis()
      },
      { wrappedConnection: connection }
    );
    return this.db.getAffectedRows(result) > 0;
  }

  private async updateCreditEventAmount(
    {
      profileId,
      eventType,
      sourceId,
      amount
    }: {
      readonly profileId: string;
      readonly eventType: HelpBotCreditEventType;
      readonly sourceId: string;
      readonly amount: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        UPDATE ${HELP_BOT_CREDIT_EVENTS_TABLE}
        SET amount = :amount
        WHERE profile_id = :profileId
          AND event_type = :eventType
          AND source_id = :sourceId
      `,
      {
        profileId,
        eventType,
        sourceId,
        amount
      },
      { wrappedConnection: connection }
    );
  }

  private async ensureBotRatingRow(
    {
      botProfileId,
      profileId
    }: {
      readonly botProfileId: string;
      readonly profileId: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `
        INSERT INTO ${RATINGS_TABLE}
          (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
        VALUES
          (:botProfileId, :profileId, :matter, :category, 0, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE rater_profile_id = rater_profile_id
      `,
      {
        botProfileId,
        profileId,
        matter: RateMatter.REP,
        category: HELP_BOT_CREDIT_CATEGORY
      },
      { wrappedConnection: connection }
    );
  }

  private async getBotRatingForUpdate(
    {
      botProfileId,
      profileId
    }: {
      readonly botProfileId: string;
      readonly profileId: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ readonly rating: number }>(
      `
        SELECT rating
        FROM ${RATINGS_TABLE}
        WHERE rater_profile_id = :botProfileId
          AND matter_target_id = :profileId
          AND matter = :matter
          AND matter_category = :category
        FOR UPDATE
      `,
      {
        botProfileId,
        profileId,
        matter: RateMatter.REP,
        category: HELP_BOT_CREDIT_CATEGORY
      },
      { wrappedConnection: connection }
    );
    return Number(row?.rating ?? 0);
  }

  private async getCategoryBalance(
    profileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    const row = await this.db.oneOrNull<{ readonly balance: number }>(
      `
        SELECT COALESCE(SUM(rating), 0) AS balance
        FROM ${RATINGS_TABLE}
        WHERE matter_target_id = :profileId
          AND matter = :matter
          AND matter_category = :category
      `,
      {
        profileId,
        matter: RateMatter.REP,
        category: HELP_BOT_CREDIT_CATEGORY
      },
      { wrappedConnection: connection }
    );
    return Number(row?.balance ?? 0);
  }

  private async applyBotRatingDelta(
    {
      botProfileId,
      profileId,
      delta
    }: {
      readonly botProfileId: string;
      readonly profileId: string;
      readonly delta: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (delta === 0) {
      return;
    }
    await this.db.execute(
      `
        UPDATE ${RATINGS_TABLE}
        SET rating = rating + :delta,
            last_modified = CURRENT_TIMESTAMP
        WHERE rater_profile_id = :botProfileId
          AND matter_target_id = :profileId
          AND matter = :matter
          AND matter_category = :category
      `,
      {
        botProfileId,
        profileId,
        matter: RateMatter.REP,
        category: HELP_BOT_CREDIT_CATEGORY,
        delta
      },
      { wrappedConnection: connection }
    );
    await this.db.execute(
      `
        UPDATE ${IDENTITIES_TABLE}
        SET rep = rep + :delta,
            level_raw = level_raw + :delta
        WHERE profile_id = :profileId
      `,
      {
        profileId,
        delta
      },
      { wrappedConnection: connection }
    );
    if (delta < 0) {
      await revokeRepBasedDropOverVotes(
        {
          rep_recipient_id: profileId,
          rep_giver_id: botProfileId,
          credit_category: HELP_BOT_CREDIT_CATEGORY
        },
        connection
      );
    }
  }
}

export const helpBotCreditsService = new HelpBotCreditsService(
  dbSupplier,
  helpBotProfileResolver
);
