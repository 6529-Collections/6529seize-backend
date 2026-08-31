import { HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { HelpBotDailyActivityCreditRequestStatus } from '@/entities/IHelpBotDailyActivityCreditRequest';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { sqs, SQS } from '@/sqs';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import {
  getHelpBotDailyActivitySourceId,
  helpBotCreditsService,
  HelpBotCreditsService
} from './help-bot-credits.service';

export const HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME =
  'help-bot-daily-activity-credits.fifo';
export const HELP_BOT_DAILY_ACTIVITY_CREDITS_MESSAGE_GROUP_ID =
  'help-bot-daily-activity-credits';

const MAX_PROCESSING_ATTEMPTS = 100;
const RETRY_DELAY_MS = Time.seconds(60).toMillis();
const COMPLETED_RETENTION_MS = Time.days(30).toMillis();
const CLEANUP_BATCH_SIZE = 1000;

interface PendingRequestRow {
  readonly profile_id: string;
  readonly activity_date: string;
  readonly attempts: number | string;
}

export interface ProcessDailyActivityCreditRequestResult {
  readonly processed: boolean;
  readonly failed: boolean;
  readonly dead: boolean;
  readonly hasMore: boolean;
}

export class HelpBotDailyActivityCreditQueueService extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    sqlExecutorGetter: () => SqlExecutor = dbSupplier,
    private readonly creditsService: HelpBotCreditsService = helpBotCreditsService,
    private readonly sqsClient: SQS = sqs
  ) {
    super(sqlExecutorGetter);
  }

  public async enqueueRequest(
    {
      profileId,
      requestedAt = Time.currentMillis()
    }: {
      readonly profileId: string;
      readonly requestedAt?: number;
    },
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const timerName = `${this.constructor.name}->enqueueRequest`;
    ctx.timer?.start(timerName);
    try {
      const result = await this.db.execute(
        `
          INSERT IGNORE INTO ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
            (profile_id, activity_date, status, attempts, next_attempt_at,
             last_error, requested_at, updated_at, completed_at)
          VALUES
            (:profileId, :activityDate, :status, 0, :requestedAt,
             NULL, :requestedAt, :requestedAt, NULL)
        `,
        {
          profileId,
          activityDate: getHelpBotDailyActivitySourceId(requestedAt),
          status: HelpBotDailyActivityCreditRequestStatus.PENDING,
          requestedAt
        },
        { wrappedConnection: ctx.connection }
      );
      return this.db.getAffectedRows(result) > 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async sendWakeup(ctx: RequestContext = {}): Promise<void> {
    const timerName = `${this.constructor.name}->sendWakeup`;
    ctx.timer?.start(timerName);
    try {
      await this.sqsClient.sendToQueueName({
        queueName: HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME,
        messageGroupId: HELP_BOT_DAILY_ACTIVITY_CREDITS_MESSAGE_GROUP_ID,
        message: {
          requestedAt: Time.currentMillis(),
          nonce: randomUUID()
        }
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async sendWakeupBestEffort(ctx: RequestContext = {}): Promise<void> {
    try {
      await this.sendWakeup(ctx);
    } catch (error) {
      this.logger.error(
        'Failed to wake help bot daily activity credit worker; durable requests remain queued',
        { error }
      );
    }
  }

  public async processNextRequest(
    ctx: RequestContext = {}
  ): Promise<ProcessDailyActivityCreditRequestResult> {
    const timerName = `${this.constructor.name}->processNextRequest`;
    ctx.timer?.start(timerName);
    try {
      const row = await this.getNextPendingRequest(ctx);
      if (!row) {
        return { processed: false, failed: false, dead: false, hasMore: false };
      }

      try {
        const result = await this.creditsService.grantDailyActivityCredits(
          {
            profileId: row.profile_id,
            nowMillis: this.activityDateToMillis(row.activity_date)
          },
          ctx
        );
        if (result.botProfileMissing) {
          throw new Error('Help bot profile could not be resolved');
        }
        await this.markCompleted(row, ctx);
        return {
          processed: true,
          failed: false,
          dead: false,
          hasMore: await this.hasPendingRequests(ctx)
        };
      } catch (error) {
        const dead = Number(row.attempts) + 1 >= MAX_PROCESSING_ATTEMPTS;
        await this.recordFailure(row, error, dead, ctx);
        this.logger.error('Failed to process help bot daily activity credit', {
          profileId: row.profile_id,
          activityDate: row.activity_date,
          attempt: Number(row.attempts) + 1,
          dead,
          error
        });
        return { processed: false, failed: true, dead, hasMore: false };
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async cleanupCompletedRequests(
    ctx: RequestContext = {}
  ): Promise<void> {
    const timerName = `${this.constructor.name}->cleanupCompletedRequests`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        DELETE FROM ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
        WHERE status = :completedStatus
          AND completed_at < :completedBefore
        LIMIT ${CLEANUP_BATCH_SIZE}
      `,
        {
          completedStatus: HelpBotDailyActivityCreditRequestStatus.COMPLETED,
          completedBefore: Time.currentMillis() - COMPLETED_RETENTION_MS
        },
        {
          wrappedConnection: ctx.connection,
          forcePool: DbPoolName.WRITE
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async getNextPendingRequest(
    ctx: RequestContext
  ): Promise<PendingRequestRow | null> {
    const rows = await this.db.execute<PendingRequestRow>(
      `
        SELECT profile_id, activity_date, attempts
        FROM ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
        WHERE status = :pendingStatus
          AND next_attempt_at <= :now
        ORDER BY attempts ASC, requested_at ASC, profile_id ASC
        LIMIT 1
      `,
      {
        pendingStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        now: Time.currentMillis()
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows[0] ?? null;
  }

  private async hasPendingRequests(ctx: RequestContext): Promise<boolean> {
    const rows = await this.db.execute<{ readonly profile_id: string }>(
      `
        SELECT profile_id
        FROM ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
        WHERE status = :pendingStatus
          AND next_attempt_at <= :now
        LIMIT 1
      `,
      {
        pendingStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        now: Time.currentMillis()
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows.length > 0;
  }

  private async markCompleted(
    row: PendingRequestRow,
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
        UPDATE ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
        SET status = :completedStatus,
            last_error = NULL,
            updated_at = :now,
            completed_at = :now
        WHERE profile_id = :profileId
          AND activity_date = :activityDate
          AND status = :pendingStatus
      `,
      {
        completedStatus: HelpBotDailyActivityCreditRequestStatus.COMPLETED,
        pendingStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        profileId: row.profile_id,
        activityDate: row.activity_date,
        now
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async recordFailure(
    row: PendingRequestRow,
    error: unknown,
    dead: boolean,
    ctx: RequestContext
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
        UPDATE ${HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE}
        SET status = :nextStatus,
            attempts = attempts + 1,
            next_attempt_at = :nextAttemptAt,
            last_error = :lastError,
            updated_at = :now
        WHERE profile_id = :profileId
          AND activity_date = :activityDate
          AND status = :pendingStatus
      `,
      {
        nextStatus: dead
          ? HelpBotDailyActivityCreditRequestStatus.DEAD
          : HelpBotDailyActivityCreditRequestStatus.PENDING,
        pendingStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        nextAttemptAt: now + RETRY_DELAY_MS,
        lastError: this.errorToString(error).slice(0, 2000),
        profileId: row.profile_id,
        activityDate: row.activity_date,
        now
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private activityDateToMillis(activityDate: string): number {
    const millis = Date.parse(`${activityDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(activityDate) ||
      !Number.isFinite(millis) ||
      getHelpBotDailyActivitySourceId(millis) !== activityDate
    ) {
      throw new Error(`Invalid help bot activity date: ${activityDate}`);
    }
    return millis;
  }

  private errorToString(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const helpBotDailyActivityCreditQueueService =
  new HelpBotDailyActivityCreditQueueService();
