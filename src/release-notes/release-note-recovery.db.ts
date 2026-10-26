import { RELEASE_NOTE_RECOVERY_JOBS_TABLE } from '@/constants';
import {
  ReleaseNoteRecoveryJobEntity,
  ReleaseNoteRecoveryStatus
} from '@/entities/IReleaseNoteRecoveryJob';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import { createHash } from 'node:crypto';

export function recoveryStreamKey(
  request: ReleaseNoteGenerationRequest
): string {
  const repo = (
    request.repo.includes('/')
      ? request.repo
      : `6529-Collections/${request.repo}`
  ).toLowerCase();
  const branch = repo.endsWith('/6529-core')
    ? 'production-release-branches'
    : request.branch?.trim() || 'main';
  return createHash('sha256')
    .update(
      JSON.stringify([
        repo,
        request.workflow.trim().toLowerCase(),
        branch,
        request.environment.trim().toLowerCase()
      ])
    )
    .digest('hex');
}

function queryOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

export class ReleaseNoteRecoveryDb extends LazyDbAccessCompatibleService {
  public constructor(supplier: () => SqlExecutor = dbSupplier) {
    super(supplier);
  }

  public async enqueue(
    publicationId: string,
    request: ReleaseNoteGenerationRequest,
    now: number,
    ctx: RequestContext
  ): Promise<ReleaseNoteRecoveryJobEntity> {
    const runNumber = Number(request.run_number);
    if (
      !Number.isSafeInteger(runNumber) ||
      runNumber <= 0 ||
      runNumber > 0xffffffff
    ) {
      throw new TypeError(
        'A valid GitHub run number is required for durable release-note recovery'
      );
    }
    const timerName = `${this.constructor.name}->enqueue`;
    ctx.timer?.start(timerName);
    try {
      return await this.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          await this.db.execute(
            `insert into ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
           (publication_id, stream_key, run_id, run_number, request_json, status, failure_count, next_attempt_at,
            last_error, alerted_at, created_at, updated_at)
           values (:publicationId, :streamKey, :runId, :runNumber, :request, 'PENDING', 0, :now, null, null, :now, :now)
           on duplicate key update publication_id = publication_id`,
            {
              publicationId,
              streamKey: recoveryStreamKey(request),
              runId: request.run_id,
              runNumber,
              request: JSON.stringify(request),
              now
            },
            queryOptions(txCtx)
          );
          const job = await this.db.oneOrNull<ReleaseNoteRecoveryJobEntity>(
            `select * from ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
           where publication_id = :publicationId for update`,
            { publicationId },
            queryOptions(txCtx)
          );
          if (!job)
            throw new Error(
              `Release-note recovery job ${publicationId} was not saved`
            );
          return job;
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findDue(
    now: number,
    ctx: RequestContext
  ): Promise<ReleaseNoteRecoveryJobEntity[]> {
    const timerName = `${this.constructor.name}->findDue`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.execute<ReleaseNoteRecoveryJobEntity>(
        `select * from ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         where (status = 'PENDING' or (status in ('FAILED', 'NO_BASELINE') and alerted_at is null))
           and next_attempt_at <= :now
         order by next_attempt_at asc, created_at asc, publication_id asc limit 10`,
        { now },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findEarlier(
    job: ReleaseNoteRecoveryJobEntity,
    ctx: RequestContext
  ): Promise<ReleaseNoteRecoveryJobEntity | null> {
    const timerName = `${this.constructor.name}->findEarlier`;
    ctx.timer?.start(timerName);
    try {
      // Waiting jobs must order even before GitHub settles. The worker verifies
      // the queued run number against GitHub before publishing its contents.
      return await this.executeNativeQueriesInTransaction(async (connection) =>
        this.db.oneOrNull<ReleaseNoteRecoveryJobEntity>(
          `select * from ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         where stream_key = :streamKey and status in ('PENDING', 'FAILED')
           and run_number < :runNumber
         order by run_number asc limit 1 for update`,
          { streamKey: job.stream_key, runNumber: job.run_number },
          queryOptions({ ...ctx, connection })
        )
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findNextPending(
    job: ReleaseNoteRecoveryJobEntity,
    ctx: RequestContext
  ): Promise<ReleaseNoteRecoveryJobEntity | null> {
    const timerName = `${this.constructor.name}->findNextPending`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.oneOrNull<ReleaseNoteRecoveryJobEntity>(
        `select * from ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         where stream_key = :streamKey and status = 'PENDING' and run_number > :runNumber
         order by run_number asc limit 1`,
        { streamKey: job.stream_key, runNumber: job.run_number },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async recordOutcome(
    publicationId: string,
    outcome: {
      readonly status: ReleaseNoteRecoveryStatus;
      readonly failures: number;
      readonly nextAttemptAt: number;
      readonly lastError: string | null;
    },
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->recordOutcome`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `update ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         set status = :status, failure_count = :failures,
             next_attempt_at = :nextAttemptAt, last_error = :lastError, updated_at = :now,
             alerted_at = case when :status in ('FAILED', 'NO_BASELINE') then null else alerted_at end
         where publication_id = :publicationId and status = 'PENDING'`,
        { publicationId, ...outcome, now },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async markAlerted(
    publicationId: string,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->markAlerted`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `update ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         set alerted_at = :now where publication_id = :publicationId`,
        { publicationId, now },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async deferAlert(
    publicationId: string,
    nextAttemptAt: number,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->deferAlert`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `update ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         set next_attempt_at = :nextAttemptAt, updated_at = :now
         where publication_id = :publicationId and status in ('FAILED', 'NO_BASELINE') and alerted_at is null`,
        { publicationId, nextAttemptAt, now },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  /** Explicit operator retry preserves the envelope, baseline and drop receipts. */
  public async requestRetry(
    publicationId: string,
    now: number,
    ctx: RequestContext
  ): Promise<ReleaseNoteRecoveryJobEntity | null> {
    const timerName = `${this.constructor.name}->requestRetry`;
    ctx.timer?.start(timerName);
    try {
      return await this.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          await this.db.execute(
            `update ${RELEASE_NOTE_RECOVERY_JOBS_TABLE}
         set status = 'PENDING', next_attempt_at = :now, failure_count = 0,
             alerted_at = null, updated_at = :now
         where publication_id = :publicationId and status <> 'COMPLETED'`,
            { publicationId, now },
            queryOptions(txCtx)
          );
          const job = await this.db.oneOrNull<ReleaseNoteRecoveryJobEntity>(
            `select * from ${RELEASE_NOTE_RECOVERY_JOBS_TABLE} where publication_id = :publicationId for update`,
            { publicationId },
            queryOptions(txCtx)
          );
          return job;
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const releaseNoteRecoveryDb = new ReleaseNoteRecoveryDb();
