import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipSourceJobsDb } from './membership-source-jobs.db';
import {
  MembershipSourceNotReadyError,
  MembershipSourceStatesDb
} from './membership-source-states.db';
import { MembershipSourceKey } from './membership-validation';

export const MEMBERSHIP_REPOSITORY_DIAGNOSTIC_ACTION =
  'membership_repository_diagnostics_v1';
const REQUEST_COUNT = 4;
const DIAGNOSTIC_BUDGET_MILLIS = 30_000;

export interface MembershipDiagnosticDeployment {
  readonly stage: string | undefined;
  readonly region: string | undefined;
}

export function assertMembershipDiagnosticInvocation(
  event: unknown,
  deployment: MembershipDiagnosticDeployment
): void {
  if (
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    Object.keys(event).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(event, 'operator_action') ||
    (event as { operator_action?: unknown }).operator_action !==
      MEMBERSHIP_REPOSITORY_DIAGNOSTIC_ACTION
  ) {
    throw new Error('Unsupported membership diagnostic invocation');
  }
  // The runtime region is intentionally pinned to the staging deployment.
  if (deployment.stage !== 'staging' || deployment.region !== 'eu-west-1') {
    throw new Error('Membership repository diagnostics require staging');
  }
}

function requireDiagnostic(condition: boolean, check: string): void {
  if (!condition) throw new Error(`Membership diagnostic failed: ${check}`);
}

function parseSessionLimit(value: unknown): number {
  const numeric = Number(value);
  requireDiagnostic(
    (typeof value === 'number' ||
      (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) &&
      Number.isSafeInteger(numeric) &&
      numeric >= 0,
    'restorable session limits'
  );
  return numeric;
}

async function requireUnknown(
  operation: () => Promise<unknown>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof MembershipSourceNotReadyError) return;
    throw error;
  }
  throw new Error('Membership diagnostic accepted unready source evidence');
}

interface DiagnosticFixture {
  readonly profile: string;
  readonly coalescingTarget: string;
  readonly reason: string;
  readonly bootstrap: string;
  readonly firstJob: string;
  readonly secondJob: string;
}

function newFixture(): DiagnosticFixture {
  return {
    profile: randomUUID(),
    coalescingTarget: randomUUID(),
    reason: `m2-diagnostic/${randomUUID()}`,
    bootstrap: randomUUID(),
    firstJob: randomUUID(),
    secondJob: randomUUID()
  };
}

class MembershipRepositoryDiagnostic {
  private readonly sources: MembershipSourceStatesDb;
  private readonly jobs: MembershipSourceJobsDb;
  private readonly targets: MembershipRefreshTargetsDb;
  private readonly fixture = newFixture();
  private readonly started = performance.now();
  private readonly checks: string[] = [];

  constructor(private readonly db: SqlExecutor) {
    this.sources = new MembershipSourceStatesDb(() => db);
    this.jobs = new MembershipSourceJobsDb(() => db);
    this.targets = new MembershipRefreshTargetsDb(() => db);
  }

  async run() {
    try {
      await this.sourceTransaction();
      await this.concurrentRequests();
    } finally {
      await this.cleanupTargets();
    }
    await this.assertFixturesAbsent();
    return {
      operator_action: MEMBERSHIP_REPOSITORY_DIAGNOSTIC_ACTION,
      status: 'passed' as const,
      source_scenarios: 'transaction_rolled_back' as const,
      concurrent_target_requests: REQUEST_COUNT,
      checks: this.checks,
      elapsed_millis: Math.round(performance.now() - this.started),
      fixture_cleanup: { remaining_rows: 0 }
    };
  }

  private profileKey(): MembershipSourceKey {
    return {
      scope: 'PROFILE',
      target_id: this.fixture.profile,
      dimension: 'IDENTITY'
    };
  }

  private request(targetId = this.fixture.profile) {
    return {
      scope: 'PROFILE' as const,
      target_id: targetId,
      reason: this.fixture.reason
    };
  }

  private record(check: string): void {
    requireDiagnostic(
      performance.now() - this.started < DIAGNOSTIC_BUDGET_MILLIS,
      'execution budget'
    );
    this.checks.push(check);
  }

