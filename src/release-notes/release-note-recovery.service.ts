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
type RecoveryRepository = Pick<
  ReleaseNoteRecoveryDb,
  | 'enqueue'
  | 'findDue'
  | 'findEarlier'
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
    private readonly now: () => number = Date.now
  ) {}

  public async process(
    request: ReleaseNoteGenerationRequest,
    process: ProcessReleaseNote,
    ctx: RequestContext
  ): Promise<void> {
    // A successful SQS delivery transfers ownership to this durable job. Never
    // acknowledge an unsaved request, or replace its original identity on retry.
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
    if (Number(job.next_attempt_at) > this.now()) return;
    const request = JSON.parse(
      job.request_json
    ) as ReleaseNoteGenerationRequest;
    if (
      (job.status === 'FAILED' || job.status === 'NO_BASELINE') &&
      job.alerted_at === null
    ) {
      const alertError =
        job.status === 'NO_BASELINE'
          ? new NoReleaseNoteBaselineError(
              job.last_error ?? 'No earlier production baseline'
            )
          : new NonRetryableReleaseNoteError(
              job.last_error ?? 'Release-note publication failed'
            );
      try {
        await this.postFailure(request, alertError, job.failure_count);
        await this.repository.markAlerted(job.publication_id, this.now(), ctx);
      } catch (error) {
        await this.repository.deferAlert(
          job.publication_id,
          this.now() + DEFER_DELAY_MS,
          this.now(),
          ctx
        );
        throw error;
      }
      return;
    }
    if (job.status !== 'PENDING') return;
    try {
      const earlier = await this.repository.findEarlier(job, ctx);
      if (earlier) {
        throw new DeferredReleaseNoteError(
          'PUBLICATION_BLOCKED',
          `Release-note run ${earlier.run_number} must complete before run ${job.run_number}; blocking publication ${earlier.publication_id}`
        );
      }
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
    }
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
      return;
    }
    this.logger.warn(
      'Release-note publication failed; durable recovery state saved',
      diagnostic
    );
    if (
      (permanent || failures >= FAILURE_ALERT_THRESHOLD) &&
      job.alerted_at === null
    ) {
      sentryContext.captureException(error);
      if (!(error instanceof UntrustedReleaseNoteMetadataError)) {
        await this.postFailure(request, error, failures);
      }
      await this.repository.markAlerted(job.publication_id, this.now(), ctx);
    }
  }
}
