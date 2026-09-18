import { randomUUID } from 'node:crypto';
import {
  IDENTITIES_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import { MEMBERSHIP_BACKFILL_INDEXES } from './membership-backfill-indexes';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import { requireMembershipBootstrapReady } from './membership-bootstrap.db';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  MembershipSourceStatesDb,
  membershipSourceKeyId
} from './membership-source-states.db';
import { MembershipSourceDimension } from './membership-schema.types';
import { minimumMembershipHorizon } from './membership-evaluation-validation';
import {
  MEMBERSHIP_FANOUT_KEYS,
  MEMBERSHIP_IDENTITY_KEY
} from './membership-worker-validation';
import { MembershipWorkerDb } from './membership-worker.db';
import {
  MEMBERSHIP_EVALUATOR_SPEC_VERSION,
  membershipProfileSourceKeys
} from './membership-profile-evaluator';
import {
  MEMBERSHIP_BACKFILL_CHECKPOINT_ID,
  MembershipBackfillObservation,
  MembershipBackfillProgress,
  normalizeMembershipBackfillProgress
} from './membership-backfill.types';
import {
  normalizeCounter,
  normalizeSourceVector
} from './membership-validation';

const FULL = { scope: 'FULL' as const, target_id: '*' };
const MAX_PAGE = 64;

interface ControlRow {
  protocol_version: number;
  revision: string;
  progress: unknown;
}

interface ProbeIndexRow {
  table_name: string;
  index_name: string;
  seq_in_index: number;
  column_name: string;
  non_unique: number;
}

interface ParentRow {
  id: string;
}

interface IdentityRow {
  profile_id: string;
  occurrences: number | string;
}

interface ChildTargetRow {
  target_id: string;
  requested_version: string;
  completed_version: string;
  available_at_millis: string | null;
  reason: string;
}

interface PublicationRow {
  profile_id: string;
  run_id: string;
  scope: string;
  target_id: string;
  status: string;
  spec_version: number;
  request_version: string;
  valid_until_millis: string | null;
  published_at_millis: string;
  source_versions: unknown;
}

interface ProfileSourceRow {
  target_id: string;
  dimension: MembershipSourceDimension;
  version: string;
  active_jobs: number;
}

interface ChildCounts {
  scanned: number;
  published: number;
  scheduled: number;
  pending: number;
  parked: number;
  missing: number;
  minimum_horizon: string | null;
}

const GLOBAL_DIMENSIONS = [
  'TDH_XTDH',
  'RATINGS',
  'OWNERSHIP',
  'DELEGATIONS',
  'GRANTS',
  'IDENTITY',
  'GROUP_CATALOG'
] as const satisfies readonly MembershipSourceDimension[];

function add(left: string, right: number): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function emptyCounts(progress: MembershipBackfillProgress) {
  progress.scan_after_id = null;
  progress.scan_started_at_millis = null;
  progress.scan_pass_complete = false;
  progress.scan_pass_stable = false;
  progress.scanned_count = '0';
  progress.published_count = '0';
  progress.scheduled_boundary_count = '0';
  progress.minimum_horizon_millis = null;
  progress.pending_count = '0';
  progress.parked_count = '0';
  progress.missing_count = '0';
  progress.converged_at_millis = null;
  progress.scan_pass++;
}

