import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  USER_GROUPS_TABLE
} from '@/constants';
import type { UserGroupEntity } from '@/entities/IUserGroup';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  membershipQueryOptions,
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import {
  MEMBERSHIP_EVALUATOR_SPEC_VERSION,
  membershipProfileSourceKeys
} from './membership-profile-evaluator';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceEvidence,
  MembershipSourceStatesDb,
  membershipSourceKeyId
} from './membership-source-states.db';
import {
  normalizeCounter,
  normalizeSourceVector
} from './membership-validation';
import type { MembershipSourceDimension } from './membership-schema.types';
import type {
  MembershipCandidateIds,
  MembershipDirectEvaluator,
  MembershipFallbackReason,
  MembershipScopedReadResult
} from './membership-reader.types';
import { MEMBERSHIP_DB_NOW } from './membership-repository.utils';
import { performance } from 'node:perf_hooks';
import { membershipReaderCoverageRevision } from './membership-reader-policy';
import { normalizeMembershipWorkerCursor } from './membership-worker-validation';

const MAX_CONTROLLED_CANDIDATES = 512;
const MAX_DIRECT_CANDIDATES = 1024;
const CONTROLLED_READ_BUDGET_MILLIS = 12_000;

function readerBudget(deadlineMonotonicMillis: number) {
  return {
    deadlineMonotonicMillis,
    maxStatementMillis: 2_000,
    finalizationReserveMillis: 2_000,
    lockWaitSeconds: 1
  };
}

interface PublishedRun {
  id: string;
  scope: string;
  target_id: string;
  status: string;
  spec_version: number;
  catalog_version: string;
  source_versions: unknown;
  progress_cursor: unknown;
  evaluation_time_millis: string;
  valid_until_millis: string | null;
  completed_at_millis: string | null;
}
type CandidateGroup = UserGroupEntity & {
  group_version: string | null;
  is_deleted: number | boolean | null;
  within_generation: number | boolean;
};

interface Generation {
  run: PublishedRun;
  sourceVersions: Map<string, string>;
  through: string | null;
  identityKey: string;
}

interface ReadEvidence {
  source: Map<string, MembershipSourceEvidence> | null;
  catalogue: MembershipSourceEvidence | null;
  identityKey: string | null;
}

interface ReadinessPartition {
  directIds: string[];
  readyIds: string[];
  reasons: Partial<Record<MembershipFallbackReason, number>>;
}

