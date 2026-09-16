import { createHash } from 'node:crypto';
import { MEMBERSHIP_SOURCE_JOBS_TABLE } from '@/constants';
import { MembershipSourceJobEntity } from '@/entities/IMembershipSourceJob';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MembershipRefreshRequest,
  MembershipRefreshTargetsDb
} from './membership-refresh-targets.db';
import {
  MEMBERSHIP_DB_NOW,
  requireMembershipLabel,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  MembershipSourceJobProgress,
  MembershipSourceJobStatus
} from './membership-schema.types';
import {
  MembershipSourceEvidence,
  MembershipSourceNotReadyError,
  MembershipSourceStatesDb,
  withGlobalSourceKeys
} from './membership-source-states.db';
import {
  MembershipSourceKey,
  normalizeCounter,
  orderedSourceKeys
} from './membership-validation';

export interface MembershipSourceJobIdentity {
  readonly job_id: string;
  /** Complete, stable affected source set; overlapping writers must share a key. */
  readonly keys: readonly MembershipSourceKey[];
}

/** TDH, universe/levels and the separate statistics activation share one cycle. */
export const MEMBERSHIP_TDH_COMPLETION_STAGE = 'STATS_ACTIVATED';

export interface MembershipSourceJobCheckpoint extends MembershipSourceJobProgress {
  readonly revision: string;
}

export interface MembershipSourceJobState {
  readonly status: MembershipSourceJobStatus;
  readonly progress: MembershipSourceJobCheckpoint;
}

function sourceKeyHash(keys: readonly MembershipSourceKey[]): string {
  return createHash('sha256')
    .update(JSON.stringify(orderedSourceKeys(keys)))
    .digest('hex');
}

function storedProgress(
  progress: MembershipSourceJobCheckpoint,
  keys: readonly MembershipSourceKey[]
): string {
  return JSON.stringify({
    stage: progress.stage,
    after_id: progress.after_id,
    revision: progress.revision,
    source_keys_hash: sourceKeyHash(keys)
  });
}

function nextRevision(progress: MembershipSourceJobCheckpoint): string {
  return normalizeCounter(
    BigInt(normalizeCounter(progress.revision)) + BigInt(1)
  );
}

function validateProgress(progress: MembershipSourceJobProgress): void {
  requireMembershipLabel(progress.stage, 'producer stage');
  if (progress.after_id !== null)
    requireMembershipLabel(progress.after_id, 'producer cursor', 200);
}

function sameProgress(
  a: MembershipSourceJobProgress,
  b: MembershipSourceJobProgress
): boolean {
  return a.stage === b.stage && a.after_id === b.after_id;
}

function normalizeJob(
  row: MembershipSourceJobEntity,
  expectedKeyHash: string
): MembershipSourceJobEntity {
  const progress: MembershipSourceJobProgress | null =
    typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress;
  if (
    !progress ||
    !('source_keys_hash' in progress) ||
    progress.source_keys_hash !== expectedKeyHash ||
    !['RUNNING', 'FAILED', 'COMPLETED'].includes(row.status)
  ) {
    throw new Error('Invalid membership producer state');
  }
  validateProgress(progress);
  if (!('revision' in progress)) throw new Error('Missing producer revision');
  normalizeCounter(progress.revision);
  return {
    ...row,
    progress,
    started_version: normalizeCounter(row.started_version),
    completed_version:
      row.completed_version === null
        ? null
        : normalizeCounter(row.completed_version)
  };
}

/** Durable producer stages. No external effect belongs inside these callbacks. */
export class MembershipSourceJobsDb extends LazyDbAccessCompatibleService {
  async get(
    identity: MembershipSourceJobIdentity,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceJobState> {
    const state = await this.find(identity, ctx);
    if (!state) throw new Error('Unknown membership producer job');
    return state;
  }

  async find(
    identity: MembershipSourceJobIdentity,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceJobState | null> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->find',
      ctx,
      async () => {
        const { jobs } = await this.lock(identity, ctx);
        return jobs.length ? this.jobState(jobs[0]) : null;
      }
    );
  }