/** Operator-owned initial FULL request and bounded, durable publication audit. */
export class MembershipBackfillDb extends LazyDbAccessCompatibleService {
  async start(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation> {
    return timeMembershipOperation(
      'MembershipBackfillDb->start',
      ctx,
      async () => {
        // This checks the persisted bootstrap and tracked writer fleet in the same
        // primary transaction. An argument from an operator is never readiness proof.
        const ready = await requireMembershipBootstrapReady(ctx);
        const existing = await this.read(true, ctx);
        if (existing) {
          if (
            existing.progress.bootstrap_id !== ready.bootstrap_id ||
            existing.progress.coverage_revision !== ready.coverage_revision
          )
            throw new Error(
              'Backfill belongs to a different bootstrap revision'
            );
          return this.observation(existing.progress);
        }
        await this.requireProbeIndexes(ctx);
        const sources = await new MembershipSourceStatesDb(
          () => this.db
        ).capture(MEMBERSHIP_FANOUT_KEYS, true, ctx);
        const version = (key: (typeof MEMBERSHIP_FANOUT_KEYS)[number]) => {
          const item = sources.find(
            (source) =>
              membershipSourceKeyId(source) === membershipSourceKeyId(key)
          );
          if (!item) throw new Error('Backfill source version missing');
          return item.version;
        };
        await new MembershipDispatchCheckpointsDb(() => this.db).provision(ctx);
        await new MembershipGcCheckpointsDb(() => this.db).provision(ctx);
        const requests = new MembershipRefreshTargetsDb(() => this.db);
        await requests.request(
          [{ ...FULL, reason: 'membership-backfill-v1' }],
          ctx
        );
        const target = await requests.find(FULL, ctx);
        if (!target) throw new Error('Backfill FULL request was not committed');
        const now = await new MembershipWorkerDb(() => this.db).now(ctx);
        const progress: MembershipBackfillProgress = {
          protocol_version: 1,
          generation_id: randomUUID(),
          bootstrap_id: ready.bootstrap_id,
          coverage_revision: ready.coverage_revision,
          identity_source_version: version(MEMBERSHIP_IDENTITY_KEY),
          catalog_source_version: version(
            MEMBERSHIP_FANOUT_KEYS.find(
              (key) => key.dimension === 'GROUP_CATALOG'
            )!
          ),
          full_requested_version: target.requested_version,
          started_at_millis: now,
          state: 'RUNNING',
          parent_run_id: null,
          parent_request_version: null,
          parent_completed_at_millis: null,
          parent_through_id: null,
          parent_processed_count: null,
          scan_after_id: null,
          scan_started_at_millis: null,
          scan_pass_complete: false,
          scan_pass_stable: false,
          scan_pass: 0,
          scanned_count: '0',
          published_count: '0',
          scheduled_boundary_count: '0',
          minimum_horizon_millis: null,
          pending_count: '0',
          parked_count: '0',
          missing_count: '0',
          last_observed_at_millis: null,
          converged_at_millis: null
        };
        await this.db.execute(
          `INSERT INTO ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
         (id,protocol_version,revision,progress,created_at_millis,updated_at_millis)
         VALUES (:id,1,0,:progress,:now,:now)`,
          {
            id: MEMBERSHIP_BACKFILL_CHECKPOINT_ID,
            progress: JSON.stringify(progress),
            now
          },
          membershipQueryOptions(ctx)
        );
        return this.observation(progress);
      }
    );
  }

  async status(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation | null> {
    return timeMembershipOperation(
      'MembershipBackfillDb->status',
      ctx,
      async () => {
        const control = await this.read(false, ctx);
        return control ? this.observation(control.progress) : null;
      }
    );
  }

  async pause(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation> {
    return this.setState('PAUSED', ctx);
  }

  async resume(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation> {
    return this.setState('RUNNING', ctx);
  }

  private async setState(
    state: 'PAUSED' | 'RUNNING',
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation> {
    return timeMembershipOperation(
      'MembershipBackfillDb->setState',
      ctx,
      async () => {
        const control = await this.requireControl(ctx);
        if (control.progress.state === 'SCAN_CONVERGED')
          throw new Error(
            'Completed backfill generation cannot be paused or resumed'
          );
        if (control.progress.state !== state) {
          control.progress.state = state;
          await this.save(control, ctx);
        }
        return this.observation(control.progress);
      }
    );
  }

  async observe(
    pageSize: number,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipBackfillObservation> {
    return timeMembershipOperation(
      'MembershipBackfillDb->observe',
      ctx,
      async () => {
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE)
          throw new Error(
            'Backfill observation page must contain 1–64 identities'
          );
        const control = await this.requireControl(ctx);
        const progress = control.progress;
        if (progress.state === 'PAUSED') return this.observation(progress);
        if (progress.state === 'SCAN_CONVERGED')
          return this.observation(progress);
        const parent = await this.completedParent(progress, ctx);
        if (!parent) {
          progress.last_observed_at_millis = await this.now(ctx);
          await this.save(control, ctx);
          return this.observation(progress);
        }
        if (progress.parent_run_id !== parent.id) {
          progress.parent_run_id = parent.id;
          progress.parent_request_version = parent.request_version;
          progress.parent_completed_at_millis = parent.completed_at_millis;
          progress.parent_through_id = parent.progress_cursor.through_id;
          progress.parent_processed_count = parent.processed_count;
          emptyCounts(progress);
          progress.state = 'RUNNING';
        }
        if (progress.scan_pass_complete) emptyCounts(progress);
        if (progress.scan_started_at_millis === null)
          progress.scan_started_at_millis = await this.now(ctx);
        const ids = await this.identityPage(progress, pageSize, ctx);
        const now = await this.now(ctx);
        const globalVersions = await this.currentGlobalVersions(ctx);
        const classified = await this.classify(
          ids.slice(0, pageSize),
          progress,
          globalVersions,
          now,
          ctx
        );
        progress.scanned_count = add(
          progress.scanned_count,
          classified.scanned
        );
        progress.published_count = add(
          progress.published_count,
          classified.published
        );
        progress.scheduled_boundary_count = add(
          progress.scheduled_boundary_count,
          classified.scheduled
        );
        progress.minimum_horizon_millis = minimumMembershipHorizon(
          progress.minimum_horizon_millis,
          classified.minimum_horizon
        );
        progress.pending_count = add(
          progress.pending_count,
          classified.pending
        );
        progress.parked_count = add(progress.parked_count, classified.parked);
        progress.missing_count = add(
          progress.missing_count,
          classified.missing
        );
        progress.scan_after_id =
          ids[Math.min(ids.length, pageSize) - 1]?.profile_id ??
          progress.scan_after_id;
        progress.last_observed_at_millis = now;
        if (ids.length <= pageSize) {
          progress.scan_pass_complete = true;
          // Locking reads see committed changes even though page classification
          // used a repeatable-read snapshot. Keep these locks until the control
          // update commits so a producer cannot cross the final audit fence.
          const finalGlobal = await this.currentGlobalVersions(ctx, true);
          const changed = await this.changedDuringScan(progress, ctx);
          const fanoutSettled = await this.fanoutTargetsSettled(ctx);
          // The clock must be sampled after the final probes. A grant horizon
          // seen on an earlier page may have expired during this transaction.
          const finalNow = await this.now(ctx);
          progress.scan_pass_stable =
            progress.scan_started_at_millis !== null &&
            BigInt(progress.scan_started_at_millis) <= BigInt(finalNow) &&
            globalVersions !== null &&
            finalGlobal !== null &&
            GLOBAL_DIMENSIONS.every(
              (dimension) =>
                globalVersions.get(dimension) === finalGlobal.get(dimension)
            ) &&
            (progress.minimum_horizon_millis === null ||
              BigInt(progress.minimum_horizon_millis) > BigInt(finalNow)) &&
            !changed &&
            fanoutSettled;
          const complete =
            progress.pending_count === '0' &&
            progress.parked_count === '0' &&
            progress.missing_count === '0' &&
            progress.scan_pass_stable;
          if (complete) {
            progress.state = 'SCAN_CONVERGED';
            progress.converged_at_millis = finalNow;
          }
        }
        await this.save(control, ctx);
        return this.observation(progress);
      }
    );
  }

  private async completedParent(
    progress: MembershipBackfillProgress,
    ctx: MembershipPrimaryContext
  ) {
    const target = await new MembershipRefreshTargetsDb(() => this.db).find(
      FULL,
      ctx
    );
    if (
      !target ||
      BigInt(target.completed_version) < BigInt(progress.full_requested_version)
    )
      return null;
    const rows = progress.parent_run_id
      ? [{ id: progress.parent_run_id }]
      : await this.db.execute<ParentRow>(
          `SELECT id FROM ${MEMBERSHIP_REFRESH_RUNS_TABLE}
           WHERE scope='FULL' AND target_id='*' AND status='COMPLETED'
             AND request_version>=:version AND created_at_millis>=:started
           ORDER BY request_version DESC,created_at_millis DESC LIMIT 1`,
          {
            version: progress.full_requested_version,
            started: progress.started_at_millis
          },
          membershipQueryOptions(ctx)
        );
    if (!rows.length)
      throw new Error(
        'FULL target acknowledged without a completed backfill fanout'
      );
    const run = await new MembershipWorkerDb(() => this.db).run(
      rows[0].id,
      false,
      ctx
    );
    if (
      !run ||
      run.status !== 'COMPLETED' ||
      run.scope !== 'FULL' ||
      BigInt(run.request_version) < BigInt(progress.full_requested_version) ||
      BigInt(run.created_at_millis) < BigInt(progress.started_at_millis) ||
      run.progress_cursor.kind !== 'PROFILE_FANOUT' ||
      run.progress_cursor.phase !== 'DONE' ||
      run.completed_at_millis === null
    )
      throw new Error('Completed backfill parent has invalid fanout evidence');
    return run;
  }

  private async requireProbeIndexes(
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const expected = MEMBERSHIP_BACKFILL_INDEXES;
    const rows = await this.db.execute<ProbeIndexRow>(
      `SELECT TABLE_NAME table_name,INDEX_NAME index_name,
       SEQ_IN_INDEX seq_in_index,COLUMN_NAME column_name,
       NON_UNIQUE non_unique
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE()
         AND TABLE_NAME IN (:tables) AND INDEX_NAME IN (:names)`,
      {
        tables: Array.from(new Set(expected.map((index) => index.table))),
        names: expected.map((index) => index.name)
      },
      membershipQueryOptions(ctx)
    );
    for (const index of expected) {
      const found = rows
        .filter(
          (row) =>
            row.table_name === index.table && row.index_name === index.name
        )
        .sort((a, b) => Number(a.seq_in_index) - Number(b.seq_in_index));
      if (
        found.length !== index.columns.length ||
        found.some(
          (row, position) =>
            Number(row.non_unique) !== 1 ||
            Number(row.seq_in_index) !== position + 1 ||
            row.column_name !== index.columns[position]
        )
      )
        throw new Error('Membership backfill probe indexes are not ready');
    }
  }

  private async identityPage(
    progress: MembershipBackfillProgress,
    size: number,
    ctx: MembershipPrimaryContext
  ): Promise<IdentityRow[]> {
    if (progress.parent_through_id === null) return [];
    const rows = await this.db.execute<IdentityRow>(
      `SELECT p.profile_id,COUNT(*) OVER(PARTITION BY p.profile_id) occurrences FROM
       (SELECT i.profile_id FROM ${IDENTITIES_TABLE} i FORCE INDEX(identity_profile_id_idx)
        WHERE i.profile_id IS NOT NULL
          ${progress.scan_after_id === null ? '' : 'AND i.profile_id>:after'}
          AND i.profile_id<=:through ORDER BY i.profile_id LIMIT :limit) p
       ORDER BY p.profile_id`,
      {
        after: progress.scan_after_id,
        through: progress.parent_through_id,
        limit: size + 1
      },
      membershipQueryOptions(ctx)
    );
    for (const row of rows)
      if (normalizeCounter(row.occurrences) !== '1')
        throw new Error(
          'Backfill identity page has duplicate canonical profiles'
        );
    return rows;
  }

  private async classify(
    rows: readonly IdentityRow[],
    progress: MembershipBackfillProgress,
    globalVersions: Map<MembershipSourceDimension, string> | null,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<ChildCounts> {
    const counts: ChildCounts = {
      scanned: rows.length,
      published: 0,
      scheduled: 0,
      pending: 0,
      parked: 0,
      missing: 0,
      minimum_horizon: null
    };
    if (!rows.length) return counts;
    const ids = rows.map((row) => row.profile_id);
    const targets = await this.db.execute<ChildTargetRow>(
      `SELECT target_id,CAST(requested_version AS CHAR) requested_version,
       CAST(completed_version AS CHAR) completed_version,
       CAST(available_at_millis AS CHAR) available_at_millis,reason
       FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE} WHERE scope='PROFILE' AND target_id IN (:ids)`,
      { ids },
      membershipQueryOptions(ctx)
    );
    const publications = await this.db.execute<PublicationRow>(
      `SELECT p.profile_id,p.run_id,r.scope,r.target_id,r.status,r.spec_version,
       CAST(r.request_version AS CHAR) request_version,r.source_versions,
       CAST(r.valid_until_millis AS CHAR) valid_until_millis,
       CAST(p.published_at_millis AS CHAR) published_at_millis
       FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} p
       LEFT JOIN ${MEMBERSHIP_REFRESH_RUNS_TABLE} r ON r.id=p.run_id
       WHERE p.profile_id IN (:ids)`,
      { ids },
      membershipQueryOptions(ctx)
    );
    const profileSources = await this.db.execute<ProfileSourceRow>(
      `SELECT target_id,dimension,CAST(version AS CHAR) version,active_jobs
       FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
       WHERE scope='PROFILE' AND target_id IN (:ids)`,
      { ids },
      membershipQueryOptions(ctx)
    );
    const bySource = new Map(
      profileSources.map((source) => [
        `${source.target_id}/${source.dimension}`,
        source
      ])
    );
    const byTarget = new Map(
      targets.map((target) => [target.target_id, target])
    );
    const byPublication = new Map(
      publications.map((pub) => [pub.profile_id, pub])
    );
    for (const id of ids) {
      const target = byTarget.get(id);
      const publication = byPublication.get(id);
      if (!target) {
        counts.missing++;
        continue;
      }
      if (
        !publication ||
        publication.scope !== 'PROFILE' ||
        publication.target_id !== id ||
        publication.status !== 'COMPLETED' ||
        publication.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION ||
        BigInt(publication.published_at_millis) <
          BigInt(progress.started_at_millis) ||
        BigInt(target.completed_version) <
          BigInt(publication.request_version) ||
        !this.currentPublicationSources(
          publication,
          id,
          globalVersions,
          bySource
        ) ||
        (publication.valid_until_millis !== null &&
          BigInt(publication.valid_until_millis) <= BigInt(now))
      ) {
        if (target.available_at_millis === null) counts.parked++;
        else counts.pending++;
        continue;
      }
      if (target.requested_version === target.completed_version) {
        counts.published++;
        counts.minimum_horizon = minimumMembershipHorizon(
          counts.minimum_horizon,
          publication.valid_until_millis
        );
        continue;
      }
      if (
        BigInt(target.requested_version) ===
          BigInt(target.completed_version) + BigInt(1) &&
        target.reason === 'grant-time-boundary' &&
        target.available_at_millis === publication.valid_until_millis &&
        target.available_at_millis !== null &&
        BigInt(target.available_at_millis) > BigInt(now)
      ) {
        counts.published++;
        counts.scheduled++;
        counts.minimum_horizon = minimumMembershipHorizon(
          counts.minimum_horizon,
          publication.valid_until_millis
        );
      } else if (target.available_at_millis === null) counts.parked++;
      else counts.pending++;
    }
    return counts;
  }

  private async currentGlobalVersions(
    ctx: MembershipPrimaryContext,
    lock = false
  ): Promise<Map<MembershipSourceDimension, string> | null> {
    const keys = GLOBAL_DIMENSIONS.map((dimension) => ({
      scope: 'GLOBAL' as const,
      target_id: '*',
      dimension
    }));
    const evidence = await new MembershipSourceStatesDb(() => this.db).read(
      keys,
      lock,
      ctx
    );
    if (
      evidence.some(
        ({ state, provisioned }) =>
          !state || !provisioned || state.active_jobs !== 0
      )
    )
      return null;
    return new Map(
      evidence.map(({ key, state }) => [key.dimension, state!.version])
    );
  }

  private currentPublicationSources(
    publication: PublicationRow,
    profileId: string,
    global: Map<MembershipSourceDimension, string> | null,
    profile: Map<string, ProfileSourceRow>
  ): boolean {
    if (global === null) return false;
    try {
      const vector = normalizeSourceVector(
        typeof publication.source_versions === 'string'
          ? JSON.parse(publication.source_versions)
          : publication.source_versions,
        membershipProfileSourceKeys(profileId)
      );
      return vector.every((entry) => {
        if (entry.scope === 'GLOBAL')
          return global.get(entry.dimension) === entry.version;
        const current = profile.get(`${profileId}/${entry.dimension}`);
        return (
          current !== undefined &&
          current.active_jobs === 0 &&
          normalizeCounter(current.version) === entry.version
        );
      });
    } catch {
      return false;
    }
  }

  private async fanoutTargetsSettled(
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    const [pending] = await this.db.execute<{ scope: string }>(
      `SELECT scope FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
       WHERE scope IN ('GROUP','FULL')
         AND requested_version>completed_version LIMIT 1 FOR SHARE`,
      {},
      membershipQueryOptions(ctx)
    );
    return !pending;
  }

  private async changedDuringScan(
    progress: MembershipBackfillProgress,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    const started = progress.scan_started_at_millis;
    if (started === null) throw new Error('Backfill scan start is missing');
    const params = { started, through: progress.parent_through_id };
    // A page snapshot can become stale behind its cursor. The final probes
    // reject a pass touched by tracked writes. Seven GLOBAL versions are
    // locked and compared separately, but their timestamps must also cover
    // changes between earlier pages and the final page. Each large PROFILE
    // range uses its own index so
    // the final current-read fence stays within the statement budget.
    const [updatedGlobal] = await this.db.execute<{ changed: number }>(
      `SELECT 1 changed FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
       FORCE INDEX(PRIMARY)
       WHERE scope='GLOBAL' AND updated_at_millis>=:started
       LIMIT 1 FOR SHARE`,
      params,
      membershipQueryOptions(ctx)
    );
    if (updatedGlobal) return true;
    const [updatedSource] = await this.db.execute<{ changed: number }>(
      `SELECT 1 changed FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
       FORCE INDEX(idx_mss_scope_updated_target)
       WHERE scope='PROFILE' AND updated_at_millis>=:started
         AND target_id<=:through LIMIT 1 FOR SHARE`,
      params,
      membershipQueryOptions(ctx)
    );
    if (updatedSource) return true;
    const [activeSource] = await this.db.execute<{ changed: number }>(
      `SELECT 1 changed FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
       FORCE INDEX(idx_mss_scope_active_target)
       WHERE scope='PROFILE' AND active_jobs>0
         AND target_id<=:through LIMIT 1 FOR SHARE`,
      params,
      membershipQueryOptions(ctx)
    );
    if (activeSource) return true;
    const [target] = await this.db.execute<{ changed: number }>(
      `SELECT 1 changed FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
       FORCE INDEX(idx_mrt_scope_updated_target)
       WHERE scope='PROFILE' AND updated_at_millis>=:started
         AND target_id<=:through LIMIT 1 FOR SHARE`,
      params,
      membershipQueryOptions(ctx)
    );
    return Boolean(target);
  }

  private async now(ctx: MembershipPrimaryContext): Promise<string> {
    const row = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    return normalizeCounter(row?.now);
  }

  private async read(
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<{
    revision: string;
    progress: MembershipBackfillProgress;
  } | null> {
    const row = await this.db.oneOrNull<ControlRow>(
      `SELECT protocol_version,CAST(revision AS CHAR) revision,progress
       FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id ${lock ? 'FOR UPDATE' : ''}`,
      { id: MEMBERSHIP_BACKFILL_CHECKPOINT_ID },
      membershipQueryOptions(ctx)
    );
    if (!row) return null;
    if (row.protocol_version !== 1)
      throw new Error('Backfill control protocol is unsupported');
    return {
      revision: normalizeCounter(row.revision),
      progress: normalizeMembershipBackfillProgress(row.progress)
    };
  }

  private async requireControl(ctx: MembershipPrimaryContext) {
    const control = await this.read(true, ctx);
    if (!control) throw new Error('Backfill has not been started');
    return control;
  }

  private async save(
    control: { revision: string; progress: MembershipBackfillProgress },
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    const now = await this.now(ctx);
    const result = await this.db.execute(
      `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
       SET revision=revision+1,progress=:progress,updated_at_millis=:now
       WHERE id=:id AND revision=:revision`,
      {
        id: MEMBERSHIP_BACKFILL_CHECKPOINT_ID,
        revision: control.revision,
        progress: JSON.stringify(
          normalizeMembershipBackfillProgress(control.progress)
        ),
        now
      },
      membershipQueryOptions(ctx)
    );
    if (this.db.getAffectedRows(result) !== 1)
      throw new Error('Backfill control was changed concurrently');
  }

  private observation(
    progress: MembershipBackfillProgress
  ): MembershipBackfillObservation {
    return {
      progress,
      parent_fanout_complete: progress.parent_run_id !== null,
      child_scan_complete: progress.scan_pass_complete,
      child_publications_converged: progress.state === 'SCAN_CONVERGED',
      processing_halt_verified: false
    };
  }
}
