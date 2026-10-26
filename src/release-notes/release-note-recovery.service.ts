import {
  ReleaseNoteRecoveryJobEntity,
  ReleaseNoteRecoveryStatus
} from '@/entities/IReleaseNoteRecoveryJob';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  DeferredReleaseNoteError,
  isNonRetryableReleaseNoteError,
  NonRetryableReleaseNoteError,
  NoReleaseNoteBaselineError,
  ReleaseNoteDependencyError,
  UntrustedReleaseNoteMetadataError
} from '@/release-notes/release-note-errors';
import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import { buildReleaseNotePublicationId } from '@/release-notes/release-note-generation.service';
import { ReleaseNoteRecoveryDb } from '@/release-notes/release-note-recovery.db';
import * as sentryContext from '@/sentry.context';

type ProcessReleaseNote = (
  request: ReleaseNoteGenerationRequest
) => Promise<void>;
type PostRecoveryFailure = (
  request: ReleaseNoteGenerationRequest,
  error: unknown,
  failures: number
) => Promise<void>;
type EnqueueRecoveryRetry = (
  request: ReleaseNoteGenerationRequest,
  delayMs: number
) => Promise<void>;
type RecoveryRepository = Pick<
  ReleaseNoteRecoveryDb,
  | 'enqueue'
  | 'findDue'
  | 'findEarlier'
  | 'findNextPending'
  | 'recordOutcome'
  | 'markAlerted'
  | 'deferAlert'
  | 'requestRetry'
>;

const FAILURE_ALERT_THRESHOLD = 5;
const DEFER_DELAY_MS = 5 * 60_000;

function recoveryStatus(error: unknown): ReleaseNoteRecoveryStatus {
  if (error instanceof NoReleaseNoteBaselineError) return 'NO_BASELINE';
  if (error instanceof UntrustedReleaseNoteMetadataError) return 'REJECTED';
  if (isNonRetryableReleaseNoteError(error)) return 'FAILED';
  return 'PENDING';
}

function recoveryDelay(error: unknown, failures: number): number {
  if (error instanceof DeferredReleaseNoteError) return DEFER_DELAY_MS;
  const dependencyDelay =
    error instanceof ReleaseNoteDependencyError ? error.retryAfterMs : 0;
  return Math.max(
    dependencyDelay,
    Math.min(60_000 * 2 ** Math.min(failures - 1, 6), 3_600_000)
  );
}

