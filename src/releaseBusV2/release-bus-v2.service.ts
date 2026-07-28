import type { RequestContext } from '@/request.context';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getDeployServiceConfigs } from '@/api/deploy/deploy.config';
import { releaseBusGitHubApp } from '@/releaseBusV2/release-bus-v2.github-app';
import {
  getReleaseBusV2Mode,
  getReleaseBusV2BetaAllowlist,
  RELEASE_BUS_V2_LOCK_TTL_MS,
  RELEASE_BUS_V2_MAX_CANDIDATES,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaAllowsLane,
  releaseBusV2BetaAllowsLaneInMode,
  releaseBusV2BetaAllowsRegistration,
  type ReleaseBusV2BetaEntry,
  releaseBusV2AllowsLane
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusV2Repository,
  type ReleaseBusV2DependencyRecord,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2CandidateStagingEvidence,
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2ControlScope,
  ReleaseBusV2DeployPlan,
  ReleaseBusV2Lane,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2PrEvidence,
  ReleaseBusV2RegisterInput,
  ReleaseBusV2Repository,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

export const CANDIDATE_STAGING_EVIDENCE_POLICY =
  'CANDIDATE_STAGING_EVIDENCE_V1' as const;
export const CANDIDATE_EVIDENCE_READY_STATUS =
  'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION' as const;
const PRODUCTION_REPLAN_INTENT_SCAN_LIMIT = 500;

const TERMINAL_TRAIN_STATUSES = new Set([
  'STAGING_VALIDATED',
  'STAGING_ROLLBACK_FAILED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);
const TERMINAL_OPERATION_STATUSES = new Set<
  ReleaseBusV2OperationRecord['status']
>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const PRE_MAIN_PRODUCTION_OPERATION_TYPES = new Set([
  'COMPOSE_BACKEND',
  'COMPOSE_FRONTEND',
  'PREPARE_ARTIFACT_BACKEND',
  'PREPARE_ARTIFACT_FRONTEND'
]);
const PRODUCTION_REPLAN_READY_STATUSES = new Set<
  ReleaseBusV2CandidateRecord['status']
>([
  CANDIDATE_EVIDENCE_READY_STATUS,
  'READY_FOR_PRODUCTION',
  'WAITING_FOR_PRODUCTION_REPLAN'
]);
const PRODUCTION_REPLAN_BOUND_STATUSES = new Set<
  ReleaseBusV2CandidateRecord['status']
>(['PRODUCTION_IN_TRAIN', 'PRODUCTION_BUILDING_OR_QUALIFYING']);
const REQUIRED_MAINTENANCE_LOCKS = new Set([
  'scheduler',
  'staging-environment',
  'production-environment'
]);

export type ReleaseBusV2SafeProductionReplanResult =
  | {
      readonly status: 'REPLANNED';
      readonly trainId: string;
      readonly candidateIds: readonly string[];
      readonly sourceSelectionIds: readonly string[];
    }
  | {
      readonly status: 'FROZEN';
      readonly trainId: string;
      readonly reason: string;
    }
  | {
      readonly status: 'NOOP';
      readonly trainId: string;
      readonly reason: string;
    };

type ProductionReplanRequest = {
  readonly trainId: string;
  readonly reason: string;
  readonly actor: string;
};

type ProductionReplanCandidateSource = {
  readonly candidate: ReleaseBusV2CandidateRecord;
  readonly sourceSelectionId: string;
  readonly sourceTrainId: string | null;
};

type ProductionReplanOmission = {
  readonly candidate: ReleaseBusV2CandidateRecord;
  readonly sourceSelectionId: string | null;
  readonly sourceTrainId: string | null;
  readonly reason: string;
};

type ProductionReplanCandidateQualification =
  | {
      readonly eligible: true;
      readonly source: ProductionReplanCandidateSource;
      readonly evidence: ReleaseBusV2CandidateStagingEvidence;
    }
  | {
      readonly eligible: false;
      readonly omission: ProductionReplanOmission;
    };

export function irreversibleProductionOperationReason(
  operation: ReleaseBusV2OperationRecord
): string | null {
  if (
    operation.operation_type.startsWith('ADVANCE_MAIN_') &&
    operation.status === 'SUCCEEDED'
  )
    return `${operation.operation_type} succeeded`;
  if (
    operation.environment === 'prod' &&
    operation.operation_type.startsWith('DEPLOY_') &&
    (operation.external_id !== null ||
      ['DISPATCHED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED'].includes(
        operation.status
      ))
  )
    return `${operation.operation_type} was dispatched`;
  if (
    operation.operation_type === 'E2E_PROD' &&
    operation.status !== 'CANCELLED'
  )
    return 'production E2E was created';
  return null;
}

function productionReplanOperationMayStillBeRunning(
  operation: ReleaseBusV2OperationRecord
): boolean {
  return (
    ['DISPATCHED', 'RUNNING'].includes(operation.status) ||
    (operation.status === 'PENDING' && operation.external_id !== null)
  );
}

export class ReleaseBusV2StagingTransitionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReleaseBusV2StagingTransitionConflictError';
  }
}

export type ReleaseBusV2ProductionSelectionErrorCode =
  | 'CONFLICT'
  | 'DISABLED'
  | 'NOT_FOUND';

export class ReleaseBusV2ProductionSelectionError extends Error {
  public constructor(
    public readonly code: ReleaseBusV2ProductionSelectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2ProductionSelectionError';
  }
}

export type ReleaseBusV2CurrentStagingRepairErrorCode =
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'DISABLED'
  | 'NOT_FOUND'
  | 'UNPROCESSABLE';

export class ReleaseBusV2CurrentStagingRepairError extends Error {
  public constructor(
    public readonly code: ReleaseBusV2CurrentStagingRepairErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2CurrentStagingRepairError';
  }
}

type ReleaseBusV2ManifestCandidateIdentity = {
  readonly candidate_id?: string;
  readonly repository?: string;
  readonly pr_number?: number;
  readonly head_sha?: string;
};

function manifestContainsExactCandidate(
  manifestCandidates: readonly ReleaseBusV2ManifestCandidateIdentity[] | null,
  candidate: ReleaseBusV2CandidateRecord
): boolean {
  if (!manifestCandidates) return false;
  // New manifests carry candidate_id on every entry. Legacy manifests carry
  // none, so their exact train membership plus repository/PR/head identity is
  // the compatibility fence. A mixed manifest may not use a missing id as a
  // wildcard.
  const carriesCandidateIds = manifestCandidates.some(
    ({ candidate_id }) => candidate_id !== undefined
  );
  const matches = manifestCandidates.filter(
    (item) =>
      (!carriesCandidateIds || item.candidate_id === candidate.id) &&
      item.repository === candidate.repository &&
      item.pr_number === candidate.pr_number &&
      item.head_sha === candidate.head_sha
  );
  return matches.length === 1;
}

export type ReleaseBusV2StagingIdentity = {
  readonly frontendSha: string | null;
  readonly backendSha: string | null;
};

export type ReleaseBusV2QualificationYieldResult = {
  readonly yielded: boolean;
  readonly parentTrainId: string;
  readonly qualificationTrainId: string;
  readonly candidateIds: readonly string[];
};

export type ReleaseBusV2CurrentStagingRepairIdentity = {
  readonly repository: ReleaseBusV2Repository;
  readonly pr_number: number;
  readonly head_sha: string;
};

export type ReleaseBusV2CurrentStagingRepairResult = {
  readonly manifest_id: string;
  readonly train_id: string;
  readonly dry_run: boolean;
  readonly discovered: boolean;
  readonly candidates: readonly {
    readonly candidate_id: string;
    readonly repository: ReleaseBusV2Repository;
    readonly pr_number: number;
    readonly head_sha: string;
    readonly previous_status: ReleaseBusV2CandidateStatus;
    readonly previous_staging_live_state: string | null;
    readonly derived_status: 'STAGING_VALIDATED';
    readonly derived_staging_live_state: 'LIVE';
    readonly would_change: boolean;
    readonly changed: boolean;
  }[];
  readonly github_status_updates: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly newly_derived: number;
    readonly reasserted: number;
    readonly failed_candidates: readonly {
      readonly candidate_id: string;
      readonly repository: ReleaseBusV2Repository;
      readonly pr_number: number;
      readonly head_sha: string;
    }[];
  };
};

export function normalizeDeployPlan(
  repository: ReleaseBusV2Repository,
  plan: ReleaseBusV2DeployPlan | null
): ReleaseBusV2DeployPlan | null {
  if (repository === 'frontend') {
    if (plan)
      throw new Error(
        'Frontend candidates cannot declare backend deploy units'
      );
    return null;
  }
  if (!plan || plan.units.length === 0)
    throw new Error('Backend candidates require at least one deploy unit');
  const serviceConfigs = getDeployServiceConfigs();
  const allowed = new Set(serviceConfigs.map((service) => service.name));
  const units = Array.from(new Set(plan.units));
  if (units.some((unit) => !allowed.has(unit)))
    throw new Error('Backend deploy plan contains an unknown service');
  const selected = new Set(units);
  const declaredEdges = plan.edges.map(([from, to]) => {
    if (from === to || !selected.has(from) || !selected.has(to))
      throw new Error(
        'Backend deploy edges must reference distinct selected units'
      );
    return [from, to] as const;
  });
  const edgeKeys = new Set<string>();
  const edges = serviceConfigs
    .flatMap((service) =>
      service.default_dependencies
        .filter(
          (dependency) => selected.has(service.name) && selected.has(dependency)
        )
        .map((dependency) => [dependency, service.name] as const)
    )
    .concat(declaredEdges)
    .filter(([from, to]) => {
      const key = `${from}\u0000${to}`;
      if (edgeKeys.has(key)) return false;
      edgeKeys.add(key);
      return true;
    })
    .sort(([leftFrom, leftTo], [rightFrom, rightTo]) =>
      `${leftFrom}\u0000${leftTo}`.localeCompare(`${rightFrom}\u0000${rightTo}`)
    );
  topologicalOrder(units, edges);
  return plan.publish_release_notes === false
    ? { units, edges, publish_release_notes: false }
    : { units, edges };
}