  /** Recover a sender whose source inputs committed but its SQS publish did not. */
  async findActiveGlobalJobId(
    dimension: MembershipSourceKey['dimension'],
    ctx: MembershipPrimaryContext
  ): Promise<string | null> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->findActiveGlobalJobId',
      ctx,
      async () => {
        const key: MembershipSourceKey = {
          scope: 'GLOBAL',
          target_id: '*',
          dimension
        };
        const [source] = await this.sources().read([key], true, ctx);
        if (!source.state || !source.provisioned)
          throw new MembershipSourceNotReadyError();
        const rows = await this.db.execute<{ job_id: string }>(
          `SELECT job_id FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
           WHERE scope = 'GLOBAL' AND target_id = '*'
             AND dimension = :dimension AND status IN ('RUNNING', 'FAILED')
           LIMIT 2 FOR UPDATE`,
          { dimension },
          membershipQueryOptions(ctx)
        );
        if (rows.length !== source.state.active_jobs || rows.length > 1)
          throw new Error('Inconsistent membership producer barrier');
        return rows[0]?.job_id ?? null;
      }
    );
  }

  async start(
    identity: MembershipSourceJobIdentity,
    progress: MembershipSourceJobProgress,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceJobState> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->start',
      ctx,
      async () => {
        validateProgress(progress);
        const { keys, sources, jobs } = await this.lock(identity, ctx);
        if (jobs.length) return this.jobState(jobs[0]);
        if (sources.some(({ state }) => state?.active_jobs !== 0)) {
          throw new MembershipSourceNotReadyError();
        }
        await this.sources().increment(keys, 1, ctx);
        const started = await this.sources().read(keys, true, ctx);
        for (const { key, state } of started) {
          if (!state) throw new MembershipSourceNotReadyError();
          await this.db.execute(
            `INSERT INTO ${MEMBERSHIP_SOURCE_JOBS_TABLE}
           (scope, target_id, dimension, job_id, status, progress, started_version,
            completed_version, created_at_millis, updated_at_millis, last_error)
           VALUES (:scope, :target_id, :dimension, :job_id, 'RUNNING', :progress,
            :version, NULL, ${MEMBERSHIP_DB_NOW}, ${MEMBERSHIP_DB_NOW}, NULL)`,
            {
              ...key,
              job_id: identity.job_id,
              progress: storedProgress({ ...progress, revision: '0' }, keys),
              version: state.version
            },
            membershipQueryOptions(ctx)
          );
        }
        return { status: 'RUNNING', progress: { ...progress, revision: '0' } };
      }
    );
  }

  async checkpoint<T>(
    identity: MembershipSourceJobIdentity,
    expected: MembershipSourceJobCheckpoint,
    next: MembershipSourceJobProgress,
    write: (ctx: MembershipPrimaryContext) => Promise<T>,
    ctx: MembershipPrimaryContext
  ): Promise<{
    readonly applied: boolean;
    readonly result?: T;
    readonly state: MembershipSourceJobState;
  }> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->checkpoint',
      ctx,
      async () => {
        validateProgress(expected);
        validateProgress(next);
        if (sameProgress(expected, next))
          throw new Error('Producer checkpoint must advance');
        const locked = await this.lock(identity, ctx);
        const state = this.requireRunning(locked.sources, locked.jobs);
        if (
          state.progress.revision === nextRevision(expected) &&
          sameProgress(state.progress, next)
        )
          return { applied: false, state };
        this.requireProgress(state, expected);
        const result = await write(ctx);
        const nextState: MembershipSourceJobState = {
          status: 'RUNNING',
          progress: { ...next, revision: nextRevision(expected) }
        };
        await this.updateJobs(identity, nextState, null, ctx);
        return { applied: true, result, state: nextState };
      }
    );
  }

  async fail(
    identity: MembershipSourceJobIdentity,
    expected: MembershipSourceJobCheckpoint,
    errorCode: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceJobState> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->fail',
      ctx,
      async () => {
        requireMembershipLabel(errorCode, 'producer error code');
        const { sources, jobs } = await this.lock(identity, ctx);
        const state = this.requireRunning(sources, jobs, true);
        if (
          state.status === 'FAILED' &&
          state.progress.revision === nextRevision(expected) &&
          sameProgress(state.progress, expected)
        )
          return state;
        this.requireProgress(state, expected);
        const failed: MembershipSourceJobState = {
          status: 'FAILED',
          progress: { ...state.progress, revision: nextRevision(expected) }
        };
        await this.updateJobs(identity, failed, errorCode, ctx);
        return failed;
        // Failed/expired work keeps every active barrier until repaired and completed.
      }
    );
  }

  async resume(
    identity: MembershipSourceJobIdentity,
    expected: MembershipSourceJobCheckpoint,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipSourceJobState> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->resume',
      ctx,
      async () => {
        const { sources, jobs } = await this.lock(identity, ctx);
        const state = this.requireRunning(sources, jobs, true);
        if (
          state.status === 'RUNNING' &&
          state.progress.revision === nextRevision(expected) &&
          sameProgress(state.progress, expected)
        )
          return state;
        this.requireProgress(state, expected);
        if (state.status !== 'FAILED')
          throw new Error('Only failed producer work can resume');
        const resumed: MembershipSourceJobState = {
          status: 'RUNNING',
          progress: { ...state.progress, revision: nextRevision(expected) }
        };
        await this.updateJobs(identity, resumed, null, ctx);
        return resumed;
      }
    );
  }

  async complete<T>(
    identity: MembershipSourceJobIdentity,
    expected: MembershipSourceJobCheckpoint,
    requests: readonly MembershipRefreshRequest[],
    writeFinalInputs: (ctx: MembershipPrimaryContext) => Promise<T>,
    ctx: MembershipPrimaryContext
  ): Promise<{ readonly applied: boolean; readonly result?: T }> {
    return timeMembershipOperation(
      'MembershipSourceJobsDb->complete',
      ctx,
      async () => {
        if (!requests.length)
          throw new Error('Producer completion requires refresh requests');
        validateProgress(expected);
        const { keys, sources, jobs } = await this.lock(identity, ctx);
        if (jobs[0]?.status === 'COMPLETED') return { applied: false };
        const state = this.requireRunning(sources, jobs);
        this.requireProgress(state, expected);
        if (
          keys.some((key) => key.dimension === 'TDH_XTDH') &&
          expected.stage !== MEMBERSHIP_TDH_COMPLETION_STAGE
        ) {
          throw new Error(
            'TDH membership source completion requires statistics activation'
          );
        }
        const result = await writeFinalInputs(ctx);
        await this.sources().increment(keys, -1, ctx);
        for (const { key, state: completed } of await this.sources().read(
          keys,
          true,
          ctx
        )) {
          if (!completed) throw new MembershipSourceNotReadyError();
          await this.db.execute(
            `UPDATE ${MEMBERSHIP_SOURCE_JOBS_TABLE}
           SET status = 'COMPLETED', completed_version = :version, progress = :progress,
             updated_at_millis = ${MEMBERSHIP_DB_NOW}, last_error = NULL
           WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension AND job_id = :job_id`,
            {
              ...key,
              job_id: identity.job_id,
              version: completed.version,
              progress: storedProgress(
                { ...expected, revision: nextRevision(expected) },
                keys
              )
            },
            membershipQueryOptions(ctx)
          );
        }
        await new MembershipRefreshTargetsDb(() => this.db).request(
          requests,
          ctx
        );
        return { applied: true, result };
      }
    );
  }

  private sources(): MembershipSourceStatesDb {
    return new MembershipSourceStatesDb(() => this.db);
  }

  private async lock(
    identity: MembershipSourceJobIdentity,
    ctx: MembershipPrimaryContext
  ): Promise<{
    keys: MembershipSourceKey[];
    sources: MembershipSourceEvidence[];
    jobs: MembershipSourceJobEntity[];
  }> {
    requireMembershipLabel(identity.job_id, 'producer job ID');
    if (identity.job_id.startsWith('bootstrap:'))
      throw new Error('Reserved producer job ID');
    const keys = withGlobalSourceKeys(identity.keys);
    if (keys.some((key) => key.dimension === 'GROUP_CATALOG'))
      throw new Error(
        'Multi-stage catalogue jobs require a bounded group-version fanout contract'
      );
    if (!keys.length) throw new Error('Producer job requires source keys');
    const sources = await this.sources().read(keys, true, ctx);
    if (sources.some(({ state, provisioned }) => !state || !provisioned))
      throw new MembershipSourceNotReadyError();
    const jobs: MembershipSourceJobEntity[] = [];
    for (const key of keys) {
      const job = await this.db.oneOrNull<MembershipSourceJobEntity>(
        `SELECT scope, target_id, dimension, job_id, status, progress,
           CAST(started_version AS CHAR) started_version, CAST(completed_version AS CHAR) completed_version,
           CAST(created_at_millis AS CHAR) created_at_millis, CAST(updated_at_millis AS CHAR) updated_at_millis, last_error
         FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension AND job_id = :job_id FOR UPDATE`,
        { ...key, job_id: identity.job_id },
        membershipQueryOptions(ctx)
      );
      if (job) jobs.push(normalizeJob(job, sourceKeyHash(keys)));
    }
    if (
      jobs.length &&
      (jobs.length !== keys.length ||
        jobs.some(
          (job) =>
            job.status !== jobs[0].status ||
            (job.progress as MembershipSourceJobCheckpoint).revision !==
              (jobs[0].progress as MembershipSourceJobCheckpoint).revision ||
            !sameProgress(job.progress!, jobs[0].progress!)
        ))
    ) {
      throw new Error('Inconsistent membership producer job set');
    }
    return { keys, sources, jobs };
  }

  private jobState(job: MembershipSourceJobEntity): MembershipSourceJobState {
    if (!job.progress) throw new Error('Missing producer checkpoint');
    return {
      status: job.status,
      progress: {
        stage: job.progress.stage,
        after_id: job.progress.after_id,
        revision: normalizeCounter(
          (job.progress as MembershipSourceJobCheckpoint).revision
        )
      }
    };
  }

  private requireRunning(
    sources: MembershipSourceEvidence[],
    jobs: MembershipSourceJobEntity[],
    allowFailed = false
  ): MembershipSourceJobState {
    if (!jobs.length) throw new Error('Unknown membership producer job');
    const state = this.jobState(jobs[0]);
    if (
      state.status !== 'RUNNING' &&
      !(allowFailed && state.status === 'FAILED')
    ) {
      throw new Error('Membership producer is not running');
    }
    if (
      sources.some(
        ({ state: source }, i) =>
          source?.active_jobs !== 1 ||
          source.version !== jobs[i].started_version
      )
    ) {
      throw new Error('Membership producer barrier was superseded');
    }
    return state;
  }

  private requireProgress(
    state: MembershipSourceJobState,
    expected: MembershipSourceJobCheckpoint
  ): void {
    validateProgress(expected);
    if (
      state.progress.revision !== normalizeCounter(expected.revision) ||
      !sameProgress(state.progress, expected)
    )
      throw new Error('Membership producer checkpoint was superseded');
  }

  private async updateJobs(
    identity: MembershipSourceJobIdentity,
    state: MembershipSourceJobState,
    error: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    for (const key of withGlobalSourceKeys(identity.keys)) {
      await this.db.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_JOBS_TABLE} SET status = :status, progress = :progress,
           updated_at_millis = ${MEMBERSHIP_DB_NOW}, last_error = :error
         WHERE scope = :scope AND target_id = :target_id AND dimension = :dimension AND job_id = :job_id`,
        {
          ...key,
          job_id: identity.job_id,
          status: state.status,
          progress: storedProgress(
            state.progress,
            withGlobalSourceKeys(identity.keys)
          ),
          error
        },
        membershipQueryOptions(ctx)
      );
    }
  }
}