export class ReleaseNoteRecoveryService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: RecoveryRepository,
    private readonly postFailure: PostRecoveryFailure,
    private readonly enqueueRetry: EnqueueRecoveryRetry,
    private readonly now: () => number = Date.now
  ) {}

  public async process(
    request: ReleaseNoteGenerationRequest,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<void> {
    // Persist the envelope before processing. Pending work must enqueue its
    // next delivery successfully before this SQS delivery can be acknowledged.
    const job = await this.repository.enqueue(
      buildReleaseNotePublicationId(request),
      request,
      this.now(),
      ctx
    );
    await this.runJob(job, process, ctx);
  }

  public async recoverDue(
    process: ProcessReleaseNote,
    getRemainingTimeInMillis: () => number,
    ctx: RequestContext
  ): Promise<void> {
    const jobs = await this.repository.findDue(this.now(), ctx);
    for (const job of jobs) {
      if (getRemainingTimeInMillis() < 45_000) break;
      try {
        await this.runJob(job, process, ctx);
      } catch (error) {
        this.logger.error(
          'Release-note recovery could not finish; saved job remains available',
          {
            publication_id: job.publication_id,
            error: error instanceof Error ? error.message : String(error)
          }
        );
      }
    }
  }

  public async retry(
    publicationId: string,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<void> {
    const job = await this.repository.requestRetry(
      publicationId,
      this.now(),
      ctx
    );
    if (!job)
      throw new NonRetryableReleaseNoteError(
        `Release-note recovery job ${publicationId} does not exist`
      );
    await this.runJob(job, process, ctx);
  }

  private async runJob(
    job: ReleaseNoteRecoveryJobEntity,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<void> {
    const request = JSON.parse(
      job.request_json
    ) as ReleaseNoteGenerationRequest;
    if (job.status !== 'PENDING') {
      await this.finishTerminalJob(job, request, ctx);
      return;
    }
    if (Number(job.next_attempt_at) > this.now()) {
      await this.enqueueRetry(
        request,
        Number(job.next_attempt_at) - this.now()
      );
      return;
    }
    if (await this.resumePredecessor(job, process, ctx)) return;
    await this.publishPendingJob(job, request, process, ctx);
  }

  private async finishTerminalJob(
    job: ReleaseNoteRecoveryJobEntity,
    request: ReleaseNoteGenerationRequest,
    ctx: RequestContext
  ): Promise<void> {
    const needsAlert =
      (job.status === 'FAILED' || job.status === 'NO_BASELINE') &&
      job.alerted_at === null;
    if (!needsAlert) {
      if (job.status !== 'FAILED') await this.wakeNext(job, ctx);
      return;
    }
    if (Number(job.next_attempt_at) > this.now()) {
      await this.enqueueRetry(
        request,
        Number(job.next_attempt_at) - this.now()
      );
      return;
    }
    const alertError =
      job.status === 'NO_BASELINE'
        ? new NoReleaseNoteBaselineError(
            job.last_error ?? 'No earlier production baseline'
          )
        : new NonRetryableReleaseNoteError(
            job.last_error ?? 'Release-note publication failed'
          );
    if (
      !(await this.tryPostFailure(
        job,
        request,
        alertError,
        job.failure_count,
        ctx
      ))
    ) {
      await this.deferFailureAlert(job, request, ctx);
    }
    if (job.status === 'NO_BASELINE') await this.wakeNext(job, ctx);
  }

  private async resumePredecessor(
    job: ReleaseNoteRecoveryJobEntity,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<boolean> {
    const earlier = await this.repository.findEarlier(job, ctx);
    if (!earlier) return false;
    // Park successors rather than repeatedly waking them to check the blocker.
    // Completing the predecessor queues the next saved run.
    await this.repository.recordOutcome(
      job.publication_id,
      {
        status: 'PENDING',
        failures: job.failure_count,
        nextAttemptAt: this.now(),
        lastError: `Release-note run ${earlier.run_number} must complete before run ${job.run_number}; blocking publication ${earlier.publication_id}`
      },
      this.now(),
      ctx
    );
    await this.runJob(earlier, process, ctx);
    return true;
  }

  private async publishPendingJob(
    job: ReleaseNoteRecoveryJobEntity,
    request: ReleaseNoteGenerationRequest,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<void> {
    try {
      await process(request);
      await this.repository.recordOutcome(
        job.publication_id,
        {
          status: 'COMPLETED',
          failures: job.failure_count,
          nextAttemptAt: this.now(),
          lastError: null
        },
        this.now(),
        ctx
      );
      this.logger.info('Release-note recovery completed', {
        publication_id: job.publication_id,
        repo: request.repo,
        run_id: request.run_id
      });
    } catch (error) {
      await this.handleFailure(job, request, error, ctx);
      const status = recoveryStatus(error);
      if (status === 'NO_BASELINE' || status === 'REJECTED')
        await this.wakeNext(job, ctx);
      return;
    }
    // Keep the handoff outside the processing catch: a queue failure must not
    // turn an already completed publication into another processing failure.
    await this.wakeNext(job, ctx);
  }

  private async tryPostFailure(
    job: ReleaseNoteRecoveryJobEntity,
    request: ReleaseNoteGenerationRequest,
    error: unknown,
    failures: number,
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      if (!(error instanceof UntrustedReleaseNoteMetadataError)) {
        await this.postFailure(request, error, failures);
      }
      await this.repository.markAlerted(job.publication_id, this.now(), ctx);
      return true;
    } catch (alertError) {
      this.logger.warn('Release-note failure alert deferred', alertError);
      return false;
    }
  }

  private async deferFailureAlert(
    job: ReleaseNoteRecoveryJobEntity,
    request: ReleaseNoteGenerationRequest,
    ctx: RequestContext
  ): Promise<void> {
    await this.repository.deferAlert(
      job.publication_id,
      this.now() + DEFER_DELAY_MS,
      this.now(),
      ctx
    );
    await this.enqueueRetry(request, DEFER_DELAY_MS);
  }

  private async wakeNext(
    job: ReleaseNoteRecoveryJobEntity,
    ctx: RequestContext
  ): Promise<void> {
    const next = await this.repository.findNextPending(job, ctx);
    if (!next) return;
    await this.enqueueRetry(
      JSON.parse(next.request_json) as ReleaseNoteGenerationRequest,
      Math.max(0, Number(next.next_attempt_at) - this.now())
    );
  }

  private async handleFailure(
    job: ReleaseNoteRecoveryJobEntity,
    request: ReleaseNoteGenerationRequest,
    error: unknown,
    ctx: RequestContext
  ): Promise<void> {
    const deferred = error instanceof DeferredReleaseNoteError;
    const permanent = isNonRetryableReleaseNoteError(error);
    const failures = job.failure_count + (deferred ? 0 : 1);
    const delay = recoveryDelay(error, failures);
    const message = error instanceof Error ? error.message : String(error);
    await this.repository.recordOutcome(
      job.publication_id,
      {
        status: recoveryStatus(error),
        failures,
        nextAttemptAt: this.now() + delay,
        lastError: message.slice(0, 4000)
      },
      this.now(),
      ctx
    );
    const diagnostic = {
      publication_id: job.publication_id,
      repo: request.repo,
      run_id: request.run_id,
      failure_count: failures,
      reason: deferred ? error.code : 'PUBLICATION_FAILED',
      next_attempt_at: permanent
        ? null
        : new Date(this.now() + delay).toISOString(),
      error: message
    };
    if (deferred) {
      this.logger.info(
        'Release-note publication deferred; request retained for recovery',
        diagnostic
      );
    } else {
      this.logger.warn(
        'Release-note publication failed; durable recovery state saved',
        diagnostic
      );
    }
    if (
      (permanent || failures >= FAILURE_ALERT_THRESHOLD) &&
      job.alerted_at === null
    ) {
      sentryContext.captureException(error);
      const alerted = await this.tryPostFailure(
        job,
        request,
        error,
        failures,
        ctx
      );
      if (!alerted && permanent) {
        await this.deferFailureAlert(job, request, ctx);
        return;
      }
    }
    if (!permanent) await this.enqueueRetry(request, delay);
  }
}