export function topologicalOrder(
  nodes: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>
): string[] {
  const unique = Array.from(new Set(nodes)).sort((left, right) =>
    left.localeCompare(right)
  );
  const incoming = new Map(unique.map((node) => [node, 0]));
  const outgoing = new Map(unique.map((node) => [node, new Set<string>()]));
  for (const [from, to] of edges) {
    if (!incoming.has(from) || !incoming.has(to))
      throw new Error('Dependency edge references an unknown node');
    if (outgoing.get(from)?.has(to)) continue;
    outgoing.get(from)?.add(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const ready = unique.filter((node) => incoming.get(node) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift();
    if (!node) break;
    result.push(node);
    for (const next of Array.from(outgoing.get(node) ?? []).sort(
      (left, right) => left.localeCompare(right)
    )) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  if (result.length !== unique.length)
    throw new Error('Dependency graph contains a cycle');
  return result;
}

function parseStoredJson<T>(value: unknown): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function laneScope(lane: ReleaseBusV2Lane): 'STAGING' | 'PRODUCTION' {
  return lane === 'PRODUCTION' ? 'PRODUCTION' : 'STAGING';
}

function readyStatus(lane: ReleaseBusV2Lane): ReleaseBusV2CandidateStatus {
  return lane === 'PRODUCTION' ? 'READY_FOR_PRODUCTION' : 'READY_FOR_STAGING';
}

function claimedStatus(lane: ReleaseBusV2Lane): ReleaseBusV2CandidateStatus {
  return lane === 'PRODUCTION' ? 'PRODUCTION_IN_TRAIN' : 'STAGING_IN_TRAIN';
}

function sameQualificationIdentity(
  stored: ReleaseBusV2CandidateRecord['pr_evidence_json'],
  current: {
    readonly base_sha: string;
    readonly merge_sha: string;
    readonly artifact_run_id: string | null;
    readonly artifact_name: string | null;
    readonly artifact_digest: string | null;
  }
): boolean {
  const evidence = parseStoredJson<ReleaseBusV2PrEvidence>(stored);
  if (!evidence) return false;
  return (
    evidence.base_sha === current.base_sha &&
    evidence.merge_sha === current.merge_sha &&
    (evidence.artifact_run_id === null ||
      (evidence.artifact_run_id === current.artifact_run_id &&
        evidence.artifact_name === current.artifact_name &&
        evidence.artifact_digest === current.artifact_digest))
  );
}

function candidateRegistrationStatus(candidate: ReleaseBusV2CandidateRecord): {
  readonly state: 'failure' | 'pending' | 'success';
  readonly description: string;
} {
  if (candidate.status === 'PRODUCTION_DEPLOYED')
    return {
      state: 'success',
      description: 'Exact v2 production deployment completed'
    };
  if (candidate.status === 'STAGING_VALIDATED')
    return {
      state: 'success',
      description: 'Exact v2 staging manifest validated; production is explicit'
    };
  if (['FAILED', 'NEEDS_REBASE'].includes(candidate.status))
    return {
      state: 'failure',
      description:
        candidate.status === 'NEEDS_REBASE'
          ? 'Exact v2 composition requires rebase'
          : 'Release Bus v2 candidate failed; see Deploy UI'
    };
  if (['SUPERSEDED', 'CANCELLED'].includes(candidate.status))
    return {
      state: 'success',
      description: `v2 readiness ${candidate.status.toLowerCase()}`
    };
  return {
    state: 'pending',
    description:
      candidate.status === 'READY_FOR_STAGING'
        ? 'Ready for v2 staging'
        : `Release Bus v2: ${candidate.status.replace(/_/g, ' ').toLowerCase()}`
  };
}

function restoredCarryForwardStatus(
  candidate: ReleaseBusV2CandidateRecord,
  hasProductionDeployment: boolean
): ReleaseBusV2CandidateStatus {
  if (hasProductionDeployment) return 'PRODUCTION_DEPLOYED';
  if (candidate.production_requested_at === null) return 'STAGING_VALIDATED';
  if (candidate.production_selection_id) return CANDIDATE_EVIDENCE_READY_STATUS;
  return 'READY_FOR_PRODUCTION';
}

export class ReleaseBusV2Service {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository
  ) {}

  private async resolvePreMainProductionRetrySource(
    candidate: ReleaseBusV2CandidateRecord,
    ctx: RequestContext
  ): Promise<string | null> {
    if (candidate.status === 'STAGING_VALIDATED') return null;
    if (
      candidate.status !== 'FAILED' ||
      candidate.current_train_id !== null ||
      candidate.production_selection_id === null ||
      candidate.production_selection_id === undefined
    )
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'The exact candidate SHA is not staging validated'
      );
    const train = await this.repository.findLatestProductionTrainForCandidate(
      candidate.id,
      ctx,
      Boolean(ctx.connection)
    );
    if (
      !train ||
      train.status !== 'FAILED' ||
      train.completed_at === null ||
      train.failure_class !== 'CANDIDATE' ||
      train.qualification_policy !== CANDIDATE_STAGING_EVIDENCE_POLICY
    )
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Failed candidate is not eligible for an exact pre-main production retry'
      );
    const evidence =
      parseStoredJson<readonly ReleaseBusV2CandidateStagingEvidence[]>(
        train.qualification_evidence_json
      ) ?? [];
    const exactEvidence = evidence.filter(
      (item) =>
        item.candidate_id === candidate.id &&
        item.repository === candidate.repository &&
        item.pr_number === candidate.pr_number &&
        item.head_sha === candidate.head_sha &&
        item.staging_train_id === candidate.staging_validated_train_id &&
        item.staging_manifest_id === candidate.staging_validated_manifest_id
    );
    if (exactEvidence.length !== 1)
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Failed candidate retry source does not match its exact staging evidence'
      );
    const operations = await this.repository.listOperations(
      train.id,
      ctx,
      Boolean(ctx.connection)
    );
    const failedPreflight = operations.some(
      (operation) =>
        operation.operation_type.startsWith('PREPARE_ARTIFACT_') &&
        operation.status === 'FAILED'
    );
    const onlyTerminalPreMainOperations = operations.every(
      (operation) =>
        PRE_MAIN_PRODUCTION_OPERATION_TYPES.has(operation.operation_type) &&
        TERMINAL_OPERATION_STATUSES.has(operation.status)
    );
    if (
      operations.length === 0 ||
      !failedPreflight ||
      !onlyTerminalPreMainOperations
    )
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Failed candidate is not eligible for an exact pre-main production retry'
      );
    return train.id;
  }

  private async retryGroupedStagingPreflightCandidate(
    candidate: ReleaseBusV2CandidateRecord,
    evidence: ReleaseBusV2PrEvidence,
    actor: string,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord> {
    const current = await this.repository.findCandidateById(
      candidate.id,
      ctx,
      true
    );
    if (
      !current ||
      current.status !== 'FAILED' ||
      current.current_train_id !== null ||
      current.staging_live_state === 'LIVE' ||
      current.superseded_at !== null ||
      current.production_requested_at !== null ||
      current.production_selection_id !== null
    )
      throw new Error(
        'Exact candidate is not an unowned grouped staging preflight failure'
      );
    if (
      !isDeepStrictEqual(
        parseStoredJson<ReleaseBusV2PrEvidence>(current.pr_evidence_json),
        evidence
      )
    )
      throw new Error(
        'Grouped staging preflight retry requires unchanged exact PR evidence'
      );
    const failureEvents = await this.repository.listCandidateEvents(
      current.id,
      'STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED',
      100,
      ctx
    );
    const matchingFailures = failureEvents
      .map((event) => ({
        event,
        payload: parseStoredJson<{
          readonly repository?: unknown;
          readonly pr_number?: unknown;
          readonly head_sha?: unknown;
          readonly failed_candidate_row_version?: unknown;
          readonly failed_group_candidate_ids?: unknown;
          readonly failed_operation_ids?: unknown;
        }>(event.payload_json)
      }))
      .filter(
        ({ event, payload }) =>
          event.train_id !== null &&
          payload?.repository === current.repository &&
          payload.pr_number === current.pr_number &&
          payload.head_sha === current.head_sha &&
          payload.failed_candidate_row_version === current.row_version &&
          Array.isArray(payload.failed_group_candidate_ids) &&
          payload.failed_group_candidate_ids.every(
            (id): id is string => typeof id === 'string'
          ) &&
          payload.failed_group_candidate_ids.includes(current.id) &&
          Array.isArray(payload.failed_operation_ids) &&
          payload.failed_operation_ids.length === 1 &&
          payload.failed_operation_ids.every(
            (id): id is string => typeof id === 'string'
          )
      );
    if (matchingFailures.length !== 1)
      throw new Error(
        'Exact candidate has no unambiguous latest grouped staging preflight failure'
      );
    const sourceFailure = matchingFailures[0];
    const sourceTrainId = sourceFailure.event.train_id;
    if (!sourceTrainId)
      throw new Error('Grouped staging preflight failure has no source train');
    const [sourceTrain, memberships, operations, priorRetries] =
      await Promise.all([
        this.repository.findTrain(sourceTrainId, ctx),
        this.repository.listTrainCandidates(sourceTrainId, ctx),
        this.repository.listOperations(sourceTrainId, ctx, true),
        this.repository.listCandidateEvents(
          current.id,
          'STAGING_REPOSITORY_PREFLIGHT_GROUP_EXPLICIT_RETRY',
          500,
          ctx
        )
      ]);
    const membership = memberships.filter(
      (item) =>
        item.candidate_id === current.id &&
        item.candidate_role === 'NEW' &&
        item.disposition === 'REPOSITORY_PREFLIGHT_FAILED'
    );
    const failedOperationIds = new Set(
      sourceFailure.payload?.failed_operation_ids as readonly string[]
    );
    const exactFailedOperations = operations.filter(
      (operation) =>
        failedOperationIds.has(operation.id) &&
        operation.operation_type ===
          `PREPARE_ARTIFACT_${current.repository.toUpperCase()}` &&
        operation.repository === current.repository &&
        operation.status === 'FAILED' &&
        operation.failure_class === 'CANDIDATE'
    );
    if (
      !sourceTrain ||
      sourceTrain.lane !== 'STAGING' ||
      sourceTrain.status !== 'FAILED' ||
      sourceTrain.failure_class !== 'CANDIDATE' ||
      sourceTrain.completed_at === null ||
      membership.length !== 1 ||
      exactFailedOperations.length !== failedOperationIds.size
    )
      throw new Error(
        'Grouped staging preflight retry source is not one exact terminal failed train'
      );
    const retryId = randomUUID();
    const retryAttempt =
      priorRetries.reduce((maximum, event) => {
        const attempt = parseStoredJson<{ readonly retry_attempt?: unknown }>(
          event.payload_json
        )?.retry_attempt;
        return typeof attempt === 'number' &&
          Number.isSafeInteger(attempt) &&
          attempt > maximum
          ? attempt
          : maximum;
      }, 0) + 1;
    if (
      !(await this.repository.updateCandidate(
        current.id,
        current.row_version,
        {
          status: 'READY_FOR_STAGING',
          currentTrainId: null,
          holdReason: null
        },
        ctx
      ))
    )
      throw new Error('Candidate changed concurrently');
    await this.repository.appendEvent(
      {
        trainId: sourceTrain.id,
        candidateId: current.id,
        eventType: 'STAGING_REPOSITORY_PREFLIGHT_GROUP_EXPLICIT_RETRY',
        actor,
        payload: {
          retry_id: retryId,
          retry_attempt: retryAttempt,
          source_failure_event_id: sourceFailure.event.id,
          source_train_id: sourceTrain.id,
          repository: current.repository,
          pr_number: current.pr_number,
          head_sha: current.head_sha,
          source_failed_candidate_row_version: current.row_version,
          requeued_candidate_row_version: current.row_version + 1,
          checks_run_id: evidence.checks_run_id,
          checks_completed_at: evidence.checks_completed_at
        }
      },
      ctx
    );
    const retried = await this.repository.findCandidateById(current.id, ctx);
    if (!retried || retried.status !== 'READY_FOR_STAGING')
      throw new Error(
        'Explicit grouped staging preflight retry did not persist'
      );
    return retried;
  }

  public async register(
    input: ReleaseBusV2RegisterInput,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const mode = getReleaseBusV2Mode();
    const betaAllowlist = mode === 'OFF' ? getReleaseBusV2BetaAllowlist() : [];
    const isBetaRegistration =
      mode === 'OFF' &&
      releaseBusV2BetaAllowsRegistration(betaAllowlist, input, actor);
    if (!releaseBusV2AllowsLane(mode, 'STAGING') && !isBetaRegistration)
      throw new Error('Release Bus v2 staging readiness is disabled');
    if (mode !== 'OFF' && input.candidate_id)
      throw new Error('Explicit candidate ids are reserved for the OFF beta');
    if (
      isBetaRegistration &&
      input.dependencies.some(
        ({ candidate_id }) =>
          !betaAllowlist.some(
            (entry) => entry.candidate_id === candidate_id.toLowerCase()
          )
      )
    )
      throw new Error('Beta dependencies must be explicitly allowlisted');
    await this.assertScopeRunning('STAGING');
    if (!/^[A-Za-z0-9._/-]{1,255}$/.test(input.branch_name))
      throw new Error('Invalid branch name');
    const expectedHeadSha = input.expected_head_sha.toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(expectedHeadSha))
      throw new Error('expected_head_sha must be a 40-character Git SHA');
    if (!Number.isSafeInteger(input.pr_number) || input.pr_number < 1)
      throw new Error('pr_number must be a positive integer');
    const deployPlan = normalizeDeployPlan(input.repository, input.deploy_plan);
    const resolvedHead = await releaseBusGitHubApp.resolveRef(
      input.repository,
      input.branch_name
    );
    if (resolvedHead !== expectedHeadSha)
      throw new Error(
        `Branch moved from ${expectedHeadSha} to ${resolvedHead}`
      );
    const qualification = await releaseBusGitHubApp.getPullRequestQualification(
      input.repository,
      input.pr_number,
      expectedHeadSha
    );
    const verifiedHead = await releaseBusGitHubApp.resolveRef(
      input.repository,
      input.branch_name
    );
    if (verifiedHead !== expectedHeadSha)
      throw new Error(
        `Branch moved from ${expectedHeadSha} to ${verifiedHead}`
      );
    const evidence = {
      base_sha: qualification.baseSha,
      merge_sha: qualification.mergeSha,
      checks_run_id: qualification.checksRunId,
      checks_completed_at: qualification.checksCompletedAt,
      artifact_run_id: qualification.artifactRunId,
      artifact_name: qualification.artifactName,
      artifact_digest: qualification.artifactDigest,
      contributor_github_logins: qualification.contributorGithubLogins
    };
    const registration =
      await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { connection };
          const superseded = isBetaRegistration
            ? []
            : await this.repository.supersedeOtherPrHeads(
                input.repository,
                input.pr_number,
                expectedHeadSha,
                ctx
              );
          const betaCandidateId = isBetaRegistration
            ? input.candidate_id?.toLowerCase()
            : undefined;
          const existingBetaCandidate = betaCandidateId
            ? await this.repository.findCandidateById(betaCandidateId, ctx)
            : null;
          if (
            existingBetaCandidate &&
            (existingBetaCandidate.repository !== input.repository ||
              existingBetaCandidate.pr_number !== input.pr_number ||
              existingBetaCandidate.branch_name !== input.branch_name ||
              existingBetaCandidate.head_sha !== expectedHeadSha)
          )
            throw new Error(
              'The beta candidate id is immutable and cannot be reused for a different identity or head SHA'
            );
          let candidate =
            existingBetaCandidate ??
            (await this.repository.findCandidateByIdentity(
              input.repository,
              input.pr_number,
              expectedHeadSha,
              ctx
            ));
          let created = false;
          if (!candidate) {
            candidate = await this.repository.createCandidate(
              {
                candidateId: betaCandidateId,
                repository: input.repository,
                prNumber: input.pr_number,
                branchName: input.branch_name,
                headSha: expectedHeadSha,
                requestedBy: actor,
                deployPlan,
                prEvidence: evidence
              },
              ctx
            );
            created = true;
          } else {
            if (
              isBetaRegistration &&
              candidate.id !== input.candidate_id?.toLowerCase()
            )
              throw new Error(
                'The exact beta identity already has a different candidate id'
              );
            const existingDependencies = await this.repository.listDependencies(
              [candidate.id],
              ctx
            );
            const requestedDependencies = input.dependencies
              .map(
                (dependency) =>
                  `${dependency.candidate_id}:${dependency.environment}`
              )
              .sort((left, right) => left.localeCompare(right));
            const storedDependencies = existingDependencies
              .map(
                (dependency) =>
                  `${dependency.prerequisite_candidate_id}:${dependency.environment}`
              )
              .sort((left, right) => left.localeCompare(right));
            if (
              candidate.branch_name !== input.branch_name ||
              !isDeepStrictEqual(
                parseStoredJson(candidate.deploy_plan_json),
                deployPlan
              ) ||
              !sameQualificationIdentity(
                candidate.pr_evidence_json,
                evidence
              ) ||
              !isDeepStrictEqual(storedDependencies, requestedDependencies)
            )
              throw new Error(
                'The exact candidate identity was reused with different immutable registration data'
              );
            if (candidate.status === 'SUPERSEDED')
              throw new Error(
                'A superseded exact candidate head cannot be registered again'
              );
            if (candidate.status === 'FAILED')
              candidate = await this.retryGroupedStagingPreflightCandidate(
                candidate,
                evidence,
                actor,
                ctx
              );
          }
          for (const dependency of input.dependencies) {
            const prerequisite = await this.repository.findCandidateById(
              dependency.candidate_id,
              ctx
            );
            if (!prerequisite)
              throw new Error(
                `Dependency ${dependency.candidate_id} does not exist`
              );
            if (prerequisite.id === candidate.id)
              throw new Error('A candidate cannot depend on itself');
            if (
              candidate.repository === 'backend' &&
              prerequisite.repository === 'frontend'
            )
              throw new Error(
                'Backend candidates cannot depend on frontend-first deployment'
              );
            await this.repository.addDependency(
              candidate.id,
              prerequisite.id,
              dependency.environment,
              ctx
            );
          }
          await this.assertAcyclic(ctx);
          if (created)
            await this.repository.appendEvent(
              {
                candidateId: candidate.id,
                eventType: 'CANDIDATE_READY_FOR_STAGING',
                actor,
                payload: {
                  repository: candidate.repository,
                  pr_number: candidate.pr_number,
                  head_sha: candidate.head_sha,
                  operator_beta: isBetaRegistration,
                  beta_test_id: isBetaRegistration
                    ? // Config validation requires one shared test_id.
                      betaAllowlist[0]?.test_id
                    : null
                }
              },
              ctx
            );
          return { candidate, superseded };
        }
      );
    await Promise.all(
      registration.superseded.map((superseded) =>
        releaseBusGitHubApp.ensureCommitStatus(
          superseded.repository,
          superseded.head_sha,
          'success',
          'Superseded by a newer exact PR head',
          'Release Bus v2'
        )
      )
    );
    const published = candidateRegistrationStatus(registration.candidate);
    await releaseBusGitHubApp.ensureCommitStatus(
      registration.candidate.repository,
      registration.candidate.head_sha,
      published.state,
      published.description,
      'Release Bus v2'
    );
    return registration.candidate;
  }

  public async markReadyForProduction(
    candidateId: string,
    expectedHeadSha: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const candidates = await this.markSelectionReadyForProduction(
      [{ candidateId, expectedHeadSha, expectedRowVersion }],
      actor
    );
    const candidate = candidates[0];
    if (!candidate)
      throw new Error('Production selection did not return its candidate');
    return candidate;
  }

  public async markSelectionReadyForProduction(
    selection: readonly {
      readonly candidateId: string;
      readonly expectedHeadSha: string;
      readonly expectedRowVersion: number;
    }[],
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    if (selection.length === 0)
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Production selection requires at least one candidate'
      );
    const selectedIds = new Set(
      selection.map(({ candidateId }) => candidateId)
    );
    if (selectedIds.size !== selection.length)
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Production selection contains a duplicate candidate'
      );
    const mode = getReleaseBusV2Mode();
    const snapshots = await Promise.all(
      selection.map(({ candidateId }) =>
        this.repository.findCandidateById(candidateId, {})
      )
    );
    if (snapshots.some((candidate) => candidate === null))
      throw new ReleaseBusV2ProductionSelectionError(
        'NOT_FOUND',
        'Production selection candidate not found'
      );
    const candidates = snapshots.filter(
      (candidate): candidate is ReleaseBusV2CandidateRecord =>
        candidate !== null
    );
    const betaAllowlist =
      mode === 'OFF' || mode === 'STAGING'
        ? getReleaseBusV2BetaAllowlist()
        : [];
    const isBetaPromotion =
      candidates.length > 0 &&
      releaseBusV2BetaAllowsLaneInMode(mode, betaAllowlist, 'PRODUCTION') &&
      candidates.every(
        (candidate) =>
          releaseBusV2BetaAllowsCandidate(
            betaAllowlist,
            candidate,
            'PRODUCTION'
          ) && candidate.requested_by.toLowerCase() === actor.toLowerCase()
      );
    if (!releaseBusV2AllowsLane(mode, 'PRODUCTION') && !isBetaPromotion)
      throw new ReleaseBusV2ProductionSelectionError(
        'DISABLED',
        'Release Bus v2 production readiness is disabled'
      );
    try {
      await this.assertScopeRunning('PRODUCTION');
    } catch (error) {
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        error instanceof Error
          ? error.message
          : 'Release Bus v2 production controls are unavailable'
      );
    }
    const selectionById = new Map(
      selection.map((item) => [item.candidateId, item])
    );
    for (const candidate of candidates) {
      const expected = selectionById.get(candidate.id);
      if (!expected || candidate.row_version !== expected.expectedRowVersion)
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          'Candidate changed; refresh before marking production ready'
        );
      if (candidate.superseded_at !== null)
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          'The exact candidate SHA is not staging validated'
        );
      await this.resolvePreMainProductionRetrySource(candidate, {});
      if (candidate.head_sha !== expected.expectedHeadSha.toLowerCase())
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          'Requested production SHA does not match the candidate'
        );
    }
    await this.resolveCandidateStagingEvidence(candidates, {});
    await this.assertProductionDependencyClosure(candidates, {});
    const currentHeads = await Promise.all(
      candidates.map((candidate) =>
        releaseBusGitHubApp.resolveRef(
          candidate.repository,
          candidate.branch_name
        )
      )
    );
    for (let index = 0; index < candidates.length; index += 1) {
      if (currentHeads[index] !== candidates[index]?.head_sha)
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          'Candidate branch moved after staging validation'
        );
    }
    const scheduler = await this.repository.acquireLock(
      'scheduler',
      null,
      `production-selection:${randomUUID()}`,
      RELEASE_BUS_V2_LOCK_TTL_MS,
      {}
    );
    if (!scheduler?.lease_token)
      throw new ReleaseBusV2ProductionSelectionError(
        'CONFLICT',
        'Production selection raced another scheduler transaction; refresh and retry'
      );
    try {
      return await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { connection };
          const locked: ReleaseBusV2CandidateRecord[] = [];
          const retrySourceByCandidateId = new Map<string, string>();
          const orderedIds = Array.from(selectedIds).sort((left, right) =>
            left.localeCompare(right)
          );
          const dependencies = await this.repository.listDependencies(
            orderedIds,
            ctx
          );
          const lockIds = Array.from(
            new Set([
              ...orderedIds,
              ...dependencies
                .filter(({ environment }) => environment !== 'STAGING')
                .map(
                  ({ prerequisite_candidate_id }) => prerequisite_candidate_id
                )
            ])
          ).sort((left, right) => left.localeCompare(right));
          const lockedById = new Map<
            string,
            ReleaseBusV2CandidateRecord | null
          >();
          for (const candidateId of lockIds)
            lockedById.set(
              candidateId,
              await this.repository.findCandidateById(candidateId, ctx, true)
            );
          // The exact candidate rows remain locked until the new selection is
          // committed. A production claim must change one of those rows from a
          // ready state while holding the scheduler lease, so no newer train can
          // include a FAILED retry candidate between this lookup and its update.
          for (const selectedId of orderedIds) {
            const candidate = lockedById.get(selectedId) ?? null;
            if (!candidate)
              throw new ReleaseBusV2ProductionSelectionError(
                'NOT_FOUND',
                'Candidate not found'
              );
            const expected = selectionById.get(candidate.id);
            if (
              !expected ||
              candidate.row_version !== expected.expectedRowVersion
            )
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'Candidate changed; refresh before marking production ready'
              );
            if (
              !candidate.staging_validated_manifest_id ||
              candidate.superseded_at !== null
            )
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'The exact candidate SHA is not staging validated'
              );
            const retrySource = await this.resolvePreMainProductionRetrySource(
              candidate,
              ctx
            );
            if (retrySource)
              retrySourceByCandidateId.set(candidate.id, retrySource);
            if (candidate.head_sha !== expected.expectedHeadSha.toLowerCase())
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'Candidate changed after branch verification'
              );
            locked.push(candidate);
          }
          // Re-resolve while every selected candidate row is locked. The earlier
          // resolution is a fast rejection; this is the authoritative
          // selection-write fence.
          const lockedHeads = await Promise.all(
            locked.map((candidate) =>
              releaseBusGitHubApp.resolveRef(
                candidate.repository,
                candidate.branch_name
              )
            )
          );
          for (let index = 0; index < locked.length; index += 1) {
            if (lockedHeads[index] !== locked[index]?.head_sha)
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'Candidate changed after branch verification'
              );
          }
          const evidence = await this.resolveCandidateStagingEvidence(
            locked,
            ctx
          );
          await this.assertProductionDependencyClosure(locked, ctx, lockedById);
          const now = Date.now();
          const selectionId = randomUUID();
          for (const candidate of locked) {
            if (
              !(await this.repository.updateCandidate(
                candidate.id,
                candidate.row_version,
                {
                  status: CANDIDATE_EVIDENCE_READY_STATUS,
                  productionRequestedAt: now,
                  productionRequestedBy: actor,
                  productionSelectionId: selectionId
                },
                ctx
              ))
            )
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'Candidate changed concurrently'
              );
          }
          await this.repository.appendEvent(
            {
              eventType: 'PRODUCTION_SELECTION_READY',
              actor,
              payload: {
                production_selection_id: selectionId,
                qualification_policy: CANDIDATE_STAGING_EVIDENCE_POLICY,
                candidate_ids: locked.map(({ id }) => id),
                candidate_evidence: evidence,
                retry_sources: locked.flatMap(({ id }) => {
                  const failedTrainId = retrySourceByCandidateId.get(id);
                  return failedTrainId
                    ? [{ candidate_id: id, failed_train_id: failedTrainId }]
                    : [];
                })
              }
            },
            ctx
          );
          for (const candidate of locked)
            await this.repository.appendEvent(
              {
                candidateId: candidate.id,
                eventType: 'CANDIDATE_READY_FOR_PRODUCTION',
                actor,
                payload: {
                  head_sha: candidate.head_sha,
                  production_selection_id: selectionId,
                  qualification_policy: CANDIDATE_STAGING_EVIDENCE_POLICY,
                  retry_source_train_id:
                    retrySourceByCandidateId.get(candidate.id) ?? null,
                  staging_evidence: evidence.find(
                    ({ candidate_id }) => candidate_id === candidate.id
                  )
                }
              },
              ctx
            );
          for (const candidate of locked) {
            const failedTrainId = retrySourceByCandidateId.get(candidate.id);
            if (!failedTrainId) continue;
            await this.repository.appendEvent(
              {
                candidateId: candidate.id,
                eventType: 'CANDIDATE_PRE_MAIN_PRODUCTION_RETRY_READY',
                actor,
                payload: {
                  failed_train_id: failedTrainId,
                  head_sha: candidate.head_sha,
                  production_selection_id: selectionId,
                  qualification_policy: CANDIDATE_STAGING_EVIDENCE_POLICY,
                  staging_evidence: evidence.find(
                    ({ candidate_id }) => candidate_id === candidate.id
                  )
                }
              },
              ctx
            );
          }
          const updated: ReleaseBusV2CandidateRecord[] = [];
          for (const candidate of locked) {
            const current = await this.repository.findCandidateById(
              candidate.id,
              ctx
            );
            if (!current)
              throw new ReleaseBusV2ProductionSelectionError(
                'CONFLICT',
                'Candidate disappeared after production readiness'
              );
            updated.push(current);
          }
          return updated;
        }
      );
    } finally {
      await this.repository.releaseLock('scheduler', scheduler.lease_token, {});
    }
  }

  public async resolveCandidateStagingEvidence(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateStagingEvidence[]> {
    const evidence: ReleaseBusV2CandidateStagingEvidence[] = [];
    for (const candidate of candidates) {
      if (
        candidate.superseded_at !== null ||
        !candidate.staging_validated_train_id ||
        !candidate.staging_validated_manifest_id
      )
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          `Candidate ${candidate.id} has no current staging validation evidence`
        );
      // This method also runs while holding a native SQL transaction. Keep
      // queries sequential because one connection cannot safely multiplex
      // protocol commands.
      const train = await this.repository.findTrain(
        candidate.staging_validated_train_id,
        ctx
      );
      const manifest = await this.repository.findManifest(
        candidate.staging_validated_manifest_id,
        ctx
      );
      const memberships = await this.repository.listTrainCandidates(
        candidate.staging_validated_train_id,
        ctx
      );
      const operations = await this.repository.listOperations(
        candidate.staging_validated_train_id,
        ctx
      );
      const exactMemberships = memberships.filter(
        (membership) =>
          membership.candidate_id === candidate.id &&
          membership.disposition === 'INCLUDED'
      );
      if (
        !train ||
        train.lane !== 'STAGING' ||
        train.status !== 'STAGING_VALIDATED' ||
        train.manifest_id !== manifest?.id ||
        manifest.status !== 'STAGING_VALIDATED' ||
        manifest.train_id !== train.id ||
        !manifest.e2e_run_id ||
        exactMemberships.length !== 1
      )
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          `Candidate ${candidate.id} has incomplete staging manifest evidence`
        );
      const manifestBody = parseStoredJson<{
        readonly candidates?: readonly ReleaseBusV2ManifestCandidateIdentity[];
      }>(manifest.manifest_json);
      const manifestCandidate = manifestContainsExactCandidate(
        manifestBody?.candidates ?? null,
        candidate
      );
      const matchingE2e = operations.filter(
        (operation) =>
          operation.operation_type === 'E2E_STAGING' &&
          operation.status === 'SUCCEEDED' &&
          operation.external_id === manifest.e2e_run_id
      );
      const e2e = matchingE2e.length === 1 ? matchingE2e[0] : null;
      const repositoryArtifact =
        candidate.repository === 'frontend'
          ? manifest.frontend_artifact_digest
          : manifest.backend_artifact_digest;
      if (!manifestCandidate || !e2e || !repositoryArtifact)
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          `Candidate ${candidate.id} staging evidence is missing exact E2E or artifact identity`
        );
      evidence.push({
        candidate_id: candidate.id,
        repository: candidate.repository,
        pr_number: candidate.pr_number,
        head_sha: candidate.head_sha,
        staging_train_id: train.id,
        staging_manifest_id: manifest.id,
        staging_manifest_identity_sha256: manifest.identity_sha256,
        staging_e2e_operation_id: e2e.id,
        staging_e2e_run_id: manifest.e2e_run_id
      });
    }
    return evidence.sort((left, right) =>
      left.candidate_id.localeCompare(right.candidate_id)
    );
  }

  private async assertProductionDependencyClosure(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    ctx: RequestContext,
    lockedCandidates?: ReadonlyMap<string, ReleaseBusV2CandidateRecord | null>
  ): Promise<void> {
    const selected = new Set(candidates.map(({ id }) => id));
    const dependencies = await this.repository.listDependencies(
      Array.from(selected),
      ctx
    );
    for (const dependency of dependencies) {
      if (
        dependency.environment === 'STAGING' ||
        selected.has(dependency.prerequisite_candidate_id)
      )
        continue;
      const prerequisite = lockedCandidates?.has(
        dependency.prerequisite_candidate_id
      )
        ? (lockedCandidates.get(dependency.prerequisite_candidate_id) ?? null)
        : await this.repository.findCandidateById(
            dependency.prerequisite_candidate_id,
            ctx
          );
      if (
        !prerequisite ||
        !(await this.hasExactProductionDeploymentEvidence(prerequisite, ctx))
      )
        throw new ReleaseBusV2ProductionSelectionError(
          'CONFLICT',
          `Production selection omits undeployed dependency ${dependency.prerequisite_candidate_id}`
        );
    }
  }

  private async hasExactProductionDeploymentEvidence(
    candidate: ReleaseBusV2CandidateRecord,
    ctx: RequestContext
  ): Promise<boolean> {
    if (
      candidate.status !== 'PRODUCTION_DEPLOYED' ||
      candidate.superseded_at !== null
    )
      return false;
    return this.hasExactProductionDeploymentManifestEvidence(candidate, ctx);
  }

  private async hasExactProductionDeploymentManifestEvidence(
    candidate: ReleaseBusV2CandidateRecord,
    ctx: RequestContext
  ): Promise<boolean> {
    if (candidate.superseded_at !== null) return false;
    const manifests = await this.repository.listProductionManifestsForCandidate(
      candidate.id,
      ctx
    );
    for (const manifest of manifests) {
      const body = parseStoredJson<{
        readonly candidates?: readonly ReleaseBusV2ManifestCandidateIdentity[];
        readonly operations?: readonly {
          readonly type?: string;
          readonly workflow_run_id?: string | null;
        }[];
      }>(manifest.manifest_json);
      const exactCandidate = manifestContainsExactCandidate(
        body?.candidates ?? null,
        candidate
      );
      const recordedE2eOperations = body?.operations?.filter(
        (operation) =>
          operation.type === 'E2E_PROD' && Boolean(operation.workflow_run_id)
      );
      const recordedE2eRunId =
        recordedE2eOperations?.length === 1
          ? recordedE2eOperations[0]?.workflow_run_id
          : null;
      if (!exactCandidate || !recordedE2eRunId) continue;
      const operations = await this.repository.listOperations(
        manifest.train_id,
        ctx
      );
      const matchingE2e = operations.filter(
        (operation) =>
          operation.operation_type === 'E2E_PROD' &&
          operation.status === 'SUCCEEDED' &&
          operation.external_id === recordedE2eRunId
      );
      if (matchingE2e.length === 1) return true;
    }
    return false;
  }

  public async repairTerminalCumulativeCarryForwardStatuses(
    actor: string
  ): Promise<readonly ReleaseBusV2CandidateRecord[]> {
    // Each repaired row leaves STAGING_BUILDING, so later ticks deterministically
    // drain any backlog beyond this bounded transaction batch.
    const stuck = await this.repository.listCandidates(
      ['STAGING_BUILDING'],
      500,
      {}
    );
    const repaired: ReleaseBusV2CandidateRecord[] = [];
    for (const candidate of stuck) {
      const result = await this.repository.executeNativeQueriesInTransaction(
        async (connection): Promise<ReleaseBusV2CandidateRecord | null> => {
          const ctx: RequestContext = { connection };
          const current = await this.repository.findCandidateById(
            candidate.id,
            ctx,
            true
          );
          if (
            !current ||
            current.status !== 'STAGING_BUILDING' ||
            current.current_train_id === null
          )
            return null;
          const train = await this.repository.findTrain(
            current.current_train_id,
            ctx
          );
          if (
            !train ||
            train.lane !== 'STAGING' ||
            train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1' ||
            !TERMINAL_TRAIN_STATUSES.has(train.status)
          )
            return null;
          const isCarryForwardMember = (
            await this.repository.listTrainCandidates(train.id, ctx)
          ).some(
            (item) =>
              item.candidate_id === current.id &&
              item.candidate_role === 'CARRY_FORWARD' &&
              item.disposition === 'INCLUDED'
          );
          if (!isCarryForwardMember) return null;

          const hasProductionDeployment =
            await this.hasExactProductionDeploymentManifestEvidence(
              current,
              ctx
            );
          const hasHistoricalStagingCertification =
            current.superseded_at === null &&
            current.staging_validated_train_id !== null &&
            current.staging_validated_manifest_id !== null;
          if (!hasProductionDeployment && !hasHistoricalStagingCertification)
            return null;
          const restoredStatus = restoredCarryForwardStatus(
            current,
            hasProductionDeployment
          );
          if (
            !(await this.repository.updateCandidate(
              current.id,
              current.row_version,
              {
                status: restoredStatus,
                currentTrainId: null,
                holdReason: null
              },
              ctx
            ))
          )
            throw new Error('Candidate changed concurrently');
          await this.repository.appendEvent(
            {
              trainId: train.id,
              candidateId: current.id,
              eventType: 'TERMINAL_CUMULATIVE_CARRY_FORWARD_STATUS_REPAIRED',
              actor,
              payload: {
                head_sha: current.head_sha,
                incorrect_status: current.status,
                restored_status: restoredStatus,
                staging_validated_train_id: current.staging_validated_train_id,
                staging_validated_manifest_id:
                  current.staging_validated_manifest_id,
                staging_live_state: current.staging_live_state ?? null,
                staging_live_manifest_id:
                  current.staging_live_manifest_id ?? null,
                production_selection_id:
                  current.production_selection_id ?? null,
                exact_production_deployment_evidence: hasProductionDeployment,
                historical_staging_certification:
                  hasHistoricalStagingCertification
              }
            },
            ctx
          );
          return {
            ...current,
            status: restoredStatus,
            current_train_id: null,
            hold_reason: null,
            row_version: current.row_version + 1
          };
        }
      );
      if (result) repaired.push(result);
    }
    // GitHub status is advisory after the durable repair. A transient publish
    // failure must not abort the reconciler tick after the database committed.
    await Promise.allSettled(
      repaired.map((candidate) => {
        const published = candidateRegistrationStatus(candidate);
        return releaseBusGitHubApp.ensureCommitStatus(
          candidate.repository,
          candidate.head_sha,
          published.state,
          published.description,
          'Release Bus v2'
        );
      })
    );
    return repaired;
  }

  public async repairCurrentStagingManifestCandidates(
    identities: readonly ReleaseBusV2CurrentStagingRepairIdentity[] | null,
    actor: string,
    dryRun = false
  ): Promise<ReleaseBusV2CurrentStagingRepairResult> {
    if ((!dryRun && !identities) || (identities?.length ?? 0) > 100)
      throw new ReleaseBusV2CurrentStagingRepairError(
        'BAD_REQUEST',
        'Current staging repair execution requires between 1 and 100 exact candidates'
      );
    if (identities && identities.length === 0)
      throw new ReleaseBusV2CurrentStagingRepairError(
        'BAD_REQUEST',
        'Current staging repair candidate selection may not be empty'
      );
    const identityKeys = (identities ?? []).map(
      ({ repository, pr_number, head_sha }) =>
        `${repository}:${pr_number}:${head_sha}`
    );
    if (
      new Set(identityKeys).size !== (identities?.length ?? 0) ||
      (identities ?? []).some(
        ({ repository, pr_number, head_sha }) =>
          !['frontend', 'backend'].includes(repository) ||
          !Number.isSafeInteger(pr_number) ||
          pr_number < 1 ||
          !/^[a-f0-9]{40}$/.test(head_sha)
      )
    )
      throw new ReleaseBusV2CurrentStagingRepairError(
        'BAD_REQUEST',
        'Current staging repair identities must be unique exact repository/PR/head tuples'
      );
    if (!dryRun && getReleaseBusV2Mode() === 'OFF')
      throw new ReleaseBusV2CurrentStagingRepairError(
        'DISABLED',
        'Current staging repair execution is disabled while Release Bus v2 is OFF'
      );
    const leaseOwner = `current-staging-repair:${actor}:${randomUUID()}`;
    const result = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        let schedulerLeaseToken: string | null = null;
        let stagingLeaseToken: string | null = null;
        let productionLeaseToken: string | null = null;
        try {
          if (dryRun) {
            const activeLocks = (await this.repository.listLocks(ctx, true))
              .filter(({ name }) =>
                [
                  'scheduler',
                  'staging-environment',
                  'production-environment'
                ].includes(name)
              )
              .filter(
                ({ lease_token, expires_at }) =>
                  lease_token && Number(expires_at) >= Date.now()
              );
            if (activeLocks.length > 0)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'CONFLICT',
                `Current staging repair dry-run requires idle release locks: ${activeLocks.map(({ name }) => name).join(',')}`
              );
          } else {
            const scheduler = await this.repository.acquireLock(
              'scheduler',
              null,
              leaseOwner,
              RELEASE_BUS_V2_LOCK_TTL_MS,
              ctx
            );
            if (!scheduler?.lease_token)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'CONFLICT',
                'Current staging repair requires an idle scheduler lock'
              );
            schedulerLeaseToken = scheduler.lease_token;
            const stagingLease = await this.repository.acquireLock(
              'staging-environment',
              null,
              leaseOwner,
              RELEASE_BUS_V2_LOCK_TTL_MS,
              ctx
            );
            if (!stagingLease?.lease_token)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'CONFLICT',
                'Current staging repair requires a free staging environment lock'
              );
            stagingLeaseToken = stagingLease.lease_token;
            const productionLease = await this.repository.acquireLock(
              'production-environment',
              null,
              leaseOwner,
              RELEASE_BUS_V2_LOCK_TTL_MS,
              ctx
            );
            if (!productionLease?.lease_token)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'CONFLICT',
                'Current staging repair requires a free production environment lock'
              );
            productionLeaseToken = productionLease.lease_token;
          }
          const active = await this.repository.listActiveTrains(ctx, true);
          if (active.length > 0)
            throw new ReleaseBusV2CurrentStagingRepairError(
              'CONFLICT',
              'Current staging repair requires every release train to be terminal'
            );
          const state = await this.repository.getStagingState(ctx, true);
          if (
            state.status !== 'LIVE' ||
            !state.current_manifest_id ||
            state.current_manifest_id !== state.last_validated_manifest_id ||
            !state.last_transition_train_id
          )
            throw new ReleaseBusV2CurrentStagingRepairError(
              'UNPROCESSABLE',
              'Authoritative current staging state is not one unambiguous validated live manifest'
            );
          const manifest = await this.repository.findManifest(
            state.current_manifest_id,
            ctx
          );
          const train = await this.repository.findTrain(
            state.last_transition_train_id,
            ctx
          );
          if (
            !manifest ||
            manifest.id !== state.current_manifest_id ||
            manifest.train_id !== state.last_transition_train_id ||
            manifest.lane !== 'STAGING' ||
            manifest.status !== 'STAGING_VALIDATED' ||
            manifest.validated_at === null ||
            !manifest.e2e_run_id ||
            manifest.frontend_sha !== state.frontend_sha ||
            manifest.backend_sha !== state.backend_sha ||
            !train ||
            train.lane !== 'STAGING' ||
            train.status !== 'STAGING_VALIDATED' ||
            train.manifest_id !== manifest.id
          )
            throw new ReleaseBusV2CurrentStagingRepairError(
              'UNPROCESSABLE',
              'Authoritative current staging manifest has incomplete validation evidence'
            );
          const operations = await this.repository.listOperations(
            train.id,
            ctx
          );
          const matchingE2e = operations.filter(
            (operation) =>
              operation.operation_type === 'E2E_STAGING' &&
              operation.status === 'SUCCEEDED' &&
              operation.external_id === manifest.e2e_run_id
          );
          if (matchingE2e.length !== 1)
            throw new ReleaseBusV2CurrentStagingRepairError(
              'UNPROCESSABLE',
              'Authoritative current staging manifest has ambiguous E2E evidence'
            );
          const body = parseStoredJson<{
            readonly candidates?: readonly ReleaseBusV2ManifestCandidateIdentity[];
          }>(manifest.manifest_json);
          const manifestCandidates = body?.candidates;
          if (
            !Array.isArray(manifestCandidates) ||
            manifestCandidates.length === 0 ||
            manifestCandidates.some(
              ({ repository, pr_number, head_sha, candidate_id }) =>
                !['frontend', 'backend'].includes(repository ?? '') ||
                !Number.isSafeInteger(pr_number) ||
                Number(pr_number) < 1 ||
                !/^[a-f0-9]{40}$/.test(head_sha ?? '') ||
                (candidate_id !== undefined &&
                  (typeof candidate_id !== 'string' ||
                    candidate_id.length === 0))
            )
          )
            throw new ReleaseBusV2CurrentStagingRepairError(
              'UNPROCESSABLE',
              'Authoritative current staging manifest candidate identities are malformed'
            );
          const manifestIdentityKeys = manifestCandidates.map(
            ({ repository, pr_number, head_sha }) =>
              `${repository}:${pr_number}:${head_sha}`
          );
          const manifestCandidateIds = manifestCandidates
            .map(({ candidate_id }) => candidate_id)
            .filter((id): id is string => id !== undefined);
          if (
            new Set(manifestIdentityKeys).size !==
              manifestIdentityKeys.length ||
            new Set(manifestCandidateIds).size !== manifestCandidateIds.length
          )
            throw new ReleaseBusV2CurrentStagingRepairError(
              'UNPROCESSABLE',
              'Authoritative current staging manifest candidate identities are ambiguous'
            );
          const selectedIdentities =
            identities ??
            manifestCandidates.map(({ repository, pr_number, head_sha }) => ({
              repository: repository as ReleaseBusV2Repository,
              pr_number: pr_number as number,
              head_sha: head_sha as string
            }));
          const memberships = await this.repository.listTrainCandidates(
            train.id,
            ctx
          );
          const repaired: Array<{
            readonly candidate_id: string;
            readonly repository: ReleaseBusV2Repository;
            readonly pr_number: number;
            readonly head_sha: string;
            readonly previous_status: ReleaseBusV2CandidateStatus;
            readonly previous_staging_live_state: string | null;
            readonly derived_status: 'STAGING_VALIDATED';
            readonly derived_staging_live_state: 'LIVE';
            readonly would_change: boolean;
            readonly changed: boolean;
          }> = [];
          for (const identity of selectedIdentities) {
            const found = await this.repository.findCandidateByIdentity(
              identity.repository,
              identity.pr_number,
              identity.head_sha,
              ctx
            );
            if (!found)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'NOT_FOUND',
                `Candidate ${identity.repository}#${identity.pr_number}@${identity.head_sha} was not found`
              );
            const candidate = found
              ? await this.repository.findCandidateById(found.id, ctx, true)
              : null;
            const exactMemberships = candidate
              ? memberships.filter(
                  (membership) =>
                    membership.candidate_id === candidate.id &&
                    membership.disposition === 'INCLUDED'
                )
              : [];
            const hasExactEvidence = Boolean(
              candidate &&
              candidate.repository === identity.repository &&
              candidate.pr_number === identity.pr_number &&
              candidate.head_sha === identity.head_sha &&
              manifestContainsExactCandidate(manifestCandidates, candidate) &&
              exactMemberships.length === 1 &&
              candidate.current_train_id === null &&
              (candidate.repository === 'frontend'
                ? manifest.frontend_artifact_digest
                : manifest.backend_artifact_digest)
            );
            if (!hasExactEvidence || !candidate)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'UNPROCESSABLE',
                `Candidate ${identity.repository}#${identity.pr_number}@${identity.head_sha} is not one exact member of the authoritative current staging manifest`
              );
            const hasProductionLifecycle =
              candidate.production_requested_at !== null ||
              candidate.production_selection_id !== null ||
              [
                'READY_FOR_PRODUCTION',
                CANDIDATE_EVIDENCE_READY_STATUS,
                'WAITING_FOR_PRODUCTION_REPLAN',
                'PRODUCTION_IN_TRAIN',
                'PRODUCTION_BUILDING_OR_QUALIFYING',
                'PRODUCTION_DEPLOYING',
                'PRODUCTION_DEPLOYED'
              ].includes(candidate.status);
            if (
              identities === null &&
              hasProductionLifecycle &&
              candidate.staging_live_state === 'LIVE' &&
              candidate.staging_live_manifest_id === manifest.id
            )
              continue;
            if (hasProductionLifecycle)
              throw new ReleaseBusV2CurrentStagingRepairError(
                'UNPROCESSABLE',
                `Candidate ${identity.repository}#${identity.pr_number}@${identity.head_sha} has production lifecycle state that current staging repair may not rewrite`
              );
            const repairableStatus = [
              'FAILED',
              'SUPERSEDED',
              'STAGING_VALIDATED'
            ].includes(candidate.status);
            const wouldChange =
              candidate.status !== 'STAGING_VALIDATED' ||
              candidate.staging_live_state !== 'LIVE' ||
              candidate.staging_live_manifest_id !== manifest.id ||
              candidate.superseded_at !== null ||
              candidate.hold_reason !== null;
            if (identities === null && !wouldChange) continue;
            if (
              !repairableStatus ||
              (candidate.staging_live_state === 'LIVE' &&
                candidate.staging_live_manifest_id !== manifest.id) ||
              (!wouldChange && identities === null)
            )
              throw new ReleaseBusV2CurrentStagingRepairError(
                'UNPROCESSABLE',
                `Candidate ${identity.repository}#${identity.pr_number}@${identity.head_sha} is not one exact repairable member of the authoritative current staging manifest`
              );
            const changed = !dryRun && wouldChange;
            if (changed) {
              if (
                !(await this.repository.updateCandidate(
                  candidate.id,
                  candidate.row_version,
                  {
                    status: 'STAGING_VALIDATED',
                    currentTrainId: null,
                    stagingValidatedTrainId: train.id,
                    stagingValidatedManifestId: manifest.id,
                    stagingLiveState: 'LIVE',
                    stagingLiveManifestId: manifest.id,
                    stagingAdmittedAt:
                      candidate.staging_admitted_at ?? manifest.validated_at,
                    stagingLiveUpdatedAt: Date.now(),
                    holdReason: null,
                    supersededAt: null
                  },
                  ctx
                ))
              )
                throw new ReleaseBusV2CurrentStagingRepairError(
                  'CONFLICT',
                  'Candidate changed concurrently'
                );
              await this.repository.appendEvent(
                {
                  trainId: train.id,
                  candidateId: candidate.id,
                  eventType:
                    'CURRENT_STAGING_MANIFEST_CANDIDATE_STATUS_DERIVED',
                  actor,
                  payload: {
                    manifest_id: manifest.id,
                    manifest_identity_sha256: manifest.identity_sha256,
                    e2e_run_id: manifest.e2e_run_id,
                    repository: candidate.repository,
                    pr_number: candidate.pr_number,
                    head_sha: candidate.head_sha,
                    previous_status: candidate.status,
                    previous_staging_live_state:
                      candidate.staging_live_state ?? null,
                    derived_status: 'STAGING_VALIDATED',
                    derived_staging_live_state: 'LIVE',
                    dry_run: false
                  }
                },
                ctx
              );
            }
            repaired.push({
              candidate_id: candidate.id,
              repository: candidate.repository,
              pr_number: candidate.pr_number,
              head_sha: candidate.head_sha,
              previous_status: candidate.status,
              previous_staging_live_state: candidate.staging_live_state ?? null,
              derived_status: 'STAGING_VALIDATED',
              derived_staging_live_state: 'LIVE',
              would_change: wouldChange,
              changed
            });
          }
          if (!dryRun)
            await this.repository.appendEvent(
              {
                trainId: train.id,
                eventType: 'CURRENT_STAGING_MANIFEST_REPAIR_VERIFIED',
                actor,
                payload: {
                  manifest_id: manifest.id,
                  manifest_identity_sha256: manifest.identity_sha256,
                  e2e_run_id: manifest.e2e_run_id,
                  candidate_ids: repaired.map(
                    ({ candidate_id }) => candidate_id
                  ),
                  changed_candidate_ids: repaired
                    .filter(({ changed }) => changed)
                    .map(({ candidate_id }) => candidate_id)
                }
              },
              ctx
            );
          return {
            manifest_id: manifest.id,
            train_id: train.id,
            dry_run: dryRun,
            discovered: identities === null,
            candidates: repaired
          };
        } finally {
          if (productionLeaseToken)
            await this.repository.releaseLock(
              'production-environment',
              productionLeaseToken,
              ctx
            );
          if (stagingLeaseToken)
            await this.repository.releaseLock(
              'staging-environment',
              stagingLeaseToken,
              ctx
            );
          if (schedulerLeaseToken)
            await this.repository.releaseLock(
              'scheduler',
              schedulerLeaseToken,
              ctx
            );
        }
      }
    );
    const statusResults = dryRun
      ? []
      : await Promise.allSettled(
          result.candidates.map((candidate) =>
            releaseBusGitHubApp.ensureCommitStatus(
              candidate.repository,
              candidate.head_sha,
              'success',
              'Exact current staging manifest validated; production is explicit',
              'Release Bus v2'
            )
          )
        );
    const failedCandidates = result.candidates.filter(
      (_candidate, index) => statusResults[index]?.status === 'rejected'
    );
    return {
      ...result,
      github_status_updates: {
        attempted: statusResults.length,
        succeeded: statusResults.length - failedCandidates.length,
        failed: failedCandidates.length,
        newly_derived: dryRun
          ? 0
          : result.candidates.filter(({ changed }) => changed).length,
        reasserted: dryRun
          ? 0
          : result.candidates.filter(({ changed }) => !changed).length,
        failed_candidates: failedCandidates.map(
          ({ candidate_id, repository, pr_number, head_sha }) => ({
            candidate_id,
            repository,
            pr_number,
            head_sha
          })
        )
      }
    };
  }

  public async revokeProductionReadiness(
    candidateId: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Candidate not found');
        if (candidate.row_version !== expectedRowVersion)
          throw new Error(
            'Candidate changed; refresh before revoking readiness'
          );
        if (
          ![
            'READY_FOR_PRODUCTION',
            CANDIDATE_EVIDENCE_READY_STATUS,
            'WAITING_FOR_PRODUCTION_REPLAN'
          ].includes(candidate.status)
        )
          throw new Error(
            'Production readiness can be revoked only before claim'
          );
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: 'STAGING_VALIDATED',
              productionRequestedAt: null,
              productionRequestedBy: null,
              productionSelectionId: null
            },
            ctx
          ))
        )
          throw new Error('Candidate changed concurrently');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: 'CANDIDATE_PRODUCTION_READINESS_REVOKED',
            actor
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after readiness revocation');
        return updated;
      }
    );
  }

  public async cancel(
    candidateId: string,
    expectedRowVersion: number,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord> {
    const cancelled = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        if (!candidate) throw new Error('Candidate not found');
        if (candidate.row_version !== expectedRowVersion)
          throw new Error('Candidate changed; refresh before cancelling');
        if (
          ![
            'READY_FOR_STAGING',
            'WAITING_FOR_DEPENDENCY',
            'READY_FOR_PRODUCTION',
            CANDIDATE_EVIDENCE_READY_STATUS,
            'WAITING_FOR_PRODUCTION_REPLAN',
            'NEEDS_REBASE'
          ].includes(candidate.status)
        )
          throw new Error('Candidate can no longer be cancelled safely');
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            { status: 'CANCELLED' },
            ctx
          ))
        )
          throw new Error('Candidate changed concurrently');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType: 'CANDIDATE_CANCELLED',
            actor
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Candidate disappeared after cancellation');
        return updated;
      }
    );
    await releaseBusGitHubApp.ensureCommitStatus(
      cancelled.repository,
      cancelled.head_sha,
      'success',
      'v2 readiness cancelled',
      'Release Bus v2'
    );
    return cancelled;
  }

  public async invalidateBranch(
    repository: ReleaseBusV2Repository,
    branchName: string,
    currentHeadSha: string,
    actor: string,
    expectedCurrentTrainId?: string
  ): Promise<void> {
    const superseded = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const changed = await this.repository.supersedeMovedBranchHeads(
          repository,
          branchName,
          currentHeadSha,
          ctx,
          expectedCurrentTrainId
        );
        for (const candidate of changed)
          await this.repository.appendEvent(
            {
              candidateId: candidate.id,
              eventType: 'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE',
              actor,
              payload: {
                previous_head_sha: candidate.head_sha,
                current_head_sha: currentHeadSha
              }
            },
            ctx
          );
        return changed;
      }
    );
    await Promise.all(
      superseded.map((candidate) =>
        releaseBusGitHubApp.ensureCommitStatus(
          candidate.repository,
          candidate.head_sha,
          'success',
          'Superseded because the exact branch head moved',
          'Release Bus v2'
        )
      )
    );
  }

  public async restoreProductionReadinessAfterBranchCleanup(
    candidateId: string,
    actor: string
  ): Promise<ReleaseBusV2CandidateRecord | null> {
    const restored = await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          candidateId,
          ctx,
          true
        );
        const supersededEvent = candidate
          ? (
              await this.repository.listCandidateEvents(
                candidate.id,
                'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE',
                1,
                ctx
              )
            )[0]
          : null;
        let supersededPayload: Record<string, unknown> | null = null;
        if (supersededEvent) {
          try {
            const value =
              typeof supersededEvent.payload_json === 'string'
                ? JSON.parse(supersededEvent.payload_json)
                : supersededEvent.payload_json;
            if (
              typeof value === 'object' &&
              value !== null &&
              !Array.isArray(value)
            )
              supersededPayload = value as Record<string, unknown>;
          } catch {
            supersededPayload = null;
          }
        }
        if (
          !candidate ||
          candidate.status !== 'SUPERSEDED' ||
          candidate.current_train_id !== null ||
          candidate.production_requested_at === null ||
          candidate.staging_validated_manifest_id === null ||
          supersededEvent?.event_type !==
            'CANDIDATE_SUPERSEDED_BY_BRANCH_MOVE' ||
          supersededPayload?.current_head_sha !== 'deleted'
        )
          return null;
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: candidate.production_selection_id
                ? CANDIDATE_EVIDENCE_READY_STATUS
                : 'READY_FOR_PRODUCTION',
              supersededAt: null
            },
            ctx
          ))
        )
          throw new Error('Candidate changed during branch cleanup repair');
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType:
              'CANDIDATE_PRODUCTION_READINESS_RESTORED_AFTER_BRANCH_CLEANUP',
            actor,
            payload: {
              head_sha: candidate.head_sha,
              staging_manifest_id: candidate.staging_validated_manifest_id
            }
          },
          ctx
        );
        return this.repository.findCandidateById(candidate.id, ctx);
      }
    );
    if (restored)
      await releaseBusGitHubApp.ensureCommitStatus(
        restored.repository,
        restored.head_sha,
        'pending',
        'Exact production readiness retained after merged branch cleanup',
        'Release Bus v2'
      );
    return restored;
  }

  public async requestStagingTransition(input: {
    readonly candidateId: string;
    readonly expectedHeadSha: string;
    readonly expectedRowVersion: number;
    readonly transition: 'REMOVE' | 'ABSORB';
    readonly reason: string;
    readonly actor: string;
  }): Promise<ReleaseBusV2CandidateRecord> {
    if (input.reason.trim().length < 3)
      throw new ReleaseBusV2StagingTransitionConflictError(
        'Staging removal requires an audited reason'
      );
    if (input.transition === 'ABSORB') {
      const candidate = await this.repository.findCandidateById(
        input.candidateId,
        {}
      );
      if (!candidate || candidate.head_sha !== input.expectedHeadSha)
        throw new ReleaseBusV2StagingTransitionConflictError(
          'Candidate identity changed before absorption'
        );
      if (
        !(await releaseBusGitHubApp.refContainsCommit(
          candidate.repository,
          'main',
          candidate.head_sha
        ))
      )
        throw new ReleaseBusV2StagingTransitionConflictError(
          'Candidate exact SHA is not safely absorbed into current main'
        );
    }
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const candidate = await this.repository.findCandidateById(
          input.candidateId,
          ctx,
          true
        );
        if (
          !candidate ||
          candidate.head_sha !== input.expectedHeadSha ||
          candidate.row_version !== input.expectedRowVersion
        )
          throw new ReleaseBusV2StagingTransitionConflictError(
            'Candidate identity or version changed'
          );
        if (candidate.staging_live_state !== 'LIVE')
          throw new ReleaseBusV2StagingTransitionConflictError(
            'Only an exact candidate currently live in staging can leave the admitted set'
          );
        if (candidate.staging_transition_request)
          throw new ReleaseBusV2StagingTransitionConflictError(
            'Candidate already has a staging lifecycle request'
          );
        const live = await this.repository.listLiveStagingCandidates(ctx, true);
        const dependencies = await this.repository.listDependencies(
          live.map(({ id }) => id),
          ctx
        );
        const dependent = dependencies.find(
          ({ prerequisite_candidate_id, candidate_id, environment }) =>
            prerequisite_candidate_id === candidate.id &&
            ['STAGING', 'BOTH'].includes(environment) &&
            live.some(
              (item) =>
                item.id === candidate_id && !item.staging_transition_request
            )
        );
        if (dependent)
          throw new ReleaseBusV2StagingTransitionConflictError(
            `Candidate ${dependent.candidate_id} still requires this exact staging candidate`
          );
        if (
          !(await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: candidate.status,
              stagingTransitionRequest: input.transition,
              stagingTransitionRequestedAt: Date.now(),
              stagingTransitionRequestedBy: input.actor,
              stagingTransitionReason: input.reason.trim()
            },
            ctx
          ))
        )
          throw new ReleaseBusV2StagingTransitionConflictError(
            'Candidate changed during staging lifecycle request'
          );
        await this.repository.appendEvent(
          {
            candidateId: candidate.id,
            eventType:
              input.transition === 'ABSORB'
                ? 'STAGING_ABSORPTION_REQUESTED'
                : 'STAGING_REMOVAL_REQUESTED',
            actor: input.actor,
            payload: {
              head_sha: candidate.head_sha,
              current_live_manifest_id: candidate.staging_live_manifest_id,
              reason: input.reason.trim(),
              production_evidence_preserved: true
            }
          },
          ctx
        );
        const updated = await this.repository.findCandidateById(
          candidate.id,
          ctx
        );
        if (!updated)
          throw new Error('Staging lifecycle request was not visible');
        return updated;
      }
    );
  }

  private async bootstrapCumulativeStagingState(
    state: Awaited<ReturnType<ReleaseBusV2RepositoryClass['getStagingState']>>,
    stagingIdentity: ReleaseBusV2StagingIdentity | undefined,
    frontendBaseSha: string,
    backendBaseSha: string,
    ctx: RequestContext
  ): Promise<Awaited<
    ReturnType<ReleaseBusV2RepositoryClass['getStagingState']>
  > | null> {
    if (state.status !== 'UNINITIALIZED') return state;
    const frontendSha = stagingIdentity?.frontendSha;
    const backendSha = stagingIdentity?.backendSha;
    if (!frontendSha || !backendSha) return null;
    if (
      frontendSha === frontendBaseSha &&
      backendSha === backendBaseSha &&
      (await this.repository.listLiveStagingCandidates(ctx, true)).length === 0
    ) {
      if (
        !(await this.repository.updateStagingState(
          state.row_version,
          {
            status: 'CLEAN_MAIN',
            currentManifestId: null,
            lastValidatedManifestId: null,
            frontendSha,
            backendSha,
            frontendStagingRefSha: frontendSha,
            backendStagingRefSha: backendSha,
            cleanMain: true,
            lastTransitionTrainId: null
          },
          ctx
        ))
      )
        throw new Error(
          'Authoritative staging state changed during clean-main bootstrap'
        );
      await this.repository.appendEvent(
        {
          eventType: 'CUMULATIVE_STAGING_STATE_BOOTSTRAPPED_FROM_CLEAN_MAIN',
          actor: 'release-bus-v2',
          payload: {
            frontend_sha: frontendSha,
            backend_sha: backendSha,
            current_manifest_id: null,
            admitted_candidate_ids: [],
            staging_validation_created: false
          }
        },
        ctx
      );
      return this.repository.getStagingState(ctx, true);
    }
    const manifest = await this.repository.findStagingValidatedManifestByShas(
      frontendSha,
      backendSha,
      ctx
    );
    if (!manifest?.e2e_run_id) return null;
    const operations = await this.repository.listOperations(
      manifest.train_id,
      ctx
    );
    if (
      !operations.some(
        ({ operation_type, status, external_id }) =>
          operation_type === 'E2E_STAGING' &&
          status === 'SUCCEEDED' &&
          external_id === manifest.e2e_run_id
      )
    )
      return null;
    const body = parseStoredJson<{
      candidates?: ReadonlyArray<{
        candidate_id?: unknown;
        repository?: unknown;
        pr_number?: unknown;
        head_sha?: unknown;
      }>;
    }>(manifest.manifest_json);
    if (!Array.isArray(body?.candidates) || body.candidates.length === 0)
      return null;
    const identities = new Set<string>();
    const candidates: ReleaseBusV2CandidateRecord[] = [];
    for (const entry of body.candidates) {
      if (
        !['frontend', 'backend'].includes(String(entry.repository)) ||
        !Number.isInteger(entry.pr_number) ||
        Number(entry.pr_number) <= 0 ||
        typeof entry.head_sha !== 'string' ||
        !/^[a-f0-9]{40}$/.test(entry.head_sha)
      )
        return null;
      const key = `${entry.repository}:${entry.pr_number}:${entry.head_sha}`;
      if (identities.has(key)) return null;
      identities.add(key);
      const candidate = await this.repository.findCandidateByIdentity(
        entry.repository as ReleaseBusV2Repository,
        Number(entry.pr_number),
        entry.head_sha,
        ctx
      );
      if (
        !candidate ||
        (entry.candidate_id !== undefined &&
          entry.candidate_id !== candidate.id) ||
        candidate.staging_validated_train_id !== manifest.train_id ||
        candidate.staging_validated_manifest_id !== manifest.id
      )
        return null;
      candidates.push(candidate);
    }
    await this.repository.commitValidatedStaging(
      {
        trainId: manifest.train_id,
        expectedStateVersion: state.row_version,
        manifestId: manifest.id,
        frontendSha,
        backendSha,
        frontendStagingRefSha: frontendSha,
        backendStagingRefSha: backendSha,
        admittedCandidateIds: candidates.map(({ id }) => id),
        removedCandidateIds: [],
        newCandidateIds: []
      },
      ctx
    );
    await this.repository.appendEvent(
      {
        trainId: manifest.train_id,
        eventType:
          'CUMULATIVE_STAGING_STATE_BOOTSTRAPPED_FROM_VALIDATED_MANIFEST',
        actor: 'release-bus-v2',
        payload: {
          manifest_id: manifest.id,
          frontend_sha: frontendSha,
          backend_sha: backendSha,
          e2e_run_id: manifest.e2e_run_id,
          admitted_candidate_ids: candidates.map(({ id }) => id)
        }
      },
      ctx
    );
    return this.repository.getStagingState(ctx, true);
  }

  private productionReplanIrreversibleReason(
    train: ReleaseBusV2TrainRecord,
    operations: readonly ReleaseBusV2OperationRecord[]
  ): string | null {
    if (train.status === 'PRODUCTION_DEPLOYING')
      return 'the train entered PRODUCTION_DEPLOYING';
    return (
      operations
        .map(irreversibleProductionOperationReason)
        .find((reason): reason is string => reason !== null) ?? null
    );
  }

  private async freezeProductionReplan(
    train: ReleaseBusV2TrainRecord,
    operations: readonly ReleaseBusV2OperationRecord[],
    irreversibleReason: string,
    input: ProductionReplanRequest,
    ctx: RequestContext
  ): Promise<ReleaseBusV2SafeProductionReplanResult> {
    const reason = `Safe production replan refused because ${irreversibleReason}; the original exact candidate set remains frozen`;
    const runningOperationIds = operations
      .filter(productionReplanOperationMayStillBeRunning)
      .map(({ id }) => id);
    const lockDisposition =
      runningOperationIds.length > 0
        ? 'RETAINED_WHILE_DISPATCHED_WORK_DRAINS'
        : 'RELEASED_OR_ALREADY_FREE_AFTER_TERMINAL_WORK';
    if (
      !(await this.repository.updateTrain(
        train.id,
        train.row_version,
        {
          status: 'PAUSED',
          failureClass: 'INTERACTION',
          failureMessage: input.reason,
          recoveryMessage: `${reason}. Resume or recover only this train's immutable membership; production environment ownership is ${lockDisposition.toLowerCase().split('_').join(' ')}`
        },
        ctx
      ))
    )
      throw new Error(
        'Release Bus v2 train changed during irreversible replan fence'
      );
    if (runningOperationIds.length === 0)
      await this.releaseProductionReplanEnvironmentLock(train.id, ctx);
    await this.repository.appendEvent(
      {
        trainId: train.id,
        eventType: 'PRODUCTION_REPLAN_REJECTED_AFTER_IRREVERSIBLE_MUTATION',
        actor: input.actor,
        payload: {
          reason,
          source_train_id: train.id,
          operation_ids: operations.map(({ id }) => id),
          running_operation_ids: runningOperationIds,
          production_environment_lock: lockDisposition
        }
      },
      ctx
    );
    return {
      status: 'FROZEN',
      trainId: train.id,
      reason
    };
  }

  private async cancelPendingProductionReplanOperations(
    operations: readonly ReleaseBusV2OperationRecord[],
    reason: string,
    ctx: RequestContext
  ): Promise<void> {
    for (const operation of operations) {
      if (TERMINAL_OPERATION_STATUSES.has(operation.status)) continue;
      if (
        !(await this.repository.updateOperation(
          operation.id,
          operation.row_version,
          {
            status: 'CANCELLED',
            failureClass: 'INTERACTION',
            failureMessage: reason,
            completedAt: Date.now()
          },
          ctx
        ))
      )
        throw new Error(
          'Release Bus v2 operation changed during safe production replan'
        );
    }
  }

  private async lockBoundProductionReplanCandidates(
    train: ReleaseBusV2TrainRecord,
    ctx: RequestContext
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const memberships = (
      await this.repository.listTrainCandidates(train.id, ctx)
    )
      .filter(({ disposition }) => disposition === 'INCLUDED')
      .sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.candidate_id.localeCompare(right.candidate_id)
      );
    if (memberships.length === 0)
      throw new Error(
        `Production replan source train ${train.id} has no included candidates`
      );
    const candidates: ReleaseBusV2CandidateRecord[] = [];
    for (const membership of memberships) {
      const candidate = await this.repository.findCandidateById(
        membership.candidate_id,
        ctx,
        true
      );
      if (!candidate)
        throw new Error(
          `Production replan lost candidate ${membership.candidate_id}`
        );
      if (
        candidate.current_train_id !== train.id ||
        !PRODUCTION_REPLAN_BOUND_STATUSES.has(candidate.status) ||
        candidate.production_requested_at === null ||
        candidate.production_requested_by === null ||
        candidate.production_selection_id === null ||
        candidate.superseded_at !== null
      )
        throw new Error(
          `Candidate ${candidate.id} is not safely bound to the exact production intent being replanned`
        );
      candidates.push(candidate);
    }
    return candidates;
  }

  private async holdProductionReplanCandidates(
    train: ReleaseBusV2TrainRecord,
    candidates: readonly ReleaseBusV2CandidateRecord[],
    input: ProductionReplanRequest,
    ctx: RequestContext
  ): Promise<void> {
    const holdReason = `Production train ${train.id} was safely cancelled before irreversible mutation; explicit intent is preserved for a current-base replacement`;
    for (const candidate of candidates) {
      if (
        !(await this.repository.updateCandidate(
          candidate.id,
          candidate.row_version,
          {
            status: 'WAITING_FOR_PRODUCTION_REPLAN',
            currentTrainId: null,
            holdReason
          },
          ctx
        ))
      )
        throw new Error(
          `Candidate ${candidate.id} changed during safe production replan`
        );
      await this.repository.appendEvent(
        {
          trainId: train.id,
          candidateId: candidate.id,
          eventType: 'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN',
          actor: input.actor,
          payload: {
            source_train_id: train.id,
            source_production_selection_id: candidate.production_selection_id,
            head_sha: candidate.head_sha,
            reason: input.reason
          }
        },
        ctx
      );
    }
  }

  private async cancelProductionReplanSourceTrain(
    train: ReleaseBusV2TrainRecord,
    candidates: readonly ReleaseBusV2CandidateRecord[],
    sourceSelections: readonly string[],
    input: ProductionReplanRequest,
    ctx: RequestContext
  ): Promise<void> {
    if (
      !(await this.repository.updateTrain(
        train.id,
        train.row_version,
        {
          status: 'CANCELLED',
          failureClass: 'INTERACTION',
          failureMessage: input.reason,
          recoveryMessage:
            'Main moved before irreversible production mutation; every exact explicit intent is preserved for a new audited current-base replacement',
          completedAt: Date.now()
        },
        ctx
      ))
    )
      throw new Error(
        'Release Bus v2 train changed during transactional production replan'
      );
    await this.repository.appendEvent(
      {
        trainId: train.id,
        eventType: 'PRODUCTION_TRAIN_INTENTS_PRESERVED_FOR_SAFE_REPLAN',
        actor: input.actor,
        payload: {
          source_train_id: train.id,
          source_production_selection_ids: sourceSelections,
          candidate_ids: candidates.map(({ id }) => id),
          reason: input.reason
        }
      },
      ctx
    );
  }

  private async releaseProductionReplanEnvironmentLock(
    trainId: string,
    ctx: RequestContext
  ): Promise<void> {
    const productionLock = (await this.repository.listLocks(ctx, true)).find(
      ({ name, owner_train_id }) =>
        name === 'production-environment' && owner_train_id === trainId
    );
    if (
      productionLock?.lease_token &&
      !(await this.repository.releaseLock(
        'production-environment',
        productionLock.lease_token,
        ctx
      ))
    )
      throw new Error(
        'Production environment ownership changed during safe replan'
      );
  }

  public async preserveProductionIntentsForSafeReplan(
    input: ProductionReplanRequest
  ): Promise<ReleaseBusV2SafeProductionReplanResult> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const scheduler = await this.repository.acquireLock(
          'scheduler',
          null,
          `production-replan:${input.trainId}`,
          RELEASE_BUS_V2_LOCK_TTL_MS,
          ctx
        );
        if (!scheduler?.lease_token)
          return {
            status: 'NOOP',
            trainId: input.trainId,
            reason:
              'The scheduler fence is owned by another transactional actor'
          };
        try {
          const train = await this.repository.findTrain(
            input.trainId,
            ctx,
            true
          );
          if (!train || TERMINAL_TRAIN_STATUSES.has(train.status))
            return {
              status: 'NOOP',
              trainId: input.trainId,
              reason: 'The production train is already terminal or missing'
            };
          if (train.lane !== 'PRODUCTION')
            throw new Error(`Train ${input.trainId} is not a production train`);
          const operations = await this.repository.listOperations(
            train.id,
            ctx,
            true
          );
          const irreversibleReason = this.productionReplanIrreversibleReason(
            train,
            operations
          );
          if (irreversibleReason)
            return this.freezeProductionReplan(
              train,
              operations,
              irreversibleReason,
              input,
              ctx
            );
          const runningOperation = operations.find(
            productionReplanOperationMayStillBeRunning
          );
          if (runningOperation)
            return {
              status: 'NOOP',
              trainId: train.id,
              reason: `Safe production replan is waiting for operation ${runningOperation.id} (${runningOperation.operation_type}) to become terminal`
            };
          await this.cancelPendingProductionReplanOperations(
            operations,
            input.reason,
            ctx
          );
          const candidates = await this.lockBoundProductionReplanCandidates(
            train,
            ctx
          );
          const sourceSelections = Array.from(
            new Set(
              candidates.map((candidate) => {
                const selectionId = candidate.production_selection_id;
                if (!selectionId)
                  throw new Error(
                    `Production replan candidate ${candidate.id} lost its explicit selection identity`
                  );
                return selectionId;
              })
            )
          ).sort((left, right) => left.localeCompare(right));
          await this.holdProductionReplanCandidates(
            train,
            candidates,
            input,
            ctx
          );
          await this.cancelProductionReplanSourceTrain(
            train,
            candidates,
            sourceSelections,
            input,
            ctx
          );
          await this.releaseProductionReplanEnvironmentLock(train.id, ctx);
          return {
            status: 'REPLANNED',
            trainId: train.id,
            candidateIds: candidates.map(({ id }) => id),
            sourceSelectionIds: sourceSelections
          };
        } finally {
          await this.repository.releaseLock(
            'scheduler',
            scheduler.lease_token,
            ctx
          );
        }
      }
    );
  }

  private async productionReplanSourceTrainId(
    candidate: ReleaseBusV2CandidateRecord,
    ctx: RequestContext
  ): Promise<string | null> {
    if (candidate.status !== 'WAITING_FOR_PRODUCTION_REPLAN') return null;
    // listCandidateEvents is explicitly newest-first by created_at and id.
    const event = (
      await this.repository.listCandidateEvents(
        candidate.id,
        'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN',
        1,
        ctx
      )
    )[0];
    return event?.train_id ?? null;
  }

  private async recordProductionReplanOmission(
    omission: ProductionReplanOmission,
    ctx: RequestContext
  ): Promise<void> {
    const current = await this.repository.findCandidateById(
      omission.candidate.id,
      ctx,
      true
    );
    if (!current)
      throw new Error(
        `Production replan omission candidate ${omission.candidate.id} disappeared`
      );
    if (
      current.production_requested_at !== null &&
      current.production_requested_by !== null &&
      current.production_selection_id !== null &&
      current.current_train_id === null &&
      current.superseded_at === null &&
      PRODUCTION_REPLAN_READY_STATUSES.has(current.status)
    ) {
      if (
        !(await this.repository.updateCandidate(
          current.id,
          current.row_version,
          {
            status: 'WAITING_FOR_PRODUCTION_REPLAN',
            currentTrainId: null,
            holdReason: omission.reason
          },
          ctx
        ))
      )
        throw new Error(
          `Candidate ${current.id} changed while preserving omitted production intent`
        );
    }
    await this.repository.appendEvent(
      {
        trainId: omission.sourceTrainId,
        candidateId: current.id,
        eventType: 'PRODUCTION_REPLAN_INTENT_OMITTED',
        actor: 'release-bus-v2',
        payload: {
          candidate_id: current.id,
          source_train_id: omission.sourceTrainId,
          source_production_selection_id: omission.sourceSelectionId,
          head_sha: current.head_sha,
          reason: omission.reason
        }
      },
      ctx
    );
  }

  private productionReplanCandidateReason(
    candidate: ReleaseBusV2CandidateRecord,
    sourceSelectionId: string | null
  ): string | null {
    if (!PRODUCTION_REPLAN_READY_STATUSES.has(candidate.status))
      return `Candidate status ${candidate.status} no longer carries claimable production intent`;
    if (candidate.current_train_id !== null)
      return `Candidate is owned by train ${candidate.current_train_id}`;
    if (
      candidate.production_requested_at === null ||
      candidate.production_requested_by === null ||
      sourceSelectionId === null
    )
      return 'Explicit production selection was revoked or is incomplete';
    if (candidate.superseded_at !== null)
      return 'Exact candidate SHA was superseded';
    return null;
  }

  private async qualifyProductionReplanCandidate(
    candidate: ReleaseBusV2CandidateRecord,
    ctx: RequestContext
  ): Promise<ProductionReplanCandidateQualification> {
    const sourceTrainId = await this.productionReplanSourceTrainId(
      candidate,
      ctx
    );
    const sourceSelectionId = candidate.production_selection_id ?? null;
    let reason = this.productionReplanCandidateReason(
      candidate,
      sourceSelectionId
    );
    if (!reason) {
      const currentHead = await releaseBusGitHubApp.resolveRefIfExists(
        candidate.repository,
        candidate.branch_name
      );
      if (currentHead !== candidate.head_sha)
        reason = `Candidate branch head changed from ${candidate.head_sha} to ${currentHead ?? 'deleted'}`;
    }
    let evidence: ReleaseBusV2CandidateStagingEvidence | null = null;
    if (!reason)
      try {
        evidence =
          (await this.resolveCandidateStagingEvidence([candidate], ctx))[0] ??
          null;
        if (!evidence)
          reason = 'Exact staging evidence resolution returned no candidate';
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'ReleaseBusV2ProductionSelectionError'
        )
          throw error;
        reason = error.message;
      }
    if (reason || sourceSelectionId === null || evidence === null)
      return {
        eligible: false,
        omission: {
          candidate,
          sourceSelectionId,
          sourceTrainId,
          reason:
            reason ??
            'Explicit production selection or exact staging evidence is missing'
        }
      };
    return {
      eligible: true,
      source: {
        candidate,
        sourceSelectionId,
        sourceTrainId
      },
      evidence
    };
  }

  private async omitProductionReplanDependencyGaps(
    preliminary: readonly ProductionReplanCandidateSource[],
    evidenceByCandidate: Map<string, ReleaseBusV2CandidateStagingEvidence>,
    omitted: ProductionReplanOmission[],
    ctx: RequestContext
  ): Promise<Map<string, ProductionReplanCandidateSource>> {
    const eligible = new Map(
      preliminary.map((source) => [source.candidate.id, source])
    );
    const dependencies = await this.repository.listDependencies(
      preliminary.map(({ candidate }) => candidate.id),
      ctx
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const dependency of dependencies) {
        const source = eligible.get(dependency.candidate_id);
        if (
          !source ||
          dependency.environment === 'STAGING' ||
          eligible.has(dependency.prerequisite_candidate_id)
        )
          continue;
        const prerequisite = await this.repository.findCandidateById(
          dependency.prerequisite_candidate_id,
          ctx,
          true
        );
        if (
          prerequisite &&
          (await this.hasExactProductionDeploymentEvidence(prerequisite, ctx))
        )
          continue;
        eligible.delete(source.candidate.id);
        evidenceByCandidate.delete(source.candidate.id);
        omitted.push({
          candidate: source.candidate,
          sourceSelectionId: source.sourceSelectionId,
          sourceTrainId: source.sourceTrainId,
          reason: `Production dependency ${dependency.prerequisite_candidate_id} is neither eligible for this replacement nor exactly deployed`
        });
        changed = true;
      }
    }
    return eligible;
  }

  private async qualifyProductionReplanIntents(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    frontendBaseSha: string,
    backendBaseSha: string,
    ctx: RequestContext
  ): Promise<{
    readonly eligible: readonly ProductionReplanCandidateSource[];
    readonly omitted: readonly ProductionReplanOmission[];
    readonly evidence: readonly ReleaseBusV2CandidateStagingEvidence[];
  }> {
    const currentBases = await Promise.all(
      (['frontend', 'backend'] as const).map(async (repository) => ({
        repository,
        sha: await releaseBusGitHubApp.resolveRef(repository, 'main')
      }))
    );
    const expectedBase = {
      frontend: frontendBaseSha,
      backend: backendBaseSha
    } as const;
    const staleBase = currentBases.find(
      ({ repository, sha }) =>
        !/^[a-f0-9]{40}$/.test(sha) || sha !== expectedBase[repository]
    );
    if (staleBase) {
      const omitted: ProductionReplanOmission[] = [];
      for (const candidate of candidates)
        omitted.push({
          candidate,
          sourceSelectionId: candidate.production_selection_id ?? null,
          sourceTrainId: await this.productionReplanSourceTrainId(
            candidate,
            ctx
          ),
          reason: `Production base fence changed for ${staleBase.repository}: expected ${expectedBase[staleBase.repository]}, observed ${staleBase.sha}`
        });
      return {
        eligible: [],
        omitted,
        evidence: []
      };
    }

    const preliminary: ProductionReplanCandidateSource[] = [];
    const omitted: ProductionReplanOmission[] = [];
    const evidenceByCandidate = new Map<
      string,
      ReleaseBusV2CandidateStagingEvidence
    >();
    for (const candidate of candidates) {
      const qualification = await this.qualifyProductionReplanCandidate(
        candidate,
        ctx
      );
      if (!qualification.eligible) {
        omitted.push(qualification.omission);
        continue;
      }
      preliminary.push(qualification.source);
      evidenceByCandidate.set(candidate.id, qualification.evidence);
    }

    const eligible = await this.omitProductionReplanDependencyGaps(
      preliminary,
      evidenceByCandidate,
      omitted,
      ctx
    );
    const ordered = preliminary.filter(({ candidate }) =>
      eligible.has(candidate.id)
    );
    return {
      eligible: ordered,
      omitted,
      evidence: ordered
        .map(({ candidate }) => evidenceByCandidate.get(candidate.id))
        .filter(
          (evidence): evidence is ReleaseBusV2CandidateStagingEvidence =>
            evidence !== undefined
        )
        .sort((left, right) =>
          left.candidate_id.localeCompare(right.candidate_id)
        )
    };
  }

  public async claimLane(
    lane: ReleaseBusV2Lane,
    frontendBaseSha: string,
    backendBaseSha: string,
    owner: string,
    stagingIdentity?: ReleaseBusV2StagingIdentity
  ): Promise<ReleaseBusV2TrainRecord | null> {
    const mode = getReleaseBusV2Mode();
    const scope = laneScope(lane);
    const betaAllowlist =
      mode === 'OFF' || (mode === 'STAGING' && lane === 'PRODUCTION')
        ? getReleaseBusV2BetaAllowlist()
        : [];
    const betaLaneEnabled = releaseBusV2BetaAllowsLaneInMode(
      mode,
      betaAllowlist,
      lane
    );
    if (!releaseBusV2AllowsLane(mode, scope) && !betaLaneEnabled) return null;
    await this.assertScopeRunning(scope);
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        const scheduler = await this.repository.acquireLock(
          'scheduler',
          null,
          owner,
          RELEASE_BUS_V2_LOCK_TTL_MS,
          ctx
        );
        if (!scheduler?.lease_token) return null;
        try {
          let stagingState =
            lane === 'STAGING' &&
            typeof this.repository.getStagingState === 'function'
              ? await this.repository.getStagingState(ctx, true)
              : null;
          const active = (await this.repository.listTrains(100, ctx)).filter(
            (train) =>
              !TERMINAL_TRAIN_STATUSES.has(train.status) && train.lane === lane
          );
          if (!betaLaneEnabled && active.length > 0) return active[0] ?? null;
          if (betaLaneEnabled) {
            for (const train of active) {
              if (await this.isBetaTrainAllowed(train, betaAllowlist, ctx))
                return train;
            }
          }
          if (stagingState?.status === 'UNINITIALIZED') {
            const bootstrapped = await this.bootstrapCumulativeStagingState(
              stagingState,
              stagingIdentity,
              frontendBaseSha,
              backendBaseSha,
              ctx
            );
            if (!bootstrapped) return null;
            stagingState = bootstrapped;
          }
          if (
            stagingState &&
            !['LIVE', 'CLEAN_MAIN'].includes(stagingState.status)
          )
            return null;
          await this.refreshDependencyHolds(lane, ctx, betaAllowlist);
          const readyCandidateScan = await this.repository.listCandidates(
            lane === 'PRODUCTION'
              ? [CANDIDATE_EVIDENCE_READY_STATUS, 'READY_FOR_PRODUCTION']
              : [readyStatus(lane)],
            lane === 'PRODUCTION'
              ? PRODUCTION_REPLAN_INTENT_SCAN_LIMIT
              : RELEASE_BUS_V2_MAX_CANDIDATES,
            ctx
          );
          const readyCandidates = readyCandidateScan.filter(
            (candidate) =>
              !betaLaneEnabled ||
              releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
          );
          const heldCandidateScan =
            lane === 'PRODUCTION'
              ? await this.repository.listCandidates(
                  ['WAITING_FOR_PRODUCTION_REPLAN'],
                  PRODUCTION_REPLAN_INTENT_SCAN_LIMIT,
                  ctx
                )
              : [];
          const heldCandidates = heldCandidateScan.filter(
            (candidate) =>
              !betaLaneEnabled ||
              releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
          );
          const stagingTransitionRequests =
            lane === 'STAGING' && stagingState
              ? await this.repository.listStagingTransitionRequests(ctx, true)
              : [];
          if (
            readyCandidates.length === 0 &&
            heldCandidates.length === 0 &&
            stagingTransitionRequests.length === 0
          )
            return null;
          const queued = [...heldCandidates, ...readyCandidates].sort(
            (left, right) =>
              Number(left.production_requested_at ?? left.created_at) -
                Number(right.production_requested_at ?? right.created_at) ||
              left.id.localeCompare(right.id)
          );
          let candidates: readonly ReleaseBusV2CandidateRecord[];
          let carriedCandidates: readonly ReleaseBusV2CandidateRecord[] = [];
          let replacedCandidates: readonly ReleaseBusV2CandidateRecord[] = [];
          let removalCandidates: readonly ReleaseBusV2CandidateRecord[] = [];
          let productionReplanSources: readonly ProductionReplanCandidateSource[] =
            [];
          let productionReplanOmissions: readonly ProductionReplanOmission[] =
            [];
          let qualificationEvidence:
            | readonly ReleaseBusV2CandidateStagingEvidence[]
            | undefined;
          let selectionId: string | null = null;
          if (lane === 'STAGING') {
            candidates = readyCandidates;
            const newCandidateIds = new Set(
              readyCandidates.map(({ id }) => id)
            );
            const live = stagingState
              ? await this.repository.listLiveStagingCandidates(ctx, true)
              : [];
            const replacements = new Set(
              candidates.map(
                ({ repository, pr_number }) => `${repository}:${pr_number}`
              )
            );
            replacedCandidates = live.filter(
              (candidate) =>
                !newCandidateIds.has(candidate.id) &&
                replacements.has(
                  `${candidate.repository}:${candidate.pr_number}`
                )
            );
            const replacedIds = new Set(replacedCandidates.map(({ id }) => id));
            if (replacedCandidates.some(({ id }) => newCandidateIds.has(id)))
              throw new Error(
                'Staging claim NEW and REPLACED candidate sets overlap'
              );
            const requestedIds = new Set(
              stagingTransitionRequests.map(({ id }) => id)
            );
            removalCandidates = live.filter((candidate) =>
              requestedIds.has(candidate.id)
            );
            for (const candidate of removalCandidates) {
              if (
                candidate.staging_transition_request === 'ABSORB' &&
                !(await releaseBusGitHubApp.refContainsCommit(
                  candidate.repository,
                  'main',
                  candidate.head_sha
                ))
              ) {
                const holdReason =
                  'Absorption blocked: exact candidate SHA is not contained in current main';
                if (candidate.hold_reason !== holdReason) {
                  if (
                    !(await this.repository.updateCandidate(
                      candidate.id,
                      candidate.row_version,
                      {
                        status: candidate.status,
                        holdReason
                      },
                      ctx
                    ))
                  )
                    throw new Error(
                      `Candidate ${candidate.id} changed while recording an absorption hold`
                    );
                  await this.repository.appendEvent(
                    {
                      candidateId: candidate.id,
                      eventType: 'STAGING_ABSORPTION_BLOCKED_MAIN_IDENTITY',
                      actor: owner,
                      payload: {
                        repository: candidate.repository,
                        pr_number: candidate.pr_number,
                        head_sha: candidate.head_sha,
                        reason: holdReason
                      }
                    },
                    ctx
                  );
                }
                return null;
              }
            }
            carriedCandidates = live.filter(
              (candidate) =>
                !newCandidateIds.has(candidate.id) &&
                !replacedIds.has(candidate.id) &&
                !requestedIds.has(candidate.id)
            );
            candidates = [...carriedCandidates, ...candidates];
          } else if (heldCandidates.length > 0) {
            if (
              readyCandidateScan.length ===
                PRODUCTION_REPLAN_INTENT_SCAN_LIMIT ||
              heldCandidateScan.length === PRODUCTION_REPLAN_INTENT_SCAN_LIMIT
            ) {
              await this.repository.appendEvent(
                {
                  eventType: 'PRODUCTION_REPLAN_INTENT_SCAN_FAILED_CLOSED',
                  actor: owner,
                  payload: {
                    reason: `Production replan intent scan reached the fail-closed limit of ${PRODUCTION_REPLAN_INTENT_SCAN_LIMIT}`,
                    ready_count: readyCandidates.length,
                    held_count: heldCandidates.length
                  }
                },
                ctx
              );
              return null;
            }
            const lockedCandidates: ReleaseBusV2CandidateRecord[] = [];
            const queuedById = [...queued].sort((left, right) =>
              left.id.localeCompare(right.id)
            );
            for (const queuedCandidate of queuedById) {
              const locked = await this.repository.findCandidateById(
                queuedCandidate.id,
                ctx,
                true
              );
              if (!locked)
                throw new Error(
                  `Production replan candidate ${queuedCandidate.id} disappeared during the scheduler fence`
                );
              lockedCandidates.push(locked);
            }
            lockedCandidates.sort(
              (left, right) =>
                Number(left.production_requested_at ?? left.created_at) -
                  Number(right.production_requested_at ?? right.created_at) ||
                left.id.localeCompare(right.id)
            );
            const replan = await this.qualifyProductionReplanIntents(
              lockedCandidates,
              frontendBaseSha,
              backendBaseSha,
              ctx
            );
            productionReplanSources = replan.eligible;
            productionReplanOmissions = replan.omitted;
            qualificationEvidence = replan.evidence;
            candidates = replan.eligible.map(({ candidate }) => candidate);
            selectionId = randomUUID();
            for (const omission of productionReplanOmissions)
              await this.recordProductionReplanOmission(omission, ctx);
            if (candidates.length === 0) {
              await this.repository.appendEvent(
                {
                  eventType: 'PRODUCTION_REPLAN_REPLACEMENT_NOT_CLAIMED',
                  actor: owner,
                  payload: {
                    replacement_production_selection_id: selectionId,
                    source_production_selection_ids: Array.from(
                      new Set(
                        productionReplanOmissions
                          .map(({ sourceSelectionId }) => sourceSelectionId)
                          .filter(
                            (sourceSelectionId): sourceSelectionId is string =>
                              sourceSelectionId !== null
                          )
                      )
                    ).sort((left, right) => left.localeCompare(right)),
                    source_train_ids: Array.from(
                      new Set(
                        productionReplanOmissions
                          .map(({ sourceTrainId }) => sourceTrainId)
                          .filter(
                            (sourceTrainId): sourceTrainId is string =>
                              sourceTrainId !== null
                          )
                      )
                    ).sort((left, right) => left.localeCompare(right)),
                    omitted_intents: productionReplanOmissions.map(
                      ({
                        candidate,
                        sourceSelectionId,
                        sourceTrainId,
                        reason
                      }) => ({
                        candidate_id: candidate.id,
                        source_production_selection_id: sourceSelectionId,
                        source_train_id: sourceTrainId,
                        reason
                      })
                    )
                  }
                },
                ctx
              );
              return null;
            }
          } else {
            const first = queued[0];
            selectionId = first?.production_selection_id ?? null;
            candidates = queued.filter((candidate) =>
              selectionId
                ? candidate.production_selection_id === selectionId
                : candidate.production_selection_id === null
            );
          }
          if (candidates.length === 0 && removalCandidates.length === 0)
            return null;
          const dependencies = await this.repository.listDependencies(
            candidates.map((candidate) => candidate.id),
            ctx
          );
          const eligible =
            lane === 'PRODUCTION' && productionReplanSources.length > 0
              ? candidates
              : await this.selectDependencyClosedCandidates(
                  candidates,
                  dependencies,
                  lane,
                  ctx,
                  betaAllowlist,
                  lane !== 'STAGING'
                );
          if (lane === 'STAGING' && eligible.length !== candidates.length) {
            const eligibleIds = new Set(eligible.map(({ id }) => id));
            for (const candidate of readyCandidates) {
              if (eligibleIds.has(candidate.id)) continue;
              await this.repository.updateCandidate(
                candidate.id,
                candidate.row_version,
                {
                  status: 'WAITING_FOR_DEPENDENCY',
                  holdReason:
                    'Cumulative staging dependency closure is incomplete'
                },
                ctx
              );
            }
            return null;
          }
          if (eligible.length === 0 && removalCandidates.length === 0)
            return null;
          if (
            lane === 'PRODUCTION' &&
            selectionId !== null &&
            eligible.length !== candidates.length
          )
            return null;
          qualificationEvidence ??=
            lane === 'PRODUCTION'
              ? await this.resolveCandidateStagingEvidence(eligible, ctx)
              : undefined;
          if (lane === 'PRODUCTION')
            await this.assertProductionDependencyClosure(eligible, ctx);
          const order = topologicalOrder(
            eligible.map((candidate) => candidate.id),
            dependencies
              .filter((dependency) =>
                eligible.some(
                  (candidate) => candidate.id === dependency.candidate_id
                )
              )
              .filter((dependency) =>
                eligible.some(
                  (candidate) =>
                    candidate.id === dependency.prerequisite_candidate_id
                )
              )
              .map(
                (dependency) =>
                  [
                    dependency.prerequisite_candidate_id,
                    dependency.candidate_id
                  ] as const
              )
          );
          const train = await this.repository.createTrain(
            {
              lane,
              frontendBaseSha,
              backendBaseSha,
              candidateIds: [
                ...order,
                ...removalCandidates.map(({ id }) => id)
              ],
              ...(lane === 'STAGING' && stagingState
                ? {
                    stagingPolicy: 'CUMULATIVE_ADMITTED_SET_V1' as const,
                    stagingBaselineManifestId: stagingState.current_manifest_id,
                    stagingTransition: {
                      actor: owner,
                      reason:
                        'Ordinary cumulative staging admission and validation',
                      requested_at: Date.now(),
                      baseline_state_version: stagingState.row_version,
                      baseline_manifest_id: stagingState.current_manifest_id,
                      baseline_frontend_sha: stagingState.frontend_sha,
                      baseline_backend_sha: stagingState.backend_sha,
                      observed_frontend_staging_sha:
                        stagingIdentity?.frontendSha ?? undefined,
                      observed_backend_staging_sha:
                        stagingIdentity?.backendSha ?? undefined,
                      new_candidate_ids: readyCandidates.map(({ id }) => id),
                      carried_candidate_ids: carriedCandidates.map(
                        ({ id }) => id
                      ),
                      replaced_candidate_ids: replacedCandidates.map(
                        ({ id }) => id
                      ),
                      removed_candidate_ids: removalCandidates
                        .filter(
                          ({ staging_transition_request }) =>
                            staging_transition_request === 'REMOVE'
                        )
                        .map(({ id }) => id),
                      absorbed_candidate_ids: removalCandidates
                        .filter(
                          ({ staging_transition_request }) =>
                            staging_transition_request === 'ABSORB'
                        )
                        .map(({ id }) => id)
                    },
                    candidateRoles: Object.fromEntries([
                      ...carriedCandidates.map(
                        ({ id }) => [id, 'CARRY_FORWARD'] as const
                      ),
                      ...readyCandidates.map(({ id }) => [id, 'NEW'] as const),
                      ...removalCandidates.map(
                        ({ id, staging_transition_request }) =>
                          [
                            id,
                            staging_transition_request === 'ABSORB'
                              ? 'ABSORPTION'
                              : 'REMOVAL'
                          ] as const
                      )
                    ]),
                    candidateDispositions: Object.fromEntries(
                      removalCandidates.map(
                        ({ id }) => [id, 'AUDIT_ONLY'] as const
                      )
                    )
                  }
                : {}),
              qualificationPolicy:
                lane === 'PRODUCTION'
                  ? CANDIDATE_STAGING_EVIDENCE_POLICY
                  : undefined,
              qualificationEvidence
            },
            ctx
          );
          const byId = new Map(
            eligible.map((candidate) => [candidate.id, candidate])
          );
          for (const candidateId of order) {
            const candidate = byId.get(candidateId);
            if (!candidate) continue;
            if (
              lane === 'STAGING' &&
              carriedCandidates.some(({ id }) => id === candidate.id)
            )
              continue;
            if (
              !(await this.repository.updateCandidate(
                candidate.id,
                candidate.row_version,
                {
                  status: claimedStatus(lane),
                  currentTrainId: train.id,
                  productionSelectionId:
                    productionReplanSources.length > 0
                      ? selectionId
                      : undefined,
                  holdReason: null
                },
                ctx
              ))
            )
              throw new Error(`Candidate ${candidate.id} changed during claim`);
          }
          if (productionReplanSources.length > 0) {
            const sourceMapping = productionReplanSources.map(
              ({ candidate, sourceSelectionId, sourceTrainId }) => ({
                candidate_id: candidate.id,
                source_production_selection_id: sourceSelectionId,
                source_train_id: sourceTrainId
              })
            );
            await this.repository.appendEvent(
              {
                trainId: train.id,
                eventType: 'PRODUCTION_REPLAN_REPLACEMENT_CLAIMED',
                actor: owner,
                payload: {
                  replacement_train_id: train.id,
                  replacement_production_selection_id: selectionId,
                  source_production_selection_ids: Array.from(
                    new Set(
                      productionReplanSources.map(
                        ({ sourceSelectionId }) => sourceSelectionId
                      )
                    )
                  ).sort((left, right) => left.localeCompare(right)),
                  source_train_ids: Array.from(
                    new Set(
                      productionReplanSources
                        .map(({ sourceTrainId }) => sourceTrainId)
                        .filter(
                          (sourceTrainId): sourceTrainId is string =>
                            sourceTrainId !== null
                        )
                    )
                  ).sort((left, right) => left.localeCompare(right)),
                  included_intents: sourceMapping,
                  omitted_intents: productionReplanOmissions.map(
                    ({
                      candidate,
                      sourceSelectionId,
                      sourceTrainId,
                      reason
                    }) => ({
                      candidate_id: candidate.id,
                      source_production_selection_id: sourceSelectionId,
                      source_train_id: sourceTrainId,
                      reason
                    })
                  )
                }
              },
              ctx
            );
            for (const source of productionReplanSources)
              await this.repository.appendEvent(
                {
                  trainId: train.id,
                  candidateId: source.candidate.id,
                  eventType: 'CANDIDATE_COALESCED_IN_PRODUCTION_REPLAN',
                  actor: owner,
                  payload: {
                    replacement_train_id: train.id,
                    replacement_production_selection_id: selectionId,
                    source_train_id: source.sourceTrainId,
                    source_production_selection_id: source.sourceSelectionId
                  }
                },
                ctx
              );
          }
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'TRAIN_CLAIMED',
              payload: {
                lane,
                candidate_ids: [
                  ...order,
                  ...removalCandidates.map(({ id }) => id)
                ],
                staging_policy:
                  lane === 'STAGING' ? 'CUMULATIVE_ADMITTED_SET_V1' : null,
                staging_baseline_manifest_id:
                  lane === 'STAGING'
                    ? (stagingState?.current_manifest_id ?? null)
                    : null,
                new_candidate_ids:
                  lane === 'STAGING'
                    ? readyCandidates.map(({ id }) => id)
                    : null,
                carried_candidate_ids:
                  lane === 'STAGING'
                    ? carriedCandidates.map(({ id }) => id)
                    : null,
                replaced_candidate_ids:
                  lane === 'STAGING'
                    ? replacedCandidates.map(({ id }) => id)
                    : null,
                removed_candidate_ids:
                  lane === 'STAGING'
                    ? removalCandidates
                        .filter(
                          ({ staging_transition_request }) =>
                            staging_transition_request === 'REMOVE'
                        )
                        .map(({ id }) => id)
                    : null,
                absorbed_candidate_ids:
                  lane === 'STAGING'
                    ? removalCandidates
                        .filter(
                          ({ staging_transition_request }) =>
                            staging_transition_request === 'ABSORB'
                        )
                        .map(({ id }) => id)
                    : null,
                production_selection_id: selectionId,
                production_replan_replacement:
                  productionReplanSources.length > 0,
                production_replan_source_selections:
                  productionReplanSources.map(
                    ({ candidate, sourceSelectionId, sourceTrainId }) => ({
                      candidate_id: candidate.id,
                      source_production_selection_id: sourceSelectionId,
                      source_train_id: sourceTrainId
                    })
                  ),
                production_replan_omitted_intents:
                  productionReplanOmissions.map(
                    ({
                      candidate,
                      sourceSelectionId,
                      sourceTrainId,
                      reason
                    }) => ({
                      candidate_id: candidate.id,
                      source_production_selection_id: sourceSelectionId,
                      source_train_id: sourceTrainId,
                      reason
                    })
                  ),
                qualification_policy:
                  lane === 'PRODUCTION'
                    ? CANDIDATE_STAGING_EVIDENCE_POLICY
                    : null,
                candidate_evidence: qualificationEvidence ?? null,
                production_replan_candidate_ids: eligible
                  .filter(
                    ({ status }) => status === 'WAITING_FOR_PRODUCTION_REPLAN'
                  )
                  .map(({ id }) => id),
                operator_beta: betaLaneEnabled,
                // Config validation requires one shared test_id.
                beta_test_id: betaLaneEnabled ? betaAllowlist[0]?.test_id : null
              }
            },
            ctx
          );
          return train;
        } finally {
          await this.repository.releaseLock(
            'scheduler',
            scheduler.lease_token,
            ctx
          );
        }
      }
    );
  }

  public async setPaused(
    scope: ReleaseBusV2ControlScope,
    paused: boolean,
    reason: string,
    actor: string
  ): Promise<void> {
    await this.repository.setControl(scope, paused, reason, actor, {});
    await this.repository.appendEvent(
      {
        eventType: paused ? 'BUS_PAUSED' : 'BUS_RESUMED',
        actor,
        payload: { scope, reason }
      },
      {}
    );
  }

  public async yieldUnsatisfiableProductionQualification(input: {
    readonly qualificationTrainId: string;
    readonly stagingIdentity: ReleaseBusV2StagingIdentity;
    readonly actor: string;
    readonly maintenanceSchedulerLeaseToken?: string;
  }): Promise<ReleaseBusV2QualificationYieldResult> {
    return this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        if (input.maintenanceSchedulerLeaseToken) {
          const locks = await this.repository.listLocks(ctx, true);
          const scheduler = locks.find(({ name }) => name === 'scheduler');
          if (
            Array.from(REQUIRED_MAINTENANCE_LOCKS).some(
              (name) => !locks.some((lock) => lock.name === name)
            ) ||
            scheduler?.lease_token !== input.maintenanceSchedulerLeaseToken ||
            locks.some(
              ({ name, owner_train_id, lease_token }) =>
                name !== 'scheduler' &&
                (owner_train_id !== null || lease_token !== null)
            )
          )
            throw new Error(
              'Maintenance recovery lost its exclusive all-lock safety fence'
            );
        }
        const qualification = await this.repository.findTrain(
          input.qualificationTrainId,
          ctx,
          true
        );
        if (!qualification?.parent_train_id)
          throw new Error(
            'Production qualification has no exact parent train identity'
          );
        const parent = await this.repository.findTrain(
          qualification.parent_train_id,
          ctx,
          true
        );
        if (!parent)
          throw new Error('Production qualification parent does not exist');
        const memberships = await this.repository.listTrainCandidates(
          parent.id,
          ctx
        );
        const candidateIds = memberships
          .filter(({ disposition }) => disposition === 'INCLUDED')
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ candidate_id }) => candidate_id);
        if (
          qualification.status === 'CANCELLED' &&
          parent.status === 'CANCELLED'
        )
          return {
            yielded: false,
            parentTrainId: parent.id,
            qualificationTrainId: qualification.id,
            candidateIds
          };
        if (
          qualification.lane !== 'PRODUCTION_QUALIFICATION' ||
          !['PREPARED', 'WAITING_FOR_ENVIRONMENT'].includes(
            qualification.status
          ) ||
          parent.lane !== 'PRODUCTION' ||
          parent.status !== 'WAITING_FOR_ENVIRONMENT' ||
          parent.qualification_train_id !== qualification.id
        )
          throw new Error(
            'Production qualification is not in the exact yieldable state'
          );
        const operations = [
          ...(await this.repository.listOperations(qualification.id, ctx)),
          ...(await this.repository.listOperations(parent.id, ctx))
        ];
        if (
          operations.some(
            ({ status }) => !TERMINAL_OPERATION_STATUSES.has(status)
          )
        )
          throw new Error(
            'Production qualification cannot yield while an operation is active'
          );
        const candidates = await Promise.all(
          candidateIds.map((candidateId) =>
            this.repository.findCandidateById(candidateId, ctx, true)
          )
        );
        if (candidates.some((candidate) => candidate === null))
          throw new Error(
            'Production qualification candidate identity is incomplete'
          );
        if (
          !qualification.frontend_composed_sha ||
          !qualification.backend_composed_sha ||
          !input.stagingIdentity.frontendSha ||
          !input.stagingIdentity.backendSha
        )
          throw new Error(
            'Production qualification unsatisfiability identity is incomplete'
          );
        const candidateRepositories = new Set(
          candidates.map((candidate) => candidate!.repository)
        );
        const mismatchedRepositories = [
          !candidateRepositories.has('frontend') &&
          input.stagingIdentity.frontendSha !==
            qualification.frontend_composed_sha
            ? 'frontend'
            : null,
          !candidateRepositories.has('backend') &&
          input.stagingIdentity.backendSha !==
            qualification.backend_composed_sha
            ? 'backend'
            : null
        ].filter((repository): repository is ReleaseBusV2Repository =>
          Boolean(repository)
        );
        if (mismatchedRepositories.length === 0)
          throw new Error(
            'Production qualification is not unsatisfiable against unchanged staging repositories'
          );
        const holdReason =
          'Exact production qualification could not bind unchanged staging identity; explicit readiness is preserved until a safe combined replan is claimable';
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (
            ['SUPERSEDED', 'CANCELLED', 'PRODUCTION_DEPLOYED'].includes(
              candidate.status
            )
          )
            continue;
          if (
            candidate.current_train_id !== parent.id ||
            candidate.production_requested_at === null ||
            ![
              'PRODUCTION_IN_TRAIN',
              'PRODUCTION_BUILDING_OR_QUALIFYING'
            ].includes(candidate.status)
          )
            throw new Error(
              `Candidate ${candidate.id} is not safely bound to the stalled production train`
            );
          if (
            !(await this.repository.updateCandidate(
              candidate.id,
              candidate.row_version,
              {
                status: 'WAITING_FOR_PRODUCTION_REPLAN',
                currentTrainId: null,
                holdReason
              },
              ctx
            ))
          )
            throw new Error(
              `Candidate ${candidate.id} changed during production qualification yield`
            );
          await this.repository.appendEvent(
            {
              trainId: parent.id,
              candidateId: candidate.id,
              eventType: 'CANDIDATE_WAITING_FOR_PRODUCTION_REPLAN',
              actor: input.actor,
              payload: {
                qualification_train_id: qualification.id,
                target_frontend_sha: qualification.frontend_composed_sha,
                target_backend_sha: qualification.backend_composed_sha,
                staging_frontend_sha: input.stagingIdentity.frontendSha,
                staging_backend_sha: input.stagingIdentity.backendSha,
                mismatched_repositories: mismatchedRepositories
              }
            },
            ctx
          );
        }
        const now = Date.now();
        if (
          !(await this.repository.updateTrain(
            qualification.id,
            qualification.row_version,
            {
              status: 'CANCELLED',
              failureClass: 'INTERACTION',
              failureMessage:
                'Unchanged staging identity cannot satisfy this immutable production qualification target',
              recoveryMessage:
                'Qualification yielded without environment mutation; explicit candidates are waiting for a safe current-base replan',
              completedAt: now
            },
            ctx
          ))
        )
          throw new Error(
            'Production qualification changed during transactional yield'
          );
        if (
          !(await this.repository.updateTrain(
            parent.id,
            parent.row_version,
            {
              status: 'CANCELLED',
              failureClass: 'INTERACTION',
              failureMessage:
                'Exact production qualification became unsatisfiable against unchanged staging identity',
              recoveryMessage:
                'The impossible train yielded the production lane; explicit candidates will rejoin a safe combined replan automatically',
              completedAt: now
            },
            ctx
          ))
        )
          throw new Error(
            'Production parent changed during transactional qualification yield'
          );
        await this.repository.appendEvent(
          {
            trainId: qualification.id,
            eventType: 'PRODUCTION_QUALIFICATION_YIELDED',
            actor: input.actor,
            payload: {
              parent_train_id: parent.id,
              candidate_ids: candidateIds,
              target_frontend_sha: qualification.frontend_composed_sha,
              target_backend_sha: qualification.backend_composed_sha,
              staging_frontend_sha: input.stagingIdentity.frontendSha,
              staging_backend_sha: input.stagingIdentity.backendSha,
              mismatched_repositories: mismatchedRepositories
            }
          },
          ctx
        );
        await this.repository.appendEvent(
          {
            trainId: parent.id,
            eventType: 'PRODUCTION_TRAIN_YIELDED_FOR_SAFE_REPLAN',
            actor: input.actor,
            payload: {
              qualification_train_id: qualification.id,
              candidate_ids: candidateIds
            }
          },
          ctx
        );
        return {
          yielded: true,
          parentTrainId: parent.id,
          qualificationTrainId: qualification.id,
          candidateIds
        };
      }
    );
  }

  public async isBetaTrainAllowed(
    train: ReleaseBusV2TrainRecord,
    allowlist: readonly ReleaseBusV2BetaEntry[] = getReleaseBusV2BetaAllowlist(),
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const memberships = await this.repository.listTrainCandidates(
      train.id,
      ctx
    );
    if (memberships.length === 0) return false;
    const candidates = await Promise.all(
      memberships.map(({ candidate_id }) =>
        this.repository.findCandidateById(candidate_id, ctx)
      )
    );
    return candidates.every(
      (candidate) =>
        candidate !== null &&
        releaseBusV2BetaAllowsCandidate(allowlist, candidate, train.lane)
    );
  }

  private async assertScopeRunning(
    scope: 'STAGING' | 'PRODUCTION'
  ): Promise<void> {
    const controls = await this.repository.listControls({});
    const paused =
      controls.find(
        (control) => control.scope === 'ALL' && Boolean(control.paused)
      ) ??
      controls.find(
        (control) => control.scope === scope && Boolean(control.paused)
      );
    if (paused)
      throw new Error(
        `${paused.scope} is paused: ${paused.reason ?? 'No reason recorded'}`
      );
  }

  private async assertAcyclic(ctx: RequestContext): Promise<void> {
    const candidates = await this.repository.listCandidates(
      [
        'READY_FOR_STAGING',
        'WAITING_FOR_DEPENDENCY',
        'STAGING_IN_TRAIN',
        'STAGING_BUILDING',
        'STAGING_DEPLOYING',
        'STAGING_DEPLOYED',
        'STAGING_VALIDATING',
        'STAGING_VALIDATED',
        'READY_FOR_PRODUCTION',
        CANDIDATE_EVIDENCE_READY_STATUS,
        'WAITING_FOR_PRODUCTION_REPLAN',
        'PRODUCTION_IN_TRAIN',
        'PRODUCTION_BUILDING_OR_QUALIFYING',
        'PRODUCTION_DEPLOYING',
        'PRODUCTION_DEPLOYED'
      ],
      500,
      ctx
    );
    const ids = candidates.map((candidate) => candidate.id);
    const dependencies = await this.repository.listDependencies(ids, ctx);
    topologicalOrder(
      ids,
      dependencies.map(
        (dependency) =>
          [
            dependency.prerequisite_candidate_id,
            dependency.candidate_id
          ] as const
      )
    );
  }

  private async selectDependencyClosedCandidates(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    dependencies: readonly ReleaseBusV2DependencyRecord[],
    lane: ReleaseBusV2Lane,
    ctx: RequestContext,
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = [],
    updateDependencyHolds = true
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate])
    );
    const eligible = new Set(candidates.map((candidate) => candidate.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const dependency of dependencies) {
        if (!eligible.has(dependency.candidate_id)) continue;
        if (lane === 'STAGING' && dependency.environment === 'PRODUCTION')
          continue;
        if (lane === 'PRODUCTION' && dependency.environment === 'STAGING')
          continue;
        if (
          betaAllowlist.length > 0 &&
          !betaAllowlist.some(
            (entry) =>
              entry.candidate_id === dependency.prerequisite_candidate_id &&
              releaseBusV2BetaAllowsLane([entry], lane)
          )
        ) {
          eligible.delete(dependency.candidate_id);
          changed = true;
          continue;
        }
        const prerequisiteInBatch = eligible.has(
          dependency.prerequisite_candidate_id
        );
        const prerequisite = await this.repository.findCandidateById(
          dependency.prerequisite_candidate_id,
          ctx
        );
        // Cumulative staging contains every exact prerequisite in the proposed
        // live manifest. Historical staging validation is not current presence
        // and can never satisfy an omitted staging dependency.
        const alreadySatisfied =
          lane === 'PRODUCTION'
            ? Boolean(
                prerequisite &&
                (await this.hasExactProductionDeploymentEvidence(
                  prerequisite,
                  ctx
                ))
              )
            : false;
        if (!prerequisiteInBatch && !alreadySatisfied) {
          eligible.delete(dependency.candidate_id);
          changed = true;
        }
      }
    }
    if (updateDependencyHolds)
      for (const candidate of candidates) {
        if (eligible.has(candidate.id)) continue;
        await this.repository.updateCandidate(
          candidate.id,
          candidate.row_version,
          {
            status: 'WAITING_FOR_DEPENDENCY',
            holdReason: `Waiting for ${lane.toLowerCase()} dependency`
          },
          ctx
        );
      }
    return Array.from(eligible)
      .map((id) => byId.get(id))
      .filter((candidate): candidate is ReleaseBusV2CandidateRecord =>
        Boolean(candidate)
      );
  }

  private async refreshDependencyHolds(
    lane: ReleaseBusV2Lane,
    ctx: RequestContext,
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = []
  ): Promise<void> {
    const waiting = await this.repository.listCandidates(
      ['WAITING_FOR_DEPENDENCY'],
      RELEASE_BUS_V2_MAX_CANDIDATES,
      ctx
    );
    const laneWaiting = waiting
      .filter(
        (candidate) =>
          betaAllowlist.length === 0 ||
          releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
      )
      .filter((candidate) =>
        lane === 'PRODUCTION'
          ? candidate.production_requested_at !== null
          : candidate.production_requested_at === null
      );
    if (laneWaiting.length === 0) return;
    const dependencies = await this.repository.listDependencies(
      laneWaiting.map((candidate) => candidate.id),
      ctx
    );
    for (const candidate of laneWaiting) {
      const required = dependencies.filter((dependency) => {
        if (dependency.candidate_id !== candidate.id) return false;
        if (lane === 'STAGING') return dependency.environment !== 'PRODUCTION';
        return dependency.environment !== 'STAGING';
      });
      let satisfied = true;
      for (const dependency of required) {
        if (
          betaAllowlist.length > 0 &&
          !betaAllowlist.some(
            (entry) =>
              entry.candidate_id === dependency.prerequisite_candidate_id &&
              releaseBusV2BetaAllowsLane([entry], lane)
          )
        ) {
          satisfied = false;
          break;
        }
        const prerequisite = await this.repository.findCandidateById(
          dependency.prerequisite_candidate_id,
          ctx
        );
        const dependencySatisfied =
          lane === 'PRODUCTION'
            ? Boolean(
                prerequisite &&
                (await this.hasExactProductionDeploymentEvidence(
                  prerequisite,
                  ctx
                ))
              )
            : [
                'STAGING_VALIDATED',
                'READY_FOR_PRODUCTION',
                CANDIDATE_EVIDENCE_READY_STATUS,
                'PRODUCTION_IN_TRAIN',
                'PRODUCTION_DEPLOYED'
              ].includes(prerequisite?.status ?? '');
        if (!dependencySatisfied) {
          satisfied = false;
          break;
        }
      }
      if (!satisfied) continue;
      await this.repository.updateCandidate(
        candidate.id,
        candidate.row_version,
        {
          status:
            lane === 'PRODUCTION'
              ? candidate.production_selection_id
                ? CANDIDATE_EVIDENCE_READY_STATUS
                : 'READY_FOR_PRODUCTION'
              : 'READY_FOR_STAGING',
          holdReason: null
        },
        ctx
      );
    }
  }
}

export function storedDeployPlan(
  candidate: ReleaseBusV2CandidateRecord
): ReleaseBusV2DeployPlan | null {
  return parseStoredJson(candidate.deploy_plan_json);
}

export const releaseBusV2Service = new ReleaseBusV2Service();