  /**
   * Limits are restored before the connection returns to its pool. The carrier's
   * doInDbContext also disconnects its own DataSource in finally; it shares no API pool.
   */
  private async transaction<T>(
    operation: (ctx: MembershipPrimaryContext) => Promise<T>
  ): Promise<T> {
    return withMembershipPrimaryTransaction(this.db, async (ctx) => {
      const options = membershipQueryOptions(ctx);
      const [previous] = await this.db.execute<{
        lock_seconds: number | string;
        execution_millis: number | string;
      }>(
        `SELECT @@SESSION.innodb_lock_wait_timeout lock_seconds,
           @@SESSION.max_execution_time execution_millis`,
        {},
        options
      );
      // The loop driver can return strings; SET SESSION requires numeric values.
      const lockSeconds = parseSessionLimit(previous.lock_seconds);
      const executionMillis = parseSessionLimit(previous.execution_millis);
      requireDiagnostic(lockSeconds > 0, 'restorable lock timeout');
      await this.db.execute(
        'SET SESSION innodb_lock_wait_timeout = 2, SESSION max_execution_time = 1000',
        {},
        options
      );
      try {
        return await operation(ctx);
      } finally {
        await this.db.execute(
          `SET SESSION innodb_lock_wait_timeout = :lockSeconds,
             SESSION max_execution_time = :executionMillis`,
          { lockSeconds, executionMillis },
          options
        );
      }
    });
  }