function decodedObject(value: unknown): Record<string, unknown> | null {
  try {
    const object = typeof value === 'string' ? JSON.parse(value) : value;
    return object !== null &&
      typeof object === 'object' &&
      !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Dependencies are based on the current rule, including presently false criteria. */
export function membershipGroupDependencies(
  group: UserGroupEntity
): ReadonlySet<MembershipSourceDimension> {
  const result = new Set<MembershipSourceDimension>(['IDENTITY']);
  if (
    group.cic_min !== null ||
    group.cic_max !== null ||
    group.cic_user !== null ||
    group.rep_min !== null ||
    group.rep_max !== null ||
    group.rep_user !== null ||
    group.rep_category !== null
  )
    result.add('RATINGS');
  const tdh =
    group.tdh_min !== null ||
    group.tdh_max !== null ||
    group.level_min !== null ||
    group.level_max !== null;
  if (tdh) result.add('TDH_XTDH');
  const ownership =
    group.owns_meme ||
    group.owns_gradient ||
    group.owns_lab ||
    group.owns_nextgen ||
    group.owns_meme_tokens !== null ||
    group.owns_gradient_tokens !== null ||
    group.owns_lab_tokens !== null ||
    group.owns_nextgen_tokens !== null;
  if (ownership || group.is_beneficiary_of_grant_id !== null)
    result.add('OWNERSHIP');
  if (group.is_beneficiary_of_grant_id !== null) result.add('GRANTS');
  if (tdh || ownership || group.is_beneficiary_of_grant_id !== null)
    result.add('DELEGATIONS');
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((id) => values.has(id));
}

/**
 * All evidence, the clean membership set and direct overrides are read from one
 * consistent primary snapshot. Missing proof always selects direct evaluation.
 */
export class MembershipReader extends LazyDbAccessCompatibleService {
  constructor(
    getDb = dbSupplier,
    private readonly coverageRevision:
      | string
      | null = membershipReaderCoverageRevision()
  ) {
    super(getDb);
  }

  async read(
    profileId: string,
    candidates: MembershipCandidateIds,
    direct: MembershipDirectEvaluator,
    shadow = false,
    deadlineMonotonicMillis = performance.now() + CONTROLLED_READ_BUDGET_MILLIS
  ): Promise<MembershipScopedReadResult> {
    return withMembershipPrimaryTransaction(
      this.db,
      (ctx) => this.readSnapshot(profileId, candidates, direct, shadow, ctx),
      {},
      readerBudget(deadlineMonotonicMillis)
    );
  }

  private async readSnapshot(
    profileId: string,
    candidates: MembershipCandidateIds,
    direct: MembershipDirectEvaluator,
    shadow: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipScopedReadResult> {
    const ids = Array.from(new Set(await candidates(ctx)));
    if (ids.length > MAX_CONTROLLED_CANDIDATES)
      return this.candidateCapResult(ids.length);
    const now = await this.now(ctx);
    const foundGeneration = await this.generation(profileId, now, ctx);
    const generation = foundGeneration === 'INVALID' ? null : foundGeneration;
    const publicationFailure =
      foundGeneration === 'INVALID'
        ? ('publication_invalid' as const)
        : ('publication_missing' as const);
    const groups = await this.groups(ids, generation?.through ?? null, ctx);
    const evidence = await this.readEvidence(profileId, generation, ctx);
    const partition = this.partitionReadiness(
      groups,
      generation,
      evidence,
      now,
      publicationFailure
    );
    return this.assembleRead(
      profileId,
      groups,
      generation,
      partition,
      direct,
      shadow,
      ctx
    );
  }

  private candidateCapResult(
    candidateCount: number
  ): MembershipScopedReadResult {
    return {
      eligible_group_ids: [],
      candidate_count: candidateCount,
      coverage_complete: false,
      materialized_count: 0,
      direct_count: 0,
      direct_duration_ms: 0,
      shadow_duration_ms: null,
      fallback_reasons: { candidate_cap: 1 },
      shadow_direct_group_ids: null,
      shadow_equal: null
    };
  }

  private async readEvidence(
    profileId: string,
    generation: Generation | null,
    ctx: MembershipPrimaryContext
  ): Promise<ReadEvidence> {
    if (!generation)
      return { source: null, catalogue: null, identityKey: null };
    let source: Map<string, MembershipSourceEvidence> | null = null;
    if (this.coverageRevision) {
      const evidence = await new MembershipSourceStatesDb(() => this.db).read(
        membershipProfileSourceKeys(profileId),
        false,
        ctx
      );
      const receipts = await this.coverageReceipts(profileId, ctx);
      source = new Map(
        evidence.map((entry) => {
          const key = membershipSourceKeyId(entry.key);
          return [
            key,
            {
              ...entry,
              provisioned:
                entry.provisioned && receipts.get(key) === this.coverageRevision
            }
          ] as const;
        })
      );
    }
    // An unconfigured coverage revision is deliberately not readiness proof.
    const identityRows = await this.db.execute<{ consolidation_key: string }>(
      `SELECT consolidation_key FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile LIMIT 2`,
      { profile: profileId },
      membershipQueryOptions(ctx)
    );
    return {
      source,
      catalogue:
        source?.get(membershipSourceKeyId(MEMBERSHIP_CATALOG_KEY)) ?? null,
      identityKey:
        identityRows.length === 1 ? identityRows[0].consolidation_key : null
    };
  }

  private partitionReadiness(
    groups: readonly CandidateGroup[],
    generation: Generation | null,
    evidence: ReadEvidence,
    now: string,
    publicationFailure: 'publication_missing' | 'publication_invalid'
  ): ReadinessPartition {
    const partition: ReadinessPartition = {
      directIds: [],
      readyIds: [],
      reasons: {}
    };
    for (const group of groups) {
      const failure = this.fallbackReason(
        group,
        generation,
        evidence,
        now,
        publicationFailure
      );
      if (!failure) {
        partition.readyIds.push(group.id);
        continue;
      }
      partition.directIds.push(group.id);
      partition.reasons[failure] = (partition.reasons[failure] ?? 0) + 1;
    }
    return partition;
  }

  private async assembleRead(
    profileId: string,
    groups: readonly CandidateGroup[],
    generation: Generation | null,
    partition: ReadinessPartition,
    direct: MembershipDirectEvaluator,
    shadow: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipScopedReadResult> {
    const { readyIds, directIds, reasons } = partition;
    const stored =
      readyIds.length && generation
        ? await this.members(profileId, generation.run.id, readyIds, ctx)
        : new Set<string>();
    const directStarted = performance.now();
    const directResult = directIds.length
      ? new Set(await direct(profileId, directIds, ctx))
      : new Set<string>();
    const directDuration = directIds.length
      ? performance.now() - directStarted
      : 0;
    const ready = new Set(readyIds);
    const currentIds = groups.map((group) => group.id);
    const eligible = currentIds.filter((id) =>
      ready.has(id) ? stored.has(id) : directResult.has(id)
    );
    const shadowStarted = performance.now();
    const baseline = shadow
      ? Array.from(new Set(await direct(profileId, currentIds, ctx)))
      : null;
    return {
      eligible_group_ids: eligible,
      candidate_count: currentIds.length,
      coverage_complete: true,
      materialized_count: readyIds.length,
      direct_count: directIds.length,
      direct_duration_ms: directDuration,
      shadow_duration_ms: shadow ? performance.now() - shadowStarted : null,
      fallback_reasons: reasons,
      shadow_direct_group_ids: baseline,
      shadow_equal: baseline === null ? null : sameSet(eligible, baseline)
    };
  }

  /** Fresh direct primary fallback with a strict candidate and shared time cap. */
  async readDirect(
    profileId: string,
    candidates: MembershipCandidateIds,
    direct: MembershipDirectEvaluator,
    deadlineMonotonicMillis: number
  ): Promise<string[]> {
    return withMembershipPrimaryTransaction(
      this.db,
      async (ctx) => {
        const ids = Array.from(new Set(await candidates(ctx)));
        if (ids.length > MAX_DIRECT_CANDIDATES)
          throw new Error('Membership direct candidate bound exceeded');
        return Array.from(new Set(await direct(profileId, ids, ctx)));
      },
      {},
      readerBudget(deadlineMonotonicMillis)
    );
  }

  private async now(ctx: MembershipPrimaryContext): Promise<string> {
    const row = await this.db.oneOrNull<{ now: string }>(
      `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
      {},
      membershipQueryOptions(ctx)
    );
    if (!row) throw new Error('Membership primary clock unavailable');
    return normalizeCounter(row.now);
  }

  private async generation(
    profileId: string,
    now: string,
    ctx: MembershipPrimaryContext
  ): Promise<Generation | 'INVALID' | null> {
    const row = await this.db.oneOrNull<PublishedRun>(
      `SELECT r.id,r.scope,r.target_id,r.status,r.spec_version,
        CAST(r.catalog_version AS CHAR) catalog_version,r.source_versions,r.progress_cursor,
        CAST(r.evaluation_time_millis AS CHAR) evaluation_time_millis,
        CAST(r.valid_until_millis AS CHAR) valid_until_millis,
        CAST(r.completed_at_millis AS CHAR) completed_at_millis
       FROM ${MEMBERSHIP_PUBLICATIONS_TABLE} p
       JOIN ${MEMBERSHIP_REFRESH_RUNS_TABLE} r ON r.id=p.run_id
       WHERE p.profile_id=:profile`,
      { profile: profileId },
      membershipQueryOptions(ctx)
    );
    if (!row) return null;
    let cursor;
    try {
      cursor = normalizeMembershipWorkerCursor(row.progress_cursor);
    } catch {
      return 'INVALID';
    }
    if (
      row.scope !== 'PROFILE' ||
      row.target_id !== profileId ||
      row.status !== 'COMPLETED' ||
      row.completed_at_millis === null ||
      row.spec_version !== MEMBERSHIP_EVALUATOR_SPEC_VERSION ||
      cursor.kind !== 'PROFILE' ||
      cursor.phase !== 'DONE' ||
      cursor.active_input !== null ||
      cursor.after_id !== cursor.through_id
    )
      return 'INVALID';
    try {
      const groupOrder = await this.db.execute<{ collation: string }>(
        `SELECT COLLATION_NAME collation FROM information_schema.columns
         WHERE table_schema=DATABASE() AND table_name=:table AND column_name='id'
         LIMIT 2`,
        { table: USER_GROUPS_TABLE },
        membershipQueryOptions(ctx)
      );
      if (
        groupOrder.length !== 1 ||
        groupOrder[0].collation !== cursor.traversal_collation
      )
        return 'INVALID';
      const catalog = normalizeCounter(row.catalog_version);
      if (BigInt(normalizeCounter(row.evaluation_time_millis)) > BigInt(now))
        return 'INVALID';
      if (row.valid_until_millis !== null)
        normalizeCounter(row.valid_until_millis);
      const vectorInput =
        typeof row.source_versions === 'string'
          ? JSON.parse(row.source_versions)
          : row.source_versions;
      const vector = normalizeSourceVector(
        vectorInput,
        membershipProfileSourceKeys(profileId)
      );
      const sourceVersions = new Map(
        vector.map((v) => [membershipSourceKeyId(v), v.version])
      );
      if (
        sourceVersions.get(membershipSourceKeyId(MEMBERSHIP_CATALOG_KEY)) !==
        catalog
      )
        return 'INVALID';
      return {
        run: row,
        sourceVersions,
        through: cursor.through_id as string | null,
        identityKey: cursor.identity_consolidation_key
      };
    } catch {
      return 'INVALID';
    }
  }

  private async groups(
    ids: readonly string[],
    through: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<CandidateGroup[]> {
    const groups: CandidateGroup[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      groups.push(
        ...(await this.db.execute<CandidateGroup>(
          `SELECT g.*,CAST(v.catalog_version AS CHAR) group_version,v.is_deleted,
          IF(:through IS NULL,0,g.id<=:through) within_generation
         FROM ${USER_GROUPS_TABLE} g LEFT JOIN ${MEMBERSHIP_GROUP_VERSIONS_TABLE} v ON v.group_id=g.id
         WHERE g.id IN (:ids) AND g.visible=1`,
          { ids: chunk, through },
          membershipQueryOptions(ctx)
        ))
      );
    }
    const byId = new Map(groups.map((group) => [group.id, group]));
    return ids.flatMap((id) => {
      const group = byId.get(id);
      return group ? [group] : [];
    });
  }

  private fallbackReason(
    group: CandidateGroup,
    generation: Generation | null,
    evidence: ReadEvidence,
    now: string,
    publicationFailure: 'publication_missing' | 'publication_invalid'
  ): MembershipFallbackReason | null {
    if (!generation) return publicationFailure;
    if (evidence.identityKey === null) return 'identity_missing';
    if (evidence.identityKey !== generation.identityKey)
      return 'identity_changed';
    const catalogue = evidence.catalogue;
    if (
      !catalogue?.state ||
      !catalogue.provisioned ||
      catalogue.state.active_jobs !== 0 ||
      BigInt(catalogue.state.version) < BigInt(generation.run.catalog_version)
    )
      return 'catalogue_unready';
    const groupFailure = this.groupVersionFailure(group, generation);
    if (groupFailure) return groupFailure;
    const sourceFailure = this.sourceFailure(
      group,
      generation,
      evidence.source
    );
    if (sourceFailure) return sourceFailure;
    if (
      group.is_beneficiary_of_grant_id !== null &&
      generation.run.valid_until_millis !== null &&
      BigInt(generation.run.valid_until_millis) <= BigInt(now)
    )
      return 'time_boundary';
    return null;
  }

  private groupVersionFailure(
    group: CandidateGroup,
    generation: Generation
  ): MembershipFallbackReason | null {
    if (group.group_version === null || group.is_deleted === null)
      return 'group_version_missing';
    try {
      if (
        Boolean(group.is_deleted) ||
        BigInt(normalizeCounter(group.group_version)) >
          BigInt(generation.run.catalog_version)
      )
        return 'group_changed';
    } catch {
      return 'group_version_missing';
    }
    if (!group.within_generation) return 'generation_range';
    return null;
  }

  private sourceFailure(
    group: CandidateGroup,
    generation: Generation,
    source: Map<string, MembershipSourceEvidence> | null
  ): MembershipFallbackReason | null {
    for (const dimension of Array.from(membershipGroupDependencies(group))) {
      for (const scope of ['GLOBAL', 'PROFILE'] as const) {
        const key = membershipSourceKeyId({
          scope,
          target_id: scope === 'GLOBAL' ? '*' : generation.run.target_id,
          dimension
        });
        const evidence = source?.get(key);
        if (
          !evidence?.state ||
          !evidence.provisioned ||
          evidence.state.active_jobs !== 0
        )
          return 'source_unready';
        if (evidence.state.version !== generation.sourceVersions.get(key))
          return 'source_changed';
      }
    }
    return null;
  }

  private async members(
    profileId: string,
    runId: string,
    groupIds: readonly string[],
    ctx: MembershipPrimaryContext
  ): Promise<Set<string>> {
    const result = new Set<string>();
    for (let start = 0; start < groupIds.length; start += 100) {
      const rows = await this.db.execute<{ group_id: string }>(
        `SELECT group_id FROM ${MEMBERSHIP_GENERATION_MEMBERS_TABLE}
         WHERE profile_id=:profile AND run_id=:run AND group_id IN (:ids)`,
        {
          profile: profileId,
          run: runId,
          ids: groupIds.slice(start, start + 100)
        },
        membershipQueryOptions(ctx)
      );
      for (const row of rows) result.add(row.group_id);
    }
    return result;
  }

  private async coverageReceipts(
    profileId: string,
    ctx: MembershipPrimaryContext
  ): Promise<Map<string, string>> {
    const rows = await this.db.execute<{
      scope: 'GLOBAL' | 'PROFILE';
      target_id: string;
      dimension: MembershipSourceDimension;
      progress: unknown;
    }>(
      `SELECT scope,target_id,dimension,progress FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       WHERE job_id LIKE 'bootstrap:%' AND status='COMPLETED'
         AND started_version=0 AND completed_version=0
         AND ((scope='GLOBAL' AND target_id='*') OR (scope='PROFILE' AND target_id=:profile))
       LIMIT 64`,
      { profile: profileId },
      membershipQueryOptions(ctx)
    );
    const revisions = new Map<string, string>();
    const duplicates = new Set<string>();
    if (rows.length === 64) return revisions;
    for (const row of rows) {
      const key = membershipSourceKeyId(row);
      const progress = decodedObject(row.progress);
      if (duplicates.has(key)) continue;
      if (revisions.has(key)) {
        revisions.delete(key);
        duplicates.add(key);
        continue;
      }
      if (
        progress?.stage !== 'PROVISIONED' ||
        typeof progress.coverage_revision !== 'string'
      ) {
        continue;
      }
      revisions.set(key, progress.coverage_revision);
    }
    return revisions;
  }
}
