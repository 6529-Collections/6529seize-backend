import { ReleaseNoteRecoveryJobEntity } from '@/entities/IReleaseNoteRecoveryJob';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  DeferredReleaseNoteError,
  isNonRetryableReleaseNoteError,
  NonRetryableReleaseNoteError,
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
  | 'requestRetry'
>;

const FAILURE_ALERT_THRESHOLD = 5;
const DEFER_DELAY_MS = 5 * 60_000;

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
      await this.runJob(job, process, ctx);
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
    if (job.status === 'FAILED' && job.alerted_at === null) {
      await this.postFailure(
        request,
        new NonRetryableReleaseNoteError(
          job.last_error ?? 'Release-note publication failed'
        ),
        job.failure_count
      );
      await this.repository.markAlerted(job.publication_id, this.now(), ctx);
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
    const delay = deferred
      ? DEFER_DELAY_MS
      : Math.max(
          error instanceof ReleaseNoteDependencyError ? error.retryAfterMs : 0,
          Math.min(60_000 * 2 ** Math.min(failures - 1, 6), 3_600_000)
        );
    const message = error instanceof Error ? error.message : String(error);
    await this.repository.recordOutcome(
      job.publication_id,
      {
        status:
          error instanceof UntrustedReleaseNoteMetadataError
            ? 'REJECTED'
            : permanent
              ? 'FAILED'
              : 'PENDING',
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