  private async sourceTransaction(): Promise<void> {
    const rollback = new Error('MEMBERSHIP_DIAGNOSTIC_EXPECTED_ROLLBACK');
    try {
      await this.transaction(async (ctx) => {
        const key = this.profileKey();
        await requireUnknown(() => this.sources.capture([key], false, ctx));
        this.record('missing_source_is_unknown');
        // These GLOBAL rows/versions exist only inside the rolled-back transaction.
        // An existing active producer fails closed instead of being cleared.
        await this.sources.provision(
          [key, { scope: 'GLOBAL', target_id: '*', dimension: 'IDENTITY' }],
          {
            bootstrap_id: this.fixture.bootstrap,
            coverage_revision: 'm2-diagnostic-v1'
          },
          ctx
        );
        await this.sources.mutate(
          { keys: [key], requests: [this.request()] },
          // A synthetic caller write proves transaction composition without
          // changing canonical identity/ownership/rating inputs in staging.
          (transaction) =>
            this.targets.request(
              [this.request(this.fixture.coalescingTarget)],
              transaction
            ),
          ctx
        );
        await this.assertSource('1', 0, ctx);
        requireDiagnostic(
          (
            await this.targets.find(
              this.request(this.fixture.coalescingTarget),
              ctx
            )
          )?.requested_version === '1',
          'caller write participates in source transaction'
        );
        this.record('transactional_source_and_request');
        await this.producerLifecycle(ctx);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    await this.assertFixturesAbsent();
    this.record('source_and_job_changes_rolled_back');
  }

  private async producerLifecycle(
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const first = { job_id: this.fixture.firstJob, keys: [this.profileKey()] };
    const second = {
      job_id: this.fixture.secondJob,
      keys: [this.profileKey()]
    };
    const initial = { stage: 'START', after_id: null };
    const started = await this.jobs.start(first, initial, ctx);
    const duplicate = await this.jobs.start(first, initial, ctx);
    requireDiagnostic(
      duplicate.progress.revision === started.progress.revision,
      'duplicate job start'
    );
    await this.assertSource('2', 1, ctx);
    await requireUnknown(() => this.jobs.start(second, initial, ctx));
    this.record('duplicate_start_and_overlap_barrier');

    const checkpoint = await this.jobs.checkpoint(
      first,
      started.progress,
      { stage: 'FINAL', after_id: null },
      async () => undefined,
      ctx
    );
    const failed = await this.jobs.fail(
      first,
      checkpoint.state.progress,
      'DIAGNOSTIC_FAILURE',
      ctx
    );
    await requireUnknown(() =>
      this.sources.capture([this.profileKey()], false, ctx)
    );
    await this.assertSource('2', 1, ctx);
    const resumed = await this.jobs.resume(first, failed.progress, ctx);
    this.record('failed_barrier_and_explicit_resume');

    const completed = await this.jobs.complete(
      first,
      resumed.progress,
      [this.request()],
      async () => undefined,
      ctx
    );
    requireDiagnostic(completed.applied, 'first job completion');
    await this.assertSource('3', 0, ctx);
    const restarted = await this.jobs.start(first, initial, ctx);
    requireDiagnostic(
      restarted.status === 'COMPLETED',
      'completed job cannot restart'
    );
    const secondStarted = await this.jobs.start(second, initial, ctx);
    const delayed = await this.jobs.complete(
      first,
      resumed.progress,
      [this.request()],
      async () => {
        throw new Error('Duplicate completion repeated input writes');
      },
      ctx
    );
    requireDiagnostic(!delayed.applied, 'duplicate completion is a no-op');
    await this.assertSource('4', 1, ctx);
    await this.jobs.complete(
      second,
      secondStarted.progress,
      [this.request()],
      async () => undefined,
      ctx
    );
    await this.assertSource('5', 0, ctx);
    const target = await this.targets.find(this.request(), ctx);
    requireDiagnostic(
      target?.requested_version === '3',
      'completion request count'
    );
    this.record('delayed_completion_preserves_newer_job');
  }

  private async assertSource(
    version: string,
    activeJobs: number,
    ctx: MembershipPrimaryContext
  ) {
    const [evidence] = await this.sources.read([this.profileKey()], false, ctx);
    requireDiagnostic(
      evidence.state?.version === version &&
        evidence.state.active_jobs === activeJobs,
      'source version and active barrier'
    );
  }

  private async concurrentRequests(): Promise<void> {
    const request = this.request(this.fixture.coalescingTarget);
    const results = await Promise.allSettled(
      Array.from({ length: REQUEST_COUNT }, () =>
        this.transaction((ctx) => this.targets.request([request], ctx))
      )
    );
    // All four commits are required for acceptance. A timeout/error fails the
    // diagnostic, and every transaction must settle before cleanup can begin.
    // Never retry an ambiguous increment or weaken the exact count to <= 4.
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    await this.transaction(async (ctx) => {
      const target = await this.targets.find(request, ctx);
      requireDiagnostic(
        target?.requested_version === String(REQUEST_COUNT) &&
          target.completed_version === '0' &&
          target.available_at_millis !== null,
        'concurrent target coalescing'
      );
    });
    this.record('concurrent_committed_target_coalescing');
  }

  private async cleanupTargets(): Promise<void> {
    await this.transaction((ctx) =>
      this.db.execute(
        `DELETE FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
       WHERE scope = 'PROFILE' AND target_id = :targetId AND reason = :reason`,
        {
          targetId: this.fixture.coalescingTarget,
          reason: this.fixture.reason
        },
        membershipQueryOptions(ctx)
      )
    );
  }

  private async assertFixturesAbsent(): Promise<void> {
    await this.transaction(async (ctx) => {
      const options = membershipQueryOptions(ctx);
      for (const table of [
        MEMBERSHIP_SOURCE_STATES_TABLE,
        MEMBERSHIP_SOURCE_JOBS_TABLE
      ]) {
        const rows = await this.db.execute(
          `SELECT target_id FROM ${table}
           WHERE scope = 'PROFILE' AND target_id = :profileId AND dimension = 'IDENTITY' LIMIT 1`,
          { profileId: this.fixture.profile },
          options
        );
        requireDiagnostic(rows.length === 0, 'source fixture rollback');
      }
      for (const targetId of [
        this.fixture.profile,
        this.fixture.coalescingTarget
      ]) {
        requireDiagnostic(
          (await this.targets.find(this.request(targetId), ctx)) === null,
          'target fixture cleanup'
        );
      }
    });
  }
}

/** Called only by the closed staging operator action; never a producer or reader. */
export async function runMembershipRepositoryDiagnostics(db: SqlExecutor) {
  return new MembershipRepositoryDiagnostic(db).run();
}
