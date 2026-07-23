import { createHash, randomUUID } from 'node:crypto';
import { getDeployServiceConfigs } from '@/api/deploy/deploy.config';
import {
  releaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError
} from '@/releaseBus/release-bus.github-app';
import {
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaInfrastructureFailureInjection,
  releaseBusV2BetaAllowsLane,
  type ReleaseBusV2BetaEntry
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusV2Operations,
  type ReleaseBusV2WorkflowSpec
} from '@/releaseBusV2/release-bus-v2.operations';
import {
  releaseBusV2Repository,
  type ReleaseBusV2DependencyRecord,
  type ReleaseBusV2LockRecord,
  type ReleaseBusV2ManifestRecord,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass,
  type ReleaseBusV2TrainCandidateRecord
} from '@/releaseBusV2/release-bus-v2.repository';
import {
  releaseBusV2Service,
  storedDeployPlan,
  topologicalOrder,
  type ReleaseBusV2Service
} from '@/releaseBusV2/release-bus-v2.service';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2FailureClass,
  ReleaseBusV2ManifestStatus,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2PrEvidence,
  ReleaseBusV2Repository,
  ReleaseBusV2TrainRecord,
  ReleaseBusV2TrainStatus
} from '@/releaseBusV2/release-bus-v2.types';

const TERMINAL_TRAINS = new Set<ReleaseBusV2TrainStatus>([
  'STAGING_VALIDATED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);
const TERMINAL_OPERATIONS = new Set<ReleaseBusV2OperationRecord['status']>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
]);
// The lock is renewed every minute, but its expiry must also outlive the
// longest deployment/E2E workflow during a temporary control-plane outage.
// Workflow timeouts are at most 90 minutes, so two hours prevents overlapping
// mutation while still allowing deterministic recovery from an abandoned lock.
const ENVIRONMENT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

type TrainContext = {
  readonly train: ReleaseBusV2TrainRecord;
  readonly memberships: readonly ReleaseBusV2TrainCandidateRecord[];
  readonly candidates: readonly ReleaseBusV2CandidateRecord[];
  readonly dependencies: readonly ReleaseBusV2DependencyRecord[];
};

type PreparedRepository = {
  readonly repository: ReleaseBusV2Repository;
  readonly composedSha: string;
  readonly artifactDigest: string | null;
  readonly pending: boolean;
  readonly failedOperation: ReleaseBusV2OperationRecord | null;
};

type ArtifactSource = {
  readonly trainId: string;
  readonly frontendRunId: string | null;
  readonly backendRunId: string | null;
};

type DeployResult = {
  readonly complete: boolean;
  readonly failedOperation: ReleaseBusV2OperationRecord | null;
  readonly operations: readonly ReleaseBusV2OperationRecord[];
};

type StagingIdleSnapshot = {
  readonly frontend_staging_sha: string | null;
  readonly backend_staging_sha: string | null;
};

type StagingIdleHandshakeSnapshot = StagingIdleSnapshot & {
  readonly workflow_fence_started_at: number;
  readonly verified_at: number;
};

type StagingEnvironmentBinding = {
  readonly frontendSha: string;
  readonly backendSha: string;
  readonly frontendFromExistingStaging: boolean;
  readonly backendFromExistingStaging: boolean;
};

type ProductionIdleSnapshot = {
  readonly frontend_main_sha: string;
  readonly backend_main_sha: string;
};

type IsolationSubsetResult =
  | { readonly status: 'PENDING' | 'PASSED' }
  | {
      readonly status: 'FAILED';
      readonly failureClass: ReleaseBusV2FailureClass;
      readonly message: string;
    };

type IsolationDiagnosis = {
  readonly pending: boolean;
  readonly attributable: ReadonlySet<string>;
  readonly interaction: ReadonlySet<string>;
  readonly passed: ReadonlySet<string>;
  readonly terminalFailure: {
    readonly failureClass: ReleaseBusV2FailureClass;
    readonly message: string;
  } | null;
};

class MainMovedError extends Error {}

function isGitHubInfrastructureError(error: unknown): error is Error {
  const infrastructureType: unknown = ReleaseBusGitHubInfrastructureError;
  return (
    error instanceof Error &&
    ((typeof infrastructureType === 'function' &&
      error instanceof infrastructureType) ||
      error.name === 'ReleaseBusGitHubInfrastructureError' ||
      error.constructor.name === 'ReleaseBusGitHubInfrastructureError')
  );
}

function isOptimisticConcurrencyConflict(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message === 'Release Bus v2 operation changed concurrently' ||
      error.message === 'Release Bus v2 train changed concurrently' ||
      error.message === 'Candidate changed concurrently' ||
      /^(frontend|backend) main operation changed concurrently$/.test(
        error.message
      ) ||
      /^Candidate .* changed during deterministic isolation$/.test(
        error.message
      ))
  );
}

function parseStoredJson<T>(value: unknown): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function laneBranchSegment(
  lane: ReleaseBusV2TrainRecord['lane']
): 'staging' | 'production' | 'qualification' {
  if (lane === 'PRODUCTION') return 'production';
  if (lane === 'PRODUCTION_QUALIFICATION') return 'qualification';
  return 'staging';
}

export function releaseBusV2Branch(
  train: Pick<ReleaseBusV2TrainRecord, 'id' | 'lane'>,
  repository: ReleaseBusV2Repository
): string {
  return `release-bus-v2/${laneBranchSegment(train.lane)}-train-${train.id}-${repository}`;
}

export function dagLayers(
  units: readonly string[],
  edges: ReadonlyArray<readonly [string, string]>
): string[][] {
  const order = topologicalOrder(units, edges);
  const predecessors = new Map(
    order.map((unit) => [unit, new Set<string>()] as const)
  );
  for (const [from, to] of edges) predecessors.get(to)?.add(from);
  const remaining = new Set(order);
  const completed = new Set<string>();
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = order.filter(
      (unit) =>
        remaining.has(unit) &&
        Array.from(predecessors.get(unit) ?? []).every((dependency) =>
          completed.has(dependency)
        )
    );
    if (layer.length === 0) throw new Error('Backend deploy graph has a cycle');
    layers.push(layer);
    for (const unit of layer) {
      remaining.delete(unit);
      completed.add(unit);
    }
  }
  return layers;
}

export function candidateExclusionClosure(
  excludedCandidateIds: readonly string[],
  dependencies: readonly Pick<
    ReleaseBusV2DependencyRecord,
    'candidate_id' | 'prerequisite_candidate_id'
  >[]
): Set<string> {
  const excluded = new Set(excludedCandidateIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of dependencies) {
      if (
        excluded.has(dependency.prerequisite_candidate_id) &&
        !excluded.has(dependency.candidate_id)
      ) {
        excluded.add(dependency.candidate_id);
        changed = true;
      }
    }
  }
  return excluded;
}

function prEvidence(
  candidate: ReleaseBusV2CandidateRecord
): ReleaseBusV2PrEvidence | null {
  return parseStoredJson(candidate.pr_evidence_json);
}

export function canUseSingleCandidateFastPath(
  candidate: ReleaseBusV2CandidateRecord,
  baseSha: string
): boolean {
  const evidence = prEvidence(candidate);
  return Boolean(
    evidence &&
    evidence.base_sha === baseSha &&
    /^[a-f0-9]{40}$/.test(evidence.merge_sha)
  );
}

function reusablePrArtifact(
  candidate: ReleaseBusV2CandidateRecord,
  repository: ReleaseBusV2Repository,
  deployUnits: readonly string[]
): ReleaseBusV2PrEvidence | null {
  const evidence = prEvidence(candidate);
  if (
    !evidence?.artifact_run_id ||
    !evidence.artifact_name ||
    !evidence.artifact_digest
  )
    return null;
  // The backend PR lane deliberately packages only the API fast-path artifact.
  // Other service sets still reuse the exact green merge-tree SHA, then build
  // each requested unit once in the combined preflight.
  if (
    repository === 'backend' &&
    (deployUnits.length !== 1 || deployUnits[0] !== 'api')
  )
    return null;
  // Frontend PR CI emits one immutable dual-profile artifact. Staging and
  // production select their environment-safe package from that same digest.
  return evidence;
}

function operationKey(trainId: string, suffix: string): string {
  return `rb2:${trainId}:${suffix}`;
}

function candidateStatusForBuild(
  lane: ReleaseBusV2TrainRecord['lane']
): ReleaseBusV2CandidateStatus {
  return lane === 'STAGING'
    ? 'STAGING_BUILDING'
    : 'PRODUCTION_BUILDING_OR_QUALIFYING';
}

function candidateStatusForDeploy(
  lane: ReleaseBusV2TrainRecord['lane']
): ReleaseBusV2CandidateStatus {
  return lane === 'STAGING' ? 'STAGING_DEPLOYING' : 'PRODUCTION_DEPLOYING';
}

export function backendGraph(
  candidates: readonly ReleaseBusV2CandidateRecord[]
): {
  readonly units: readonly string[];
  readonly edges: ReadonlyArray<readonly [string, string]>;
  readonly layers: readonly string[][];
} {
  const units = new Set<string>();
  const edgeKeys = new Set<string>();
  const edges: Array<readonly [string, string]> = [];
  for (const candidate of candidates) {
    if (candidate.repository !== 'backend') continue;
    const plan = storedDeployPlan(candidate);
    for (const unit of plan?.units ?? []) units.add(unit);
    for (const [from, to] of plan?.edges ?? []) {
      const key = `${from}\u0000${to}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push([from, to]);
    }
  }
  for (const service of getDeployServiceConfigs()) {
    if (!units.has(service.name)) continue;
    for (const dependency of service.default_dependencies) {
      if (!units.has(dependency)) continue;
      const key = `${dependency}\u0000${service.name}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push([dependency, service.name]);
    }
  }
  const orderedUnits = Array.from(units).sort((left, right) =>
    left.localeCompare(right)
  );
  return {
    units: orderedUnits,
    edges,
    layers: dagLayers(orderedUnits, edges)
  };
}

export type ReleaseBusV2ReleaseNoteGroup = {
  readonly release_group_id: string;
  readonly release_group_services: readonly string[];
  readonly pull_request_number: number;
  readonly publish_release_note: boolean;
};

function compareInvariant(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Each backend candidate remains its own PR-scoped release-note group even
 * when v2 deploys multiple candidates or overlapping service plans together.
 * Every applicable successful service persists the group-level publication
 * request. The consumer waits for the full canonical completion set and uses
 * its processing lock as the single publication winner, so no particular
 * service or completion order owns the finalize signal.
 */
export function backendReleaseNoteGroups(
  candidates: readonly ReleaseBusV2CandidateRecord[],
  service: string
): ReleaseBusV2ReleaseNoteGroup[] {
  const groups = new Map<number, ReleaseBusV2ReleaseNoteGroup>();
  for (const candidate of candidates) {
    if (candidate.repository !== 'backend') continue;
    const plan = storedDeployPlan(candidate);
    if (
      !plan ||
      plan.publish_release_notes === false ||
      !plan.units.includes(service)
    )
      continue;
    const services = Array.from(new Set(plan.units)).sort(compareInvariant);
    const group: ReleaseBusV2ReleaseNoteGroup = {
      release_group_id: `pr-${candidate.pr_number}`,
      release_group_services: services,
      pull_request_number: candidate.pr_number,
      publish_release_note: true
    };
    const existing = groups.get(candidate.pr_number);
    if (
      existing &&
      JSON.stringify(existing.release_group_services) !==
        JSON.stringify(group.release_group_services)
    )
      throw new Error(
        `PR ${candidate.pr_number} has conflicting release-note service groups`
      );
    groups.set(candidate.pr_number, group);
  }
  return Array.from(groups.values()).sort(
    (left, right) => left.pull_request_number - right.pull_request_number
  );
}

export function backendReleaseNoteInputs(
  candidates: readonly ReleaseBusV2CandidateRecord[],
  service: string,
  environment: 'staging' | 'prod'
): Record<string, string> {
  const releaseNoteGroups =
    environment === 'prod' ? backendReleaseNoteGroups(candidates, service) : [];
  const serviceCandidates = candidates.filter((candidate) => {
    if (candidate.repository !== 'backend') return false;
    return storedDeployPlan(candidate)?.units.includes(service) === true;
  });
  const releaseNoteOptOut =
    environment === 'prod' &&
    serviceCandidates.length > 0 &&
    serviceCandidates.every(
      (candidate) =>
        storedDeployPlan(candidate)?.publish_release_notes === false
    );
  if (
    environment === 'prod' &&
    releaseNoteGroups.length === 0 &&
    !releaseNoteOptOut
  )
    throw new Error(
      `Production backend service ${service} has neither release-note groups nor an explicit opt-out`
    );
  const legacyReleaseNoteGroup =
    releaseNoteGroups.length === 1 ? releaseNoteGroups[0] : null;
  return {
    release_pull_request: legacyReleaseNoteGroup
      ? String(legacyReleaseNoteGroup.pull_request_number)
      : '',
    release_group_services:
      legacyReleaseNoteGroup?.release_group_services.join(',') ?? '',
    release_note_publish: String(
      legacyReleaseNoteGroup?.publish_release_note ?? false
    ),
    release_note_groups:
      environment === 'prod' ? JSON.stringify(releaseNoteGroups) : '',
    release_note_opt_out: String(releaseNoteOptOut)
  };
}

function relevantCandidates(
  context: TrainContext,
  repository?: ReleaseBusV2Repository
): ReleaseBusV2CandidateRecord[] {
  const included = new Set(
    context.memberships
      .filter((membership) => membership.disposition === 'INCLUDED')
      .map((membership) => membership.candidate_id)
  );
  return context.candidates.filter(
    (candidate) =>
      included.has(candidate.id) &&
      (!repository || candidate.repository === repository)
  );
}

function frontendDependsOnBackend(context: TrainContext): boolean {
  const included = new Set(relevantCandidates(context).map(({ id }) => id));
  const backend = new Set(
    relevantCandidates(context, 'backend').map(({ id }) => id)
  );
  const frontend = new Set(
    relevantCandidates(context, 'frontend').map(({ id }) => id)
  );
  return context.dependencies.some(
    (dependency) =>
      included.has(dependency.candidate_id) &&
      included.has(dependency.prerequisite_candidate_id) &&
      frontend.has(dependency.candidate_id) &&
      backend.has(dependency.prerequisite_candidate_id) &&
      dependency.environment !==
        (context.train.lane === 'STAGING' ? 'PRODUCTION' : 'STAGING')
  );
}

export class ReleaseBusV2Reconciler {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository,
    private readonly service: ReleaseBusV2Service = releaseBusV2Service
  ) {}

  public async runOnce(invocationId: string = randomUUID()): Promise<{
    readonly mode: string;
    readonly claimed: readonly string[];
    readonly advanced: readonly string[];
  }> {
    const mode = getReleaseBusV2Mode();
    const claimed: string[] = [];
    await this.releaseTerminalEnvironmentLocks();
    let betaAllowlist: readonly ReleaseBusV2BetaEntry[] = [];
    if (mode === 'OFF') {
      try {
        betaAllowlist = getReleaseBusV2BetaAllowlist();
      } catch {
        const controls = await this.repository.listControls({});
        const allControl = controls.find(({ scope }) => scope === 'ALL');
        if (!allControl?.paused)
          await this.service.setPaused(
            'ALL',
            true,
            'Release Bus v2 OFF beta allowlist is invalid; automation remains disabled',
            'release-bus-v2-beta'
          );
        return { mode, claimed, advanced: [] };
      }
      if (betaAllowlist.length === 0) return { mode, claimed, advanced: [] };
    }
    const controls = await this.repository.listControls({});
    const isPaused = (scope: 'ALL' | 'STAGING' | 'PRODUCTION') =>
      controls.some(
        (control) => control.scope === scope && Boolean(control.paused)
      );
    if (isPaused('ALL')) return { mode, claimed, advanced: [] };
    const stagingEnabled =
      !isPaused('STAGING') &&
      (mode !== 'OFF' || releaseBusV2BetaAllowsLane(betaAllowlist, 'STAGING'));
    const productionEnabled =
      !isPaused('PRODUCTION') &&
      (mode === 'PRODUCTION' ||
        (mode === 'OFF' &&
          releaseBusV2BetaAllowsLane(betaAllowlist, 'PRODUCTION')));
    if (stagingEnabled || productionEnabled) {
      try {
        await this.reconcileQueuedCandidateHeads(betaAllowlist);
        const [frontendMain, backendMain] = await Promise.all([
          releaseBusGitHubApp.resolveRef('frontend', 'main'),
          releaseBusGitHubApp.resolveRef('backend', 'main')
        ]);
        if (stagingEnabled) {
          const staging = await this.service.claimLane(
            'STAGING',
            frontendMain,
            backendMain,
            `${invocationId}:staging`
          );
          if (staging) claimed.push(staging.id);
        }
        if (productionEnabled) {
          const production = await this.service.claimLane(
            'PRODUCTION',
            frontendMain,
            backendMain,
            `${invocationId}:production`
          );
          if (production) claimed.push(production.id);
        }
      } catch (error) {
        if (!isGitHubInfrastructureError(error)) {
          await this.service.setPaused(
            'ALL',
            true,
            `Release Bus v2 could not resolve or claim exact main refs: ${
              error instanceof Error ? error.message : 'unknown failure'
            }`,
            'release-bus-v2'
          );
        }
      }
    }

    const activeByLane = (await this.repository.listTrains(100, {}))
      .filter((train) => !TERMINAL_TRAINS.has(train.status))
      .filter((train) => {
        if (train.lane === 'STAGING') return stagingEnabled;
        if (train.lane === 'PRODUCTION') return productionEnabled;
        return stagingEnabled && productionEnabled;
      });
    const active: ReleaseBusV2TrainRecord[] = [];
    for (const train of activeByLane) {
      if (
        mode !== 'OFF' ||
        (await this.service.isBetaTrainAllowed(train, betaAllowlist, {}))
      )
        active.push(train);
    }
    active.sort((left, right) => {
      if (
        left.lane === 'PRODUCTION_QUALIFICATION' &&
        right.lane !== 'PRODUCTION_QUALIFICATION'
      )
        return -1;
      if (
        right.lane === 'PRODUCTION_QUALIFICATION' &&
        left.lane !== 'PRODUCTION_QUALIFICATION'
      )
        return 1;
      return Number(left.created_at) - Number(right.created_at);
    });
    const advanced: string[] = [];
    for (const train of active) {
      try {
        await this.advanceUntilExternalWait(train);
        advanced.push(train.id);
      } catch (error) {
        // Lambda invocations and workflow callbacks may overlap. Optimistic
        // locking identifies the winner; the loser must observe on the next
        // pass instead of turning a valid idempotent advance into a bus-wide
        // control-plane failure.
        if (isOptimisticConcurrencyConflict(error)) continue;
        if (error instanceof MainMovedError) {
          await this.cancelForMovedMain(train, error.message);
          continue;
        }
        if (isGitHubInfrastructureError(error)) {
          await this.deferTrainForInfrastructure(train, error.message);
          continue;
        }
        await this.failTrain(
          train,
          'CONTROL_PLANE',
          error instanceof Error ? error.message : 'Unknown reconciler failure'
        );
      }
    }
    return { mode, claimed: Array.from(new Set(claimed)), advanced };
  }

  private async reconcileQueuedCandidateHeads(
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = []
  ): Promise<void> {
    const candidates = (
      await this.repository.listCandidates(
        ['READY_FOR_STAGING', 'WAITING_FOR_DEPENDENCY', 'READY_FOR_PRODUCTION'],
        500,
        {}
      )
    ).filter((candidate) => {
      if (betaAllowlist.length === 0) return true;
      const lane =
        candidate.status === 'READY_FOR_PRODUCTION' ? 'PRODUCTION' : 'STAGING';
      return releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane);
    });
    const branchHeads = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        currentHead: await releaseBusGitHubApp.resolveRefIfExists(
          candidate.repository,
          candidate.branch_name
        )
      }))
    );
    for (const { candidate, currentHead } of branchHeads) {
      if (currentHead === candidate.head_sha) continue;
      await this.service.invalidateBranch(
        candidate.repository,
        candidate.branch_name,
        currentHead ?? 'deleted',
        'release-bus-v2-reconciler'
      );
    }
  }

  private async advanceUntilExternalWait(
    initial: ReleaseBusV2TrainRecord
  ): Promise<void> {
    let current = initial;
    for (let transition = 0; transition < 12; transition += 1) {
      await this.advance(current);
      const refreshed = await this.repository.findTrain(current.id, {});
      if (!refreshed || TERMINAL_TRAINS.has(refreshed.status)) return;
      if (refreshed.row_version === current.row_version) return;
      current = refreshed;
    }
    throw new Error(
      `Release Bus v2 train ${initial.id} exceeded the bounded internal transition budget`
    );
  }

  private async advance(train: ReleaseBusV2TrainRecord): Promise<void> {
    const context = await this.loadContext(train);
    if (['CLAIMED', 'COMPOSING', 'PREFLIGHTING'].includes(train.status)) {
      await this.advancePreparation(context);
      return;
    }
    if (train.lane === 'PRODUCTION') {
      await this.advanceProduction(context);
      return;
    }
    await this.advanceStagingOrQualification(context);
  }

  private async loadContext(
    train: ReleaseBusV2TrainRecord
  ): Promise<TrainContext> {
    const memberships = await this.repository.listTrainCandidates(train.id, {});
    const candidates = (
      await Promise.all(
        memberships.map((membership) =>
          this.repository.findCandidateById(membership.candidate_id, {})
        )
      )
    ).filter((candidate): candidate is ReleaseBusV2CandidateRecord =>
      Boolean(candidate)
    );
    return {
      train,
      memberships,
      candidates,
      dependencies: await this.repository.listDependencies(
        candidates.map(({ id }) => id),
        {}
      )
    };
  }

  private async advancePreparation(context: TrainContext): Promise<void> {
    const train = context.train;
    if (relevantCandidates(context).length === 0) {
      await this.transitionTrain(train, {
        status: 'CANCELLED',
        failureClass: 'INTERACTION',
        failureMessage: 'Every candidate was excluded during composition',
        recoveryMessage:
          'No environment mutation occurred; excluded candidates retain their actionable hold states',
        completedAt: Date.now()
      });
      return;
    }
    await this.updateCandidateStatuses(
      relevantCandidates(context),
      candidateStatusForBuild(train.lane),
      train.id
    );
    const compositionOnly =
      train.lane === 'PRODUCTION' &&
      ['CLAIMED', 'COMPOSING'].includes(train.status);
    const [frontend, backend] = await Promise.all([
      this.prepareRepository(context, 'frontend', compositionOnly),
      this.prepareRepository(context, 'backend', compositionOnly)
    ]);
    const failed = frontend.failedOperation ?? backend.failedOperation;
    if (failed) {
      if (
        failed.failure_class === 'CANDIDATE' &&
        failed.repository &&
        relevantCandidates(context, failed.repository).length > 1
      ) {
        await this.reconcileCandidateIsolation(context, failed.repository);
        return;
      }
      await this.failTrain(
        train,
        failed.failure_class ?? 'CONTROL_PLANE',
        failed.failure_message ?? `${failed.operation_type} failed`
      );
      return;
    }
    const allComposed = Boolean(frontend.composedSha && backend.composedSha);
    if (compositionOnly && allComposed) {
      const exact = await this.repository.findValidatedManifestByShas(
        frontend.composedSha,
        backend.composedSha,
        {}
      );
      await this.transitionTrain(train, {
        status: exact ? 'PREPARED' : 'PREFLIGHTING',
        frontendComposedSha: frontend.composedSha,
        backendComposedSha: backend.composedSha,
        frontendArtifactDigest: exact?.frontend_artifact_digest ?? null,
        backendArtifactDigest: exact?.backend_artifact_digest ?? null,
        manifestId: exact?.id ?? null,
        recoveryMessage: exact
          ? 'Exact staging-validated composition and immutable artifacts were reused without rebuilding'
          : 'Exact production composition differs from validated staging; preparing one immutable artifact per application'
      });
      return;
    }
    const allPrepared = allComposed && !frontend.pending && !backend.pending;
    const nextStatus: ReleaseBusV2TrainStatus = allPrepared
      ? 'PREPARED'
      : allComposed
        ? 'PREFLIGHTING'
        : 'COMPOSING';
    if (
      train.status === nextStatus &&
      train.frontend_composed_sha === frontend.composedSha &&
      train.backend_composed_sha === backend.composedSha &&
      train.frontend_artifact_digest === frontend.artifactDigest &&
      train.backend_artifact_digest === backend.artifactDigest
    )
      return;
    await this.transitionTrain(train, {
      status: nextStatus,
      frontendComposedSha: frontend.composedSha,
      backendComposedSha: backend.composedSha,
      frontendArtifactDigest: frontend.artifactDigest,
      backendArtifactDigest: backend.artifactDigest,
      recoveryMessage: allPrepared
        ? 'Exact artifacts prepared; waiting only for environment ownership'
        : 'Frontend and backend preparation are reconciling concurrently'
    });
  }

  private async prepareRepository(
    context: TrainContext,
    repository: ReleaseBusV2Repository,
    compositionOnly = false
  ): Promise<PreparedRepository> {
    const train = context.train;
    const candidates = relevantCandidates(context, repository);
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) throw new Error(`Missing ${repository} base SHA`);
    if (candidates.length === 0) {
      return {
        repository,
        composedSha: baseSha,
        artifactDigest: null,
        pending: false,
        failedOperation: null
      };
    }
    const storedComposedSha =
      repository === 'frontend'
        ? train.frontend_composed_sha
        : train.backend_composed_sha;
    const fastCandidate =
      candidates.length === 1 &&
      canUseSingleCandidateFastPath(candidates[0], baseSha)
        ? candidates[0]
        : null;
    let composedSha =
      storedComposedSha ??
      prEvidence(fastCandidate ?? candidates[0])?.merge_sha;
    if (!storedComposedSha && !fastCandidate) {
      const compose = await releaseBusV2Operations.reconcileWorkflow({
        idempotencyKey: operationKey(train.id, `compose:${repository}`),
        trainId: train.id,
        operationType: `COMPOSE_${repository.toUpperCase()}`,
        repository,
        workflow: 'release-bus-v2-compose.yml',
        ref: 'main',
        environment: 'orchestration',
        service: null,
        expectedSha: baseSha,
        artifactDigest: null,
        inputs: {
          release_train_id: train.id,
          release_train_revision: '1',
          operation_key: 'replaced-by-reconciler',
          base_sha: baseSha,
          expected_sha: baseSha,
          candidate_shas: JSON.stringify(
            candidates.map(({ head_sha }) => head_sha)
          ),
          release_branch: releaseBusV2Branch(train, repository)
        }
      });
      if (compose.status === 'FAILED')
        return {
          repository,
          composedSha: '',
          artifactDigest: null,
          pending: false,
          failedOperation: compose
        };
      if (compose.status !== 'SUCCEEDED')
        return {
          repository,
          composedSha: '',
          artifactDigest: null,
          pending: true,
          failedOperation: null
        };
      const exclusionsApplied = await this.applyCompositionExclusions(
        context,
        compose
      );
      composedSha = await releaseBusGitHubApp.resolveRef(
        repository,
        releaseBusV2Branch(train, repository)
      );
      if (exclusionsApplied)
        return {
          repository,
          composedSha,
          artifactDigest: null,
          pending: true,
          failedOperation: null
        };
    }
    if (!composedSha) throw new Error(`Missing ${repository} composed SHA`);
    if (compositionOnly)
      return {
        repository,
        composedSha,
        artifactDigest:
          repository === 'frontend'
            ? train.frontend_artifact_digest
            : train.backend_artifact_digest,
        pending: false,
        failedOperation: null
      };
    const storedArtifactDigest =
      repository === 'frontend'
        ? train.frontend_artifact_digest
        : train.backend_artifact_digest;
    if (storedComposedSha && storedArtifactDigest)
      return {
        repository,
        composedSha,
        artifactDigest: storedArtifactDigest,
        pending: false,
        failedOperation: null
      };
    const graph = repository === 'backend' ? backendGraph(candidates) : null;
    const evidence = fastCandidate
      ? reusablePrArtifact(fastCandidate, repository, graph?.units ?? [])
      : null;
    const operationType = `PREPARE_ARTIFACT_${repository.toUpperCase()}`;
    const betaInfrastructureFailureInjection =
      getReleaseBusV2Mode() === 'OFF' && train.lane === 'STAGING'
        ? releaseBusV2BetaInfrastructureFailureInjection(
            getReleaseBusV2BetaAllowlist(),
            candidates,
            train.lane,
            operationType
          )
        : null;
    const artifact = await releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(train.id, `prepare:${repository}`),
      trainId: train.id,
      operationType,
      repository,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: composedSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: fastCandidate
          ? fastCandidate.branch_name
          : releaseBusV2Branch(train, repository),
        expected_sha: composedSha,
        deploy_units: JSON.stringify(graph?.units ?? []),
        reuse_artifact_run_id: evidence?.artifact_run_id ?? '',
        reuse_artifact_name: evidence?.artifact_name ?? '',
        reuse_artifact_digest: evidence?.artifact_digest ?? '',
        ...(repository === 'frontend'
          ? {
              artifact_environment:
                train.lane === 'STAGING' ? 'staging' : 'production'
            }
          : {})
      },
      maxAttempts: 3,
      ...(betaInfrastructureFailureInjection
        ? { betaInfrastructureFailureInjection }
        : {})
    });
    return {
      repository,
      composedSha,
      artifactDigest: artifact.artifact_digest,
      pending: artifact.status !== 'SUCCEEDED',
      failedOperation: artifact.status === 'FAILED' ? artifact : null
    };
  }

  private async reconcileCandidateIsolation(
    context: TrainContext,
    repository: ReleaseBusV2Repository
  ): Promise<void> {
    const candidates = relevantCandidates(context, repository);
    const diagnosis = await this.diagnoseKnownFailedGroup(
      context,
      repository,
      candidates,
      ''
    );
    if (diagnosis.pending) {
      const message =
        'A real composed-code failure is under bounded deterministic bisection; exact passing subset evidence is reused';
      if (
        context.train.status !== 'PREFLIGHTING' ||
        context.train.recovery_message !== message
      )
        await this.transitionTrain(context.train, {
          status: 'PREFLIGHTING',
          recoveryMessage: message
        });
      return;
    }
    if (diagnosis.terminalFailure) {
      await this.failTrain(
        context.train,
        diagnosis.terminalFailure.failureClass,
        diagnosis.terminalFailure.message
      );
      return;
    }

    const failedIds = new Set([
      ...Array.from(diagnosis.attributable),
      ...Array.from(diagnosis.interaction)
    ]);
    const blockedIds = candidateExclusionClosure(
      Array.from(failedIds),
      context.dependencies
    );
    const retryStatus: ReleaseBusV2CandidateStatus =
      context.train.lane === 'STAGING'
        ? 'READY_FOR_STAGING'
        : 'READY_FOR_PRODUCTION';
    const failedCandidates: ReleaseBusV2CandidateRecord[] = [];
    const blockedCandidates: ReleaseBusV2CandidateRecord[] = [];
    const returnedCandidates: ReleaseBusV2CandidateRecord[] = [];

    for (const candidate of relevantCandidates(context)) {
      const current = await this.repository.findCandidateById(candidate.id, {});
      if (!current || ['SUPERSEDED', 'CANCELLED'].includes(current.status))
        continue;
      const isAttributable = diagnosis.attributable.has(candidate.id);
      const isInteraction = diagnosis.interaction.has(candidate.id);
      const isFailed = isAttributable || isInteraction;
      const isBlocked = !isFailed && blockedIds.has(candidate.id);
      const nextStatus: ReleaseBusV2CandidateStatus = isFailed
        ? 'FAILED'
        : isBlocked
          ? 'WAITING_FOR_DEPENDENCY'
          : retryStatus;
      const holdReason = isAttributable
        ? 'Isolated exact candidate preflight failed'
        : isInteraction
          ? 'COMBINATION_FAILED: every deterministic subset passed independently'
          : isBlocked
            ? 'A required candidate failed deterministic isolation'
            : null;
      if (
        !(await this.repository.updateCandidate(
          current.id,
          current.row_version,
          { status: nextStatus, currentTrainId: null, holdReason },
          {}
        ))
      )
        throw new Error(
          `Candidate ${current.id} changed during deterministic isolation`
        );
      await this.repository.updateTrainCandidateDisposition(
        context.train.id,
        current.id,
        isAttributable
          ? 'ISOLATED_FAILURE'
          : isInteraction
            ? 'COMBINATION_FAILED'
            : isBlocked
              ? 'DEPENDENCY_EXCLUDED'
              : 'RETURNED_TO_QUEUE',
        {}
      );
      if (isFailed) failedCandidates.push(current);
      else if (isBlocked) blockedCandidates.push(current);
      else returnedCandidates.push(current);
    }

    await Promise.all([
      this.publishCandidateStatuses(
        failedCandidates,
        'failure',
        diagnosis.interaction.size > 0
          ? 'Composed interaction failed; deterministic subsets passed'
          : 'Exact candidate failure isolated by deterministic bisection'
      ),
      this.publishCandidateStatuses(
        blockedCandidates,
        'pending',
        'Waiting because an exact dependency failed isolation'
      ),
      this.publishCandidateStatuses(
        returnedCandidates,
        'pending',
        'Independent candidate returned to the next exact v2 train'
      )
    ]);
    const interaction = diagnosis.interaction.size > 0;
    await this.transitionTrain(context.train, {
      status: 'FAILED',
      failureClass: interaction ? 'INTERACTION' : 'CANDIDATE',
      failureMessage: interaction
        ? 'COMBINATION_FAILED: no individual failing subset uniquely explains the composed-code failure'
        : 'Deterministic bisection isolated the attributable candidate failure',
      recoveryMessage:
        'Failed candidates are quarantined; dependency-blocked candidates are held and independent candidates were returned to the next train',
      completedAt: Date.now()
    });
  }

  private async diagnoseKnownFailedGroup(
    context: TrainContext,
    repository: ReleaseBusV2Repository,
    candidates: readonly ReleaseBusV2CandidateRecord[],
    path: string
  ): Promise<IsolationDiagnosis> {
    if (candidates.length < 2)
      throw new Error(
        'Deterministic bisection requires at least two candidates'
      );
    const middle = Math.ceil(candidates.length / 2);
    const left = candidates.slice(0, middle);
    const right = candidates.slice(middle);
    const [leftResult, rightResult] = await Promise.all([
      this.testIsolationSubset(context, repository, left, `${path}0`),
      this.testIsolationSubset(context, repository, right, `${path}1`)
    ]);
    if (leftResult.status === 'PENDING' || rightResult.status === 'PENDING')
      return this.pendingIsolationDiagnosis();
    const terminal = [leftResult, rightResult].find(
      (result) =>
        result.status === 'FAILED' && result.failureClass !== 'CANDIDATE'
    );
    if (terminal?.status === 'FAILED')
      return {
        ...this.pendingIsolationDiagnosis(),
        pending: false,
        terminalFailure: {
          failureClass: terminal.failureClass,
          message: terminal.message
        }
      };
    if (leftResult.status === 'PASSED' && rightResult.status === 'PASSED')
      return {
        ...this.pendingIsolationDiagnosis(),
        pending: false,
        interaction: new Set(candidates.map(({ id }) => id))
      };

    const diagnoses: IsolationDiagnosis[] = [];
    if (leftResult.status === 'FAILED')
      diagnoses.push(
        left.length === 1
          ? this.attributableIsolationDiagnosis(left[0].id)
          : await this.diagnoseKnownFailedGroup(
              context,
              repository,
              left,
              `${path}0`
            )
      );
    else diagnoses.push(this.passedIsolationDiagnosis(left));
    if (rightResult.status === 'FAILED')
      diagnoses.push(
        right.length === 1
          ? this.attributableIsolationDiagnosis(right[0].id)
          : await this.diagnoseKnownFailedGroup(
              context,
              repository,
              right,
              `${path}1`
            )
      );
    else diagnoses.push(this.passedIsolationDiagnosis(right));
    return this.mergeIsolationDiagnoses(diagnoses);
  }

  private async testIsolationSubset(
    context: TrainContext,
    repository: ReleaseBusV2Repository,
    candidates: readonly ReleaseBusV2CandidateRecord[],
    path: string
  ): Promise<IsolationSubsetResult> {
    const train = context.train;
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) throw new Error(`Missing ${repository} isolation base SHA`);
    if (
      candidates.length === 1 &&
      canUseSingleCandidateFastPath(candidates[0], baseSha)
    )
      return { status: 'PASSED' };
    const branch = `release-bus-v2/${laneBranchSegment(train.lane)}-train-${train.id}-isolation-${repository}-${path}`;
    const compose = await releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(
        train.id,
        `isolate:${repository}:${path}:compose`
      ),
      trainId: train.id,
      operationType: `ISOLATE_COMPOSE_${repository.toUpperCase()}`,
      repository,
      workflow: 'release-bus-v2-compose.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: baseSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: this.isolationRevision(path),
        operation_key: 'replaced-by-reconciler',
        base_sha: baseSha,
        expected_sha: baseSha,
        candidate_shas: JSON.stringify(
          candidates.map(({ head_sha }) => head_sha)
        ),
        release_branch: branch
      }
    });
    if (compose.status === 'FAILED')
      return {
        status: 'FAILED',
        failureClass: compose.failure_class ?? 'CONTROL_PLANE',
        message: compose.failure_message ?? 'Isolation composition failed'
      };
    if (compose.status !== 'SUCCEEDED') return { status: 'PENDING' };
    const composition = parseStoredJson<{
      summary?: { composed_sha?: string; excluded_shas?: string[] };
    }>(compose.result_json);
    const composedSha = composition?.summary?.composed_sha;
    if (!composedSha || !/^[a-f0-9]{40}$/.test(composedSha))
      return {
        status: 'FAILED',
        failureClass: 'CONTROL_PLANE',
        message: 'Isolation composition omitted its exact composed SHA'
      };
    if ((composition?.summary?.excluded_shas?.length ?? 0) > 0)
      return {
        status: 'FAILED',
        failureClass: 'CANDIDATE',
        message: 'Isolation subset conflicted with its exact base'
      };
    const graph = repository === 'backend' ? backendGraph(candidates) : null;
    const preflight = await releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(
        train.id,
        `isolate:${repository}:${path}:preflight`
      ),
      trainId: train.id,
      operationType: `ISOLATE_PREFLIGHT_${repository.toUpperCase()}`,
      repository,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: composedSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: this.isolationRevision(path),
        operation_key: 'replaced-by-reconciler',
        source_ref: branch,
        expected_sha: composedSha,
        deploy_units: JSON.stringify(graph?.units ?? []),
        reuse_artifact_run_id: '',
        reuse_artifact_name: '',
        reuse_artifact_digest: '',
        ...(repository === 'frontend'
          ? {
              artifact_environment:
                train.lane === 'STAGING' ? 'staging' : 'production'
            }
          : {})
      },
      maxAttempts: 3
    });
    if (preflight.status === 'SUCCEEDED') return { status: 'PASSED' };
    if (preflight.status !== 'FAILED') return { status: 'PENDING' };
    return {
      status: 'FAILED',
      failureClass: preflight.failure_class ?? 'CONTROL_PLANE',
      message: preflight.failure_message ?? 'Isolation preflight failed'
    };
  }

  private isolationRevision(path: string): string {
    if (!/^[01]{1,8}$/.test(path))
      throw new Error('Invalid deterministic isolation path');
    return String(500_000 + Number.parseInt(`1${path}`, 2));
  }

  private pendingIsolationDiagnosis(): IsolationDiagnosis {
    return {
      pending: true,
      attributable: new Set(),
      interaction: new Set(),
      passed: new Set(),
      terminalFailure: null
    };
  }

  private attributableIsolationDiagnosis(
    candidateId: string
  ): IsolationDiagnosis {
    return {
      ...this.pendingIsolationDiagnosis(),
      pending: false,
      attributable: new Set([candidateId])
    };
  }

  private passedIsolationDiagnosis(
    candidates: readonly ReleaseBusV2CandidateRecord[]
  ): IsolationDiagnosis {
    return {
      ...this.pendingIsolationDiagnosis(),
      pending: false,
      passed: new Set(candidates.map(({ id }) => id))
    };
  }

  private mergeIsolationDiagnoses(
    diagnoses: readonly IsolationDiagnosis[]
  ): IsolationDiagnosis {
    return {
      pending: diagnoses.some(({ pending }) => pending),
      attributable: new Set(
        diagnoses.flatMap(({ attributable }) => Array.from(attributable))
      ),
      interaction: new Set(
        diagnoses.flatMap(({ interaction }) => Array.from(interaction))
      ),
      passed: new Set(diagnoses.flatMap(({ passed }) => Array.from(passed))),
      terminalFailure:
        diagnoses.find(({ terminalFailure }) => terminalFailure)
          ?.terminalFailure ?? null
    };
  }

  private async applyCompositionExclusions(
    context: TrainContext,
    operation: ReleaseBusV2OperationRecord
  ): Promise<boolean> {
    const result = parseStoredJson<{
      summary?: { excluded_shas?: string[] };
    }>(operation.result_json);
    const excludedShas = new Set(result?.summary?.excluded_shas ?? []);
    if (excludedShas.size === 0) return false;
    const directlyExcluded = context.candidates
      .filter((candidate) => excludedShas.has(candidate.head_sha))
      .map(({ id }) => id);
    const closure = candidateExclusionClosure(
      directlyExcluded,
      context.dependencies
    );
    for (const candidateId of Array.from(closure)) {
      const candidate = context.candidates.find(({ id }) => id === candidateId);
      if (!candidate) continue;
      await this.repository.updateTrainCandidateDisposition(
        context.train.id,
        candidate.id,
        directlyExcluded.includes(candidate.id)
          ? 'NEEDS_REBASE'
          : 'DEPENDENCY_EXCLUDED',
        {}
      );
      const current = await this.repository.findCandidateById(candidate.id, {});
      if (!current || ['SUPERSEDED', 'CANCELLED'].includes(current.status))
        continue;
      await this.repository.updateCandidate(
        current.id,
        current.row_version,
        {
          status: directlyExcluded.includes(candidate.id)
            ? 'NEEDS_REBASE'
            : 'WAITING_FOR_DEPENDENCY',
          currentTrainId: null,
          holdReason: directlyExcluded.includes(candidate.id)
            ? 'Merge conflict against the exact current base'
            : 'A required candidate needs rebase'
        },
        {}
      );
    }
    await Promise.all(
      relevantCandidates(context)
        .filter((candidate) => closure.has(candidate.id))
        .map((candidate) =>
          releaseBusGitHubApp.ensureCommitStatus(
            candidate.repository,
            candidate.head_sha,
            directlyExcluded.includes(candidate.id) ? 'failure' : 'pending',
            directlyExcluded.includes(candidate.id)
              ? 'Exact composition conflicted; rebase is required'
              : 'Waiting because an exact prerequisite needs rebase',
            'Release Bus v2'
          )
        )
    );
    return true;
  }

  private async advanceStagingOrQualification(
    context: TrainContext
  ): Promise<void> {
    const train = context.train;
    const requiresIdleHandshake = [
      'PREPARED',
      'WAITING_FOR_ENVIRONMENT'
    ].includes(train.status);
    const requiresBetaIdleHandshake =
      getReleaseBusV2Mode() === 'OFF' && requiresIdleHandshake;
    const workflowFenceStartedAt = requiresBetaIdleHandshake
      ? Date.now()
      : null;
    const beforeLock = requiresIdleHandshake
      ? await this.captureStagingIdleSnapshot()
      : null;
    if (requiresIdleHandshake && !beforeLock) {
      if (train.status === 'PREPARED')
        await this.transitionTrain(train, {
          status: 'WAITING_FOR_ENVIRONMENT',
          recoveryMessage: requiresBetaIdleHandshake
            ? 'Operator beta is waiting for an idle shared staging deployment, E2E, and ref handshake'
            : 'Waiting for an idle shared staging deployment, E2E, and ref handshake'
        });
      return;
    }
    const lease = await this.acquireEnvironmentLease(
      'staging-environment',
      train
    );
    if (!lease) {
      if (train.status === 'PREPARED')
        await this.transitionTrain(train, {
          status: 'WAITING_FOR_ENVIRONMENT',
          recoveryMessage:
            'Artifacts are ready; waiting for staging deployment and E2E ownership'
        });
      return;
    }
    let environmentBinding: StagingEnvironmentBinding | null = null;
    if (requiresIdleHandshake && beforeLock) {
      let afterLock: StagingIdleSnapshot | null;
      try {
        afterLock = await this.captureStagingIdleSnapshot();
      } catch (error) {
        await this.releaseEnvironmentLease('staging-environment', lease);
        throw error;
      }
      if (
        !afterLock ||
        afterLock.frontend_staging_sha !== beforeLock.frontend_staging_sha ||
        afterLock.backend_staging_sha !== beforeLock.backend_staging_sha
      ) {
        await this.releaseEnvironmentLease('staging-environment', lease);
        if (train.status === 'PREPARED') {
          await this.transitionTrain(train, {
            status: 'WAITING_FOR_ENVIRONMENT',
            recoveryMessage:
              'Shared staging changed during the beta idle handshake; lock released without mutation'
          });
        }
        // WAITING_FOR_ENVIRONMENT re-entry must never fall through without a
        // stable snapshot and an owned lease.
        return;
      }
      if (!afterLock.frontend_staging_sha || !afterLock.backend_staging_sha) {
        await this.releaseEnvironmentLease('staging-environment', lease);
        await this.failTrain(
          train,
          'CONTROL_PLANE',
          'Shared staging has no exact frontend or backend ref identity'
        );
        return;
      }
      environmentBinding = this.bindStagingEnvironmentIdentity(
        context,
        afterLock
      );
      if (!environmentBinding) {
        await this.releaseEnvironmentLease('staging-environment', lease);
        if (train.status === 'PREPARED') {
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'PRODUCTION_QUALIFICATION_ENVIRONMENT_HOLD',
              actor: 'release-bus-v2',
              payload: {
                target_frontend_sha: train.frontend_composed_sha,
                target_backend_sha: train.backend_composed_sha,
                staging_frontend_sha: afterLock.frontend_staging_sha,
                staging_backend_sha: afterLock.backend_staging_sha
              }
            },
            {}
          );
          await this.transitionTrain(train, {
            status: 'WAITING_FOR_ENVIRONMENT',
            recoveryMessage:
              'Exact production qualification is waiting for unchanged repositories in staging to match the production target manifest'
          });
        }
        // A held qualification remains waiting and retries from a fresh
        // snapshot; it must never advance without an environment binding.
        return;
      }
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'STAGING_ENVIRONMENT_IDENTITY_BOUND',
          actor: 'release-bus-v2',
          payload: {
            lane: train.lane,
            target_frontend_sha: train.frontend_composed_sha,
            target_backend_sha: train.backend_composed_sha,
            staging_frontend_sha: afterLock.frontend_staging_sha,
            staging_backend_sha: afterLock.backend_staging_sha,
            frontend_sha: environmentBinding.frontendSha,
            backend_sha: environmentBinding.backendSha,
            frontend_from_existing_staging:
              environmentBinding.frontendFromExistingStaging,
            backend_from_existing_staging:
              environmentBinding.backendFromExistingStaging
          }
        },
        {}
      );
      if (requiresBetaIdleHandshake) {
        await this.repository.appendEvent(
          {
            trainId: train.id,
            eventType: 'BETA_STAGING_IDLE_HANDSHAKE',
            actor: 'release-bus-v2-beta',
            payload: {
              ...afterLock,
              beta_test_id: getReleaseBusV2BetaAllowlist()[0]?.test_id,
              staging_lock: 'owned',
              workflow_fence_started_at: workflowFenceStartedAt,
              verified_at: Date.now()
            }
          },
          {}
        );
      }
    }
    const sourceTrainId = train.parent_train_id ?? train.id;
    if (['PREPARED', 'WAITING_FOR_ENVIRONMENT'].includes(train.status)) {
      if (train.lane === 'STAGING')
        await this.updateCandidateStatuses(
          relevantCandidates(context),
          candidateStatusForDeploy(train.lane),
          train.id
        );
      await this.transitionTrain(train, {
        status: 'DEPLOYING',
        frontendComposedSha: environmentBinding?.frontendSha,
        backendComposedSha: environmentBinding?.backendSha,
        recoveryMessage:
          'Staging ownership acquired; exact immutable artifacts are deploying'
      });
      return;
    }
    if (train.status === 'DEPLOYING') {
      const deployed = await this.reconcileDeployments(
        context,
        'staging',
        sourceTrainId
      );
      if (deployed.failedOperation) {
        await this.failTrain(
          train,
          deployed.failedOperation.failure_class ?? 'DEPLOYMENT',
          deployed.failedOperation.failure_message ??
            'Staging deployment failed',
          lease
        );
        return;
      }
      if (!deployed.complete) return;
      const manifest = await this.createManifest(
        context,
        sourceTrainId,
        deployed.operations,
        'STAGING_DEPLOYED'
      );
      if (train.lane === 'STAGING')
        await this.updateCandidateStatuses(
          relevantCandidates(context),
          'STAGING_DEPLOYED',
          train.id
        );
      await this.transitionTrain(train, {
        status: 'STAGING_DEPLOYED',
        manifestId: manifest.id,
        recoveryMessage:
          'Exact deployment is complete; staging remains locked for E2E'
      });
      return;
    }
    if (train.status === 'STAGING_DEPLOYED') {
      const e2e = await this.reconcileE2E(context, 'staging');
      if (e2e.status === 'FAILED') {
        await this.failTrain(
          train,
          e2e.failure_class ?? 'E2E',
          e2e.failure_message ?? 'Staging E2E failed',
          lease
        );
        return;
      }
      if (train.lane === 'STAGING')
        await this.updateCandidateStatuses(
          relevantCandidates(context),
          'STAGING_VALIDATING',
          train.id
        );
      await this.transitionTrain(train, {
        status: 'E2E_RUNNING',
        recoveryMessage:
          'Staging is frozen at the manifest while E2E is running'
      });
      return;
    }
    if (train.status === 'E2E_RUNNING') {
      const e2e = await this.reconcileE2E(context, 'staging');
      if (e2e.status === 'FAILED') {
        await this.failTrain(
          train,
          e2e.failure_class ?? 'E2E',
          e2e.failure_message ?? 'Staging E2E failed',
          lease
        );
        return;
      }
      if (e2e.status !== 'SUCCEEDED') return;
      if (getReleaseBusV2Mode() === 'OFF') {
        const handshake = await this.findStagingIdleHandshake(train.id);
        if (!handshake) {
          if (train.manifest_id)
            await this.repository.updateManifestStatus(
              train.manifest_id,
              'FAILED',
              e2e.external_id,
              {}
            );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'BETA_STAGING_FINAL_FENCE_MISSING',
              actor: 'release-bus-v2-beta',
              payload: { e2e_run_id: e2e.external_id }
            },
            {}
          );
          await this.failTrain(
            train,
            'CONTROL_PLANE',
            'Beta staging idle-handshake evidence is missing or malformed; successful E2E cannot be accepted without an end-to-end fence',
            lease
          );
          return;
        }
        const operationRunIds = (
          await this.repository.listOperations(train.id, {})
        )
          .map(({ external_id }) => external_id)
          .filter((runId): runId is string => runId !== null);
        const currentSnapshot = await this.captureStagingIdleSnapshot({
          since: handshake.workflow_fence_started_at,
          ignoredRunIds: operationRunIds
        });
        const stable =
          currentSnapshot !== null &&
          currentSnapshot.frontend_staging_sha ===
            handshake.frontend_staging_sha &&
          currentSnapshot.backend_staging_sha === handshake.backend_staging_sha;
        if (!stable) {
          if (train.manifest_id)
            await this.repository.updateManifestStatus(
              train.manifest_id,
              'FAILED',
              e2e.external_id,
              {}
            );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'BETA_STAGING_FINAL_FENCE_VIOLATED',
              actor: 'release-bus-v2-beta',
              payload: {
                handshake,
                current_snapshot: currentSnapshot,
                ignored_train_run_ids: operationRunIds
              }
            },
            {}
          );
          await this.failTrain(
            train,
            'CONTROL_PLANE',
            'Shared staging refs or deploy/E2E workflows changed after the beta idle handshake; successful E2E cannot validate a mixed environment',
            lease
          );
          return;
        }
        await this.repository.appendEvent(
          {
            trainId: train.id,
            eventType: 'BETA_STAGING_FINAL_FENCE_VERIFIED',
            actor: 'release-bus-v2-beta',
            payload: {
              ...currentSnapshot,
              handshake_verified_at: handshake.verified_at,
              verified_at: Date.now()
            }
          },
          {}
        );
      }
      if (train.manifest_id)
        await this.repository.updateManifestStatus(
          train.manifest_id,
          'STAGING_VALIDATED',
          e2e.external_id,
          {}
        );
      if (train.lane === 'STAGING') {
        await this.markStagingValidated(context, train.manifest_id);
      }
      await this.transitionTrain(train, {
        status: 'STAGING_VALIDATED',
        completedAt: Date.now(),
        recoveryMessage:
          train.lane === 'PRODUCTION_QUALIFICATION'
            ? 'Exact production subset qualified in staging'
            : 'Exact staging manifest validated; production remains explicit'
      });
      await this.releaseEnvironmentLease('staging-environment', lease);
    }
  }

  private bindStagingEnvironmentIdentity(
    context: TrainContext,
    snapshot: StagingIdleSnapshot
  ): StagingEnvironmentBinding | null {
    const train = context.train;
    const frontendTarget = train.frontend_composed_sha;
    const backendTarget = train.backend_composed_sha;
    const frontendStaging = snapshot.frontend_staging_sha;
    const backendStaging = snapshot.backend_staging_sha;
    if (
      !frontendTarget ||
      !backendTarget ||
      !frontendStaging ||
      !backendStaging
    )
      throw new Error('Staging environment identity is incomplete');
    const hasFrontend = relevantCandidates(context, 'frontend').length > 0;
    const hasBackend = relevantCandidates(context, 'backend').length > 0;
    if (train.lane === 'PRODUCTION_QUALIFICATION') {
      // Candidate-bearing repositories are about to be deployed to their
      // composed targets. Only unchanged counterparts must already match the
      // exact production target before qualification can own staging.
      if (!hasFrontend && frontendStaging !== frontendTarget) return null;
      if (!hasBackend && backendStaging !== backendTarget) return null;
    }
    return {
      frontendSha:
        train.lane === 'STAGING' && !hasFrontend
          ? frontendStaging
          : frontendTarget,
      backendSha:
        train.lane === 'STAGING' && !hasBackend
          ? backendStaging
          : backendTarget,
      frontendFromExistingStaging: train.lane === 'STAGING' && !hasFrontend,
      backendFromExistingStaging: train.lane === 'STAGING' && !hasBackend
    };
  }

  private async captureStagingIdleSnapshot(fence?: {
    readonly since: number;
    readonly ignoredRunIds: readonly string[];
  }): Promise<StagingIdleSnapshot | null> {
    const [frontendActive, backendActive, frontendSha, backendSha] =
      await Promise.all([
        fence
          ? releaseBusGitHubApp.hasStagingMutationOrE2ERunSince(
              'frontend',
              fence.since,
              fence.ignoredRunIds
            )
          : releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun('frontend'),
        fence
          ? releaseBusGitHubApp.hasStagingMutationOrE2ERunSince(
              'backend',
              fence.since,
              fence.ignoredRunIds
            )
          : releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun('backend'),
        releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
        releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
      ]);
    if (frontendActive || backendActive) return null;
    return {
      frontend_staging_sha: frontendSha,
      backend_staging_sha: backendSha
    };
  }

  private async findStagingIdleHandshake(
    trainId: string
  ): Promise<StagingIdleHandshakeSnapshot | null> {
    const event = (await this.repository.listEvents(trainId, 200, {})).find(
      ({ event_type }) => event_type === 'BETA_STAGING_IDLE_HANDSHAKE'
    );
    if (!event) return null;
    let payload: Partial<StagingIdleHandshakeSnapshot> | null;
    try {
      payload = parseStoredJson<Partial<StagingIdleHandshakeSnapshot>>(
        event.payload_json
      );
    } catch {
      return null;
    }
    if (
      !payload ||
      !Number.isInteger(payload.workflow_fence_started_at) ||
      Number(payload.workflow_fence_started_at) < 1 ||
      !Number.isInteger(payload.verified_at) ||
      Number(payload.verified_at) < 1 ||
      Number(payload.workflow_fence_started_at) > Number(payload.verified_at) ||
      !this.isOptionalSha(payload.frontend_staging_sha) ||
      !this.isOptionalSha(payload.backend_staging_sha)
    )
      return null;
    return {
      workflow_fence_started_at: Number(payload.workflow_fence_started_at),
      verified_at: Number(payload.verified_at),
      frontend_staging_sha: payload.frontend_staging_sha ?? null,
      backend_staging_sha: payload.backend_staging_sha ?? null
    };
  }

  private isOptionalSha(value: unknown): value is string | null | undefined {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value))
    );
  }

  private async advanceProduction(context: TrainContext): Promise<void> {
    const train = context.train;
    if (train.status === 'PREPARED') {
      const exact = await this.repository.findValidatedManifestByRelease(
        train.frontend_composed_sha,
        train.backend_composed_sha,
        relevantCandidates(context, 'frontend').length
          ? train.frontend_artifact_digest
          : null,
        relevantCandidates(context, 'backend').length
          ? train.backend_artifact_digest
          : null,
        {}
      );
      if (exact) {
        await this.transitionTrain(train, {
          status: 'MERGING_PRODUCTION',
          manifestId: exact.id,
          recoveryMessage:
            'Exact staging validation and immutable artifacts are being reused'
        });
        return;
      }
      const qualification = await this.repository.createQualificationTrain(
        {
          parentTrainId: train.id,
          frontendBaseSha: train.frontend_base_sha ?? '',
          backendBaseSha: train.backend_base_sha ?? '',
          frontendComposedSha: train.frontend_composed_sha,
          backendComposedSha: train.backend_composed_sha,
          frontendArtifactDigest: train.frontend_artifact_digest,
          backendArtifactDigest: train.backend_artifact_digest,
          candidateIds: relevantCandidates(context).map(({ id }) => id)
        },
        {}
      );
      await this.transitionTrain(train, {
        status: 'WAITING_FOR_ENVIRONMENT',
        qualificationTrainId: qualification.id,
        recoveryMessage:
          'This explicit production subset differs from validated staging and is queued for exact qualification'
      });
      return;
    }
    if (train.status === 'WAITING_FOR_ENVIRONMENT') {
      if (!train.qualification_train_id)
        throw new Error('Production train lost its qualification identity');
      const qualification = await this.repository.findTrain(
        train.qualification_train_id,
        {}
      );
      if (!qualification) throw new Error('Qualification train does not exist');
      if (qualification.status === 'FAILED') {
        // The qualification train already classified/requeued or quarantined
        // the exact candidates. Preserve that result instead of overwriting it
        // from the waiting parent production train.
        await this.transitionTrain(train, {
          status: 'FAILED',
          failureClass: qualification.failure_class ?? 'E2E',
          failureMessage:
            qualification.failure_message ?? 'Production qualification failed',
          recoveryMessage:
            qualification.recovery_message ??
            'Exact production qualification failed; candidate states were preserved',
          completedAt: Date.now()
        });
        return;
      }
      if (qualification.status !== 'STAGING_VALIDATED') return;
      await this.transitionTrain(train, {
        status: 'MERGING_PRODUCTION',
        manifestId: qualification.manifest_id,
        recoveryMessage:
          'The explicit production subset passed exact staging qualification'
      });
      return;
    }

    const requiresBetaIdleHandshake =
      getReleaseBusV2Mode() === 'OFF' && train.status === 'MERGING_PRODUCTION';
    const beforeLock = requiresBetaIdleHandshake
      ? await this.captureProductionIdleSnapshot()
      : null;
    if (requiresBetaIdleHandshake && !beforeLock) return;
    const lease = await this.acquireEnvironmentLease(
      'production-environment',
      train
    );
    if (!lease) return;
    if (requiresBetaIdleHandshake && beforeLock) {
      let afterLock: ProductionIdleSnapshot | null;
      try {
        afterLock = await this.captureProductionIdleSnapshot();
      } catch (error) {
        await this.releaseEnvironmentLease('production-environment', lease);
        throw error;
      }
      const stable =
        afterLock !== null &&
        afterLock.frontend_main_sha === beforeLock.frontend_main_sha &&
        afterLock.backend_main_sha === beforeLock.backend_main_sha;
      if (!stable) {
        await this.releaseEnvironmentLease('production-environment', lease);
        return;
      }
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'BETA_PRODUCTION_IDLE_HANDSHAKE',
          actor: 'release-bus-v2-beta',
          payload: {
            ...afterLock,
            beta_test_id: getReleaseBusV2BetaAllowlist()[0]?.test_id,
            production_lock: 'owned',
            verified_at: Date.now()
          }
        },
        {}
      );
    }
    if (train.status === 'MERGING_PRODUCTION') {
      await this.advanceProductionRefs(context);
      await this.updateCandidateStatuses(
        relevantCandidates(context),
        'PRODUCTION_DEPLOYING',
        train.id
      );
      await this.transitionTrain(train, {
        status: 'PRODUCTION_DEPLOYING',
        recoveryMessage:
          'Exact qualified composition is on main; immutable artifacts are deploying'
      });
      return;
    }
    if (train.status === 'PRODUCTION_DEPLOYING') {
      const sourceTrainId = await this.artifactSourceTrainId(train);
      const deployed = await this.reconcileDeployments(
        context,
        'prod',
        sourceTrainId
      );
      if (deployed.failedOperation) {
        await this.failTrain(
          train,
          deployed.failedOperation.failure_class ?? 'DEPLOYMENT',
          deployed.failedOperation.failure_message ??
            'Production deployment failed',
          lease
        );
        return;
      }
      if (!deployed.complete) return;
      const e2e = await this.reconcileE2E(context, 'prod');
      if (e2e.status === 'FAILED') {
        await this.failTrain(
          train,
          e2e.failure_class ?? 'E2E',
          e2e.failure_message ?? 'Production E2E failed',
          lease
        );
        return;
      }
      if (e2e.status !== 'SUCCEEDED') return;
      const manifest = await this.createManifest(
        context,
        sourceTrainId,
        [...deployed.operations, e2e],
        'PRODUCTION_DEPLOYED'
      );
      await this.updateCandidateStatuses(
        relevantCandidates(context),
        'PRODUCTION_DEPLOYED',
        null
      );
      await this.transitionTrain(train, {
        status: 'PRODUCTION_DEPLOYED',
        manifestId: manifest.id,
        completedAt: Date.now(),
        recoveryMessage:
          'Exact explicit production subset deployed and verified'
      });
      await this.releaseEnvironmentLease('production-environment', lease);
      await this.publishCandidateStatuses(
        relevantCandidates(context),
        'success',
        'Exact v2 production deployment completed'
      );
    }
  }

  private async captureProductionIdleSnapshot(): Promise<ProductionIdleSnapshot | null> {
    const [frontendActive, backendActive, frontendSha, backendSha] =
      await Promise.all([
        releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun('frontend'),
        releaseBusGitHubApp.hasActiveProductionMutationOrE2ERun('backend'),
        releaseBusGitHubApp.resolveRef('frontend', 'main'),
        releaseBusGitHubApp.resolveRef('backend', 'main')
      ]);
    if (frontendActive || backendActive) return null;
    return {
      frontend_main_sha: frontendSha,
      backend_main_sha: backendSha
    };
  }

  private async advanceProductionRefs(context: TrainContext): Promise<void> {
    const train = context.train;
    const repositories = (['backend', 'frontend'] as const).filter(
      (repository) => relevantCandidates(context, repository).length > 0
    );
    const current = await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        sha: await releaseBusGitHubApp.resolveRef(repository, 'main')
      }))
    );
    const invalid = current.filter((item) => {
      const base =
        item.repository === 'frontend'
          ? train.frontend_base_sha
          : train.backend_base_sha;
      const composed =
        item.repository === 'frontend'
          ? train.frontend_composed_sha
          : train.backend_composed_sha;
      return item.sha !== base && item.sha !== composed;
    });
    if (invalid.length > 0) {
      const moved = invalid[0];
      const base =
        moved.repository === 'frontend'
          ? train.frontend_base_sha
          : train.backend_base_sha;
      const message = `${moved.repository} main moved from ${base} to ${moved.sha}; production composition must be rebuilt and requalified`;
      const alreadyAdvanced = current.some((item) => {
        const composed =
          item.repository === 'frontend'
            ? train.frontend_composed_sha
            : train.backend_composed_sha;
        return item.sha === composed;
      });
      if (alreadyAdvanced)
        throw new Error(
          `${message}; another repository was already advanced, so automation paused for exact manual reconciliation`
        );
      throw new MainMovedError(message);
    }
    for (const item of current)
      await this.advanceMainRef(train, item.repository, item.sha);
  }

  private async advanceMainRef(
    train: ReleaseBusV2TrainRecord,
    repository: ReleaseBusV2Repository,
    observedSha: string
  ): Promise<void> {
    const key = operationKey(train.id, `advance-main:${repository}`);
    let operation = await this.repository.getOrCreateOperation(
      {
        idempotencyKey: key,
        trainId: train.id,
        operationType: `ADVANCE_MAIN_${repository.toUpperCase()}`,
        repository,
        service: null,
        environment: 'prod',
        expectedSha:
          repository === 'frontend'
            ? train.frontend_composed_sha
            : train.backend_composed_sha,
        artifactDigest: null,
        request: {
          expected_old_sha:
            repository === 'frontend'
              ? train.frontend_base_sha
              : train.backend_base_sha
        },
        maxAttempts: 1
      },
      {}
    );
    if (operation.status === 'SUCCEEDED') return;
    const base =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    const composed =
      repository === 'frontend'
        ? train.frontend_composed_sha
        : train.backend_composed_sha;
    if (!base || !composed)
      throw new Error(`Missing ${repository} release SHA`);
    if (observedSha === base)
      await releaseBusGitHubApp.updateRef(repository, 'main', base, composed);
    else if (observedSha !== composed)
      throw new MainMovedError(
        `${repository} main moved from ${base} to ${observedSha}`
      );
    if (
      !(await this.repository.updateOperation(
        operation.id,
        operation.row_version,
        {
          status: 'SUCCEEDED',
          externalId: composed,
          result: { base_sha: base, deployed_sha: composed },
          completedAt: Date.now()
        },
        {}
      ))
    )
      throw new Error(`${repository} main operation changed concurrently`);
    operation = (await this.repository.findOperation(key, {})) ?? operation;
  }

  private async reconcileDeployments(
    context: TrainContext,
    environment: 'staging' | 'prod',
    artifactSourceTrainId: string
  ): Promise<DeployResult> {
    const train = context.train;
    const source = await this.artifactSource(artifactSourceTrainId);
    const backendCandidates = relevantCandidates(context, 'backend');
    const graph = backendGraph(backendCandidates);
    const operations: ReleaseBusV2OperationRecord[] = [];
    let backendComplete = graph.units.length === 0;
    for (const layer of graph.layers) {
      const earlier = graph.layers.slice(0, graph.layers.indexOf(layer)).flat();
      const earlierOperations = await this.repository.listOperations(
        train.id,
        {}
      );
      if (
        !earlier.every((unit) =>
          earlierOperations.some(
            (operation) =>
              operation.operation_type ===
                `DEPLOY_BACKEND_${environment.toUpperCase()}_${unit}` &&
              operation.status === 'SUCCEEDED'
          )
        )
      )
        break;
      const layerResults = await Promise.all(
        layer.map((unit) =>
          this.reconcileBackendDeploy(
            train,
            environment,
            artifactSourceTrainId,
            source.backendRunId,
            unit,
            backendCandidates
          )
        )
      );
      operations.push(...layerResults);
      const failed = layerResults.find(({ status }) => status === 'FAILED');
      if (failed)
        return { complete: false, failedOperation: failed, operations };
      if (layerResults.some(({ status }) => status !== 'SUCCEEDED')) break;
      if (layer === graph.layers.at(-1)) backendComplete = true;
    }

    const frontendCandidates = relevantCandidates(context, 'frontend');
    let frontendComplete = frontendCandidates.length === 0;
    if (
      frontendCandidates.length > 0 &&
      (!frontendDependsOnBackend(context) || backendComplete)
    ) {
      const frontend = await this.reconcileFrontendDeploy(
        train,
        environment,
        artifactSourceTrainId,
        source.frontendRunId
      );
      operations.push(frontend);
      if (frontend.status === 'FAILED')
        return { complete: false, failedOperation: frontend, operations };
      frontendComplete = frontend.status === 'SUCCEEDED';
    }
    return {
      complete: backendComplete && frontendComplete,
      failedOperation: null,
      operations
    };
  }

  private async reconcileBackendDeploy(
    train: ReleaseBusV2TrainRecord,
    environment: 'staging' | 'prod',
    artifactTrainId: string,
    artifactRunId: string | null,
    service: string,
    candidates: readonly ReleaseBusV2CandidateRecord[]
  ): Promise<ReleaseBusV2OperationRecord> {
    if (!artifactRunId)
      throw new Error('Missing backend artifact workflow run');
    const expectedSha = train.backend_composed_sha;
    if (!expectedSha) throw new Error('Missing backend composed SHA');
    const releaseNoteInputs = backendReleaseNoteInputs(
      candidates,
      service,
      environment
    );
    return releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(
        train.id,
        `deploy:${environment}:backend:${service}`
      ),
      trainId: train.id,
      operationType: `DEPLOY_BACKEND_${environment.toUpperCase()}_${service}`,
      repository: 'backend',
      workflow: 'deploy.yml',
      ref: 'main',
      environment,
      service,
      expectedSha,
      artifactDigest: train.backend_artifact_digest,
      inputs: {
        environment,
        service,
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        expected_sha: expectedSha,
        artifact_run_id: artifactRunId,
        artifact_train_id: artifactTrainId,
        artifact_digest: train.backend_artifact_digest ?? '',
        ...releaseNoteInputs
      }
    });
  }

  private async reconcileFrontendDeploy(
    train: ReleaseBusV2TrainRecord,
    environment: 'staging' | 'prod',
    artifactTrainId: string,
    artifactRunId: string | null
  ): Promise<ReleaseBusV2OperationRecord> {
    if (!artifactRunId)
      throw new Error('Missing frontend artifact workflow run');
    const expectedSha = train.frontend_composed_sha;
    if (!expectedSha) throw new Error('Missing frontend composed SHA');
    const workflow =
      environment === 'staging'
        ? 'release-bus-deploy-staging.yml'
        : 'release-bus-deploy-production.yml';
    return releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(train.id, `deploy:${environment}:frontend`),
      trainId: train.id,
      operationType: `DEPLOY_FRONTEND_${environment.toUpperCase()}`,
      repository: 'frontend',
      workflow,
      ref: 'main',
      environment,
      service: null,
      expectedSha,
      artifactDigest: train.frontend_artifact_digest,
      inputs: {
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref:
          environment === 'prod'
            ? 'main'
            : releaseBusV2Branch(train, 'frontend'),
        expected_sha: expectedSha,
        artifact_run_id: artifactRunId,
        artifact_train_id: artifactTrainId,
        artifact_digest: train.frontend_artifact_digest ?? '',
        artifact_environment: environment === 'prod' ? 'production' : 'staging'
      }
    });
  }

  private async reconcileE2E(
    context: TrainContext,
    environment: 'staging' | 'prod'
  ): Promise<ReleaseBusV2OperationRecord> {
    const train = context.train;
    const expectedSha = train.frontend_composed_sha ?? train.frontend_base_sha;
    if (!expectedSha) throw new Error('Missing frontend SHA for E2E tooling');
    if (!train.manifest_id)
      throw new Error('Exact release manifest is missing before E2E');
    const manifest = await this.repository.findManifest(train.manifest_id, {});
    if (!manifest)
      throw new Error('Exact release manifest does not exist before E2E');
    if (
      manifest.frontend_sha !== train.frontend_composed_sha ||
      manifest.backend_sha !== train.backend_composed_sha ||
      manifest.frontend_artifact_digest !==
        (relevantCandidates(context, 'frontend').length
          ? train.frontend_artifact_digest
          : null) ||
      manifest.backend_artifact_digest !==
        (relevantCandidates(context, 'backend').length
          ? train.backend_artifact_digest
          : null)
    )
      throw new Error('E2E manifest does not match the exact train release');
    const spec: ReleaseBusV2WorkflowSpec = {
      idempotencyKey: operationKey(train.id, `e2e:${environment}`),
      trainId: train.id,
      operationType: `E2E_${environment.toUpperCase()}`,
      repository: 'frontend',
      workflow:
        environment === 'staging' ? 'staging-e2e.yml' : 'production-e2e.yml',
      ref: 'main',
      environment,
      service: null,
      expectedSha,
      artifactDigest: manifest.identity_sha256,
      inputs: {
        pack: 'all',
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: relevantCandidates(context, 'frontend').length
          ? releaseBusV2Branch(train, 'frontend')
          : 'main',
        expected_sha: expectedSha,
        release_manifest_id: manifest.id,
        release_manifest_identity_sha256: manifest.identity_sha256,
        frontend_sha: manifest.frontend_sha ?? '',
        backend_sha: manifest.backend_sha ?? '',
        frontend_artifact_digest: manifest.frontend_artifact_digest ?? '',
        backend_artifact_digest: manifest.backend_artifact_digest ?? ''
      },
      maxAttempts: 2
    };
    return releaseBusV2Operations.reconcileWorkflow(spec);
  }

  private async artifactSource(trainId: string): Promise<ArtifactSource> {
    const operations = await this.repository.listOperations(trainId, {});
    const frontend = operations.find(
      ({ operation_type, status }) =>
        operation_type === 'PREPARE_ARTIFACT_FRONTEND' && status === 'SUCCEEDED'
    );
    const backend = operations.find(
      ({ operation_type, status }) =>
        operation_type === 'PREPARE_ARTIFACT_BACKEND' && status === 'SUCCEEDED'
    );
    return {
      trainId,
      frontendRunId: frontend?.external_id ?? null,
      backendRunId: backend?.external_id ?? null
    };
  }

  private async artifactSourceTrainId(
    train: ReleaseBusV2TrainRecord
  ): Promise<string> {
    if (!train.manifest_id) return train.id;
    const manifest = await this.repository.findManifest(train.manifest_id, {});
    const body = parseStoredJson<{ artifact_source_train_id?: string }>(
      manifest?.manifest_json ?? null
    );
    return body?.artifact_source_train_id ?? manifest?.train_id ?? train.id;
  }

  private async createManifest(
    context: TrainContext,
    artifactSourceTrainId: string,
    operations: readonly ReleaseBusV2OperationRecord[],
    status: ReleaseBusV2ManifestStatus
  ): Promise<ReleaseBusV2ManifestRecord> {
    const train = context.train;
    const hasFrontend = relevantCandidates(context, 'frontend').length > 0;
    const hasBackend = relevantCandidates(context, 'backend').length > 0;
    const identity = {
      train_id: train.id,
      lane: train.lane,
      scope: status === 'PRODUCTION_DEPLOYED' ? 'production' : 'staging',
      // The manifest is the exact environment identity used by E2E, not only
      // the changed subset. Preparation always resolves both repositories to
      // either their composed tree or their unchanged base tree.
      frontend_sha: train.frontend_composed_sha,
      backend_sha: train.backend_composed_sha,
      frontend_artifact_digest: hasFrontend
        ? train.frontend_artifact_digest
        : null,
      backend_artifact_digest: hasBackend
        ? train.backend_artifact_digest
        : null,
      candidates: relevantCandidates(context).map(
        ({ repository, pr_number, head_sha }) => ({
          repository,
          pr_number,
          head_sha
        })
      )
    };
    const manifestJson = {
      schema_version: 2,
      ...identity,
      artifact_source_train_id: artifactSourceTrainId,
      train_id: train.id,
      lane: train.lane,
      backend_graph: backendGraph(relevantCandidates(context, 'backend')),
      operations: operations.map((operation) => ({
        type: operation.operation_type,
        service: operation.service,
        expected_sha: operation.expected_sha,
        artifact_digest: operation.artifact_digest,
        workflow_run_id: operation.external_id,
        started_at: operation.started_at,
        completed_at: operation.completed_at
      })),
      timings_ms: {
        queued_to_manifest: Date.now() - Number(train.created_at),
        current_phase: Date.now() - Number(train.phase_started_at)
      }
    };
    return this.repository.createManifest(
      {
        train_id: train.id,
        lane: train.lane,
        identity_sha256: sha256(identity),
        status,
        frontend_sha: identity.frontend_sha,
        backend_sha: identity.backend_sha,
        frontend_artifact_digest: identity.frontend_artifact_digest,
        backend_artifact_digest: identity.backend_artifact_digest,
        e2e_run_id: null,
        manifest_json: manifestJson,
        deployed_at: Date.now(),
        validated_at: null
      },
      {}
    );
  }

  private async markStagingValidated(
    context: TrainContext,
    manifestId: string | null
  ): Promise<void> {
    if (!manifestId) throw new Error('Staging validation has no manifest');
    for (const candidate of relevantCandidates(context)) {
      const current = await this.repository.findCandidateById(candidate.id, {});
      if (!current || ['SUPERSEDED', 'CANCELLED'].includes(current.status))
        continue;
      await this.repository.updateCandidate(
        current.id,
        current.row_version,
        {
          status: 'STAGING_VALIDATED',
          currentTrainId: null,
          stagingValidatedTrainId: context.train.id,
          stagingValidatedManifestId: manifestId,
          holdReason: null
        },
        {}
      );
    }
    await this.publishCandidateStatuses(
      relevantCandidates(context),
      'success',
      'Exact v2 staging manifest validated; production remains explicit'
    );
  }

  private async updateCandidateStatuses(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    status: ReleaseBusV2CandidateStatus,
    currentTrainId: string | null,
    publishStatus = true
  ): Promise<void> {
    for (const candidate of candidates) {
      const current = await this.repository.findCandidateById(candidate.id, {});
      if (
        !current ||
        ['SUPERSEDED', 'CANCELLED'].includes(current.status) ||
        (current.status === status &&
          current.current_train_id === currentTrainId &&
          current.hold_reason === null)
      )
        continue;
      await this.repository.updateCandidate(
        current.id,
        current.row_version,
        { status, currentTrainId, holdReason: null },
        {}
      );
    }
    if (!publishStatus) return;
    const terminalState =
      status === 'PRODUCTION_DEPLOYED'
        ? 'success'
        : status === 'FAILED' || status === 'NEEDS_REBASE'
          ? 'failure'
          : 'pending';
    const descriptions: Partial<Record<ReleaseBusV2CandidateStatus, string>> = {
      READY_FOR_STAGING: 'Queued for exact v2 staging composition',
      STAGING_IN_TRAIN: 'Claimed by an exact v2 staging train',
      STAGING_BUILDING: 'Exact v2 composition, checks, and build are running',
      STAGING_DEPLOYING:
        'Exact immutable v2 artifacts are deploying to staging',
      STAGING_DEPLOYED: 'Exact staging deployment complete; E2E is pending',
      STAGING_VALIDATING: 'Staging is frozen for exact-manifest E2E',
      READY_FOR_PRODUCTION: 'Explicitly queued for exact v2 production',
      PRODUCTION_IN_TRAIN: 'Claimed by an explicit v2 production train',
      PRODUCTION_BUILDING_OR_QUALIFYING:
        'Exact production composition is building or qualifying',
      PRODUCTION_DEPLOYING:
        'Exact qualified artifacts are deploying to production',
      PRODUCTION_DEPLOYED: 'Exact v2 production deployment completed',
      NEEDS_REBASE: 'Exact composition conflicted; rebase is required',
      WAITING_FOR_DEPENDENCY: 'Waiting for an exact release dependency',
      FAILED: 'Release Bus v2 candidate failed'
    };
    await this.publishCandidateStatuses(
      candidates,
      terminalState,
      descriptions[status] ?? status.replace(/_/g, ' ').toLowerCase()
    );
  }

  private async transitionTrain(
    train: ReleaseBusV2TrainRecord,
    fields: Parameters<ReleaseBusV2RepositoryClass['updateTrain']>[2]
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {});
    if (!current) throw new Error('Release Bus v2 train disappeared');
    if (
      !(await this.repository.updateTrain(
        current.id,
        current.row_version,
        fields,
        {}
      ))
    )
      throw new Error('Release Bus v2 train changed concurrently');
    await this.repository.appendEvent(
      {
        trainId: current.id,
        eventType: `TRAIN_${fields.status}`,
        payload: {
          previous_status: current.status,
          failure_class: fields.failureClass ?? null,
          recovery_message: fields.recoveryMessage ?? null
        }
      },
      {}
    );
  }

  private async acquireEnvironmentLease(
    name: 'staging-environment' | 'production-environment',
    train: ReleaseBusV2TrainRecord
  ): Promise<ReleaseBusV2LockRecord | null> {
    return this.repository.acquireLock(
      name,
      train.id,
      `train:${train.id}`,
      ENVIRONMENT_LOCK_TTL_MS,
      {}
    );
  }

  private async releaseTerminalEnvironmentLocks(): Promise<void> {
    const locks = await this.repository.listLocks({});
    for (const lock of locks) {
      if (
        !lock.owner_train_id ||
        !lock.lease_token ||
        !['staging-environment', 'production-environment'].includes(lock.name)
      )
        continue;
      const train = await this.repository.findTrain(lock.owner_train_id, {});
      if (!train || !TERMINAL_TRAINS.has(train.status)) continue;
      const operations = await this.repository.listOperations(train.id, {});
      if (
        operations.some(
          (operation) => !TERMINAL_OPERATIONS.has(operation.status)
        )
      )
        continue;
      if (await this.repository.releaseLock(lock.name, lock.lease_token, {}))
        await this.repository.appendEvent(
          {
            trainId: train.id,
            eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
            actor: 'release-bus-v2',
            payload: {
              lock: lock.name,
              train_status: train.status,
              operation_count: operations.length
            }
          },
          {}
        );
    }
  }

  private async releaseEnvironmentLease(
    name: 'staging-environment' | 'production-environment',
    lease: ReleaseBusV2LockRecord
  ): Promise<void> {
    if (lease.lease_token)
      await this.repository.releaseLock(name, lease.lease_token, {});
  }

  private async failTrain(
    train: ReleaseBusV2TrainRecord,
    failureClass: ReleaseBusV2FailureClass,
    message: string,
    lease?: ReleaseBusV2LockRecord
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {});
    if (!current || TERMINAL_TRAINS.has(current.status)) return;
    const context = await this.loadContext(current);
    const retryStatus: ReleaseBusV2CandidateStatus =
      current.lane === 'STAGING' ? 'READY_FOR_STAGING' : 'READY_FOR_PRODUCTION';
    const candidateStatus = ['INFRASTRUCTURE', 'CONTROL_PLANE'].includes(
      failureClass
    )
      ? retryStatus
      : 'FAILED';
    await this.updateCandidateStatuses(
      relevantCandidates(context),
      candidateStatus,
      null,
      false
    );
    if (failureClass === 'CONTROL_PLANE') {
      await this.service.setPaused(
        'ALL',
        true,
        `Release Bus v2 control-plane failure in train ${train.id}: ${message}`,
        'release-bus-v2'
      );
    }
    await this.publishCandidateStatuses(
      relevantCandidates(context),
      failureClass === 'CONTROL_PLANE'
        ? 'error'
        : failureClass === 'INFRASTRUCTURE'
          ? 'pending'
          : 'failure',
      failureClass === 'INFRASTRUCTURE'
        ? `Infrastructure retry budget exhausted; safely requeued: ${message}`
        : `${failureClass.toLowerCase()} failure: ${message}`
    );
    await this.transitionTrain(current, {
      status: 'FAILED',
      failureClass,
      failureMessage: message,
      recoveryMessage:
        failureClass === 'CONTROL_PLANE'
          ? 'Automation is paused; retain exact state and use the documented manual fallback'
          : 'Exact state is retained for idempotent diagnosis or retry',
      completedAt: Date.now()
    });
    if (lease) {
      await this.releaseEnvironmentLease(
        current.lane === 'PRODUCTION'
          ? 'production-environment'
          : 'staging-environment',
        lease
      );
    }
  }

  private async deferTrainForInfrastructure(
    train: ReleaseBusV2TrainRecord,
    message: string
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {});
    if (!current || TERMINAL_TRAINS.has(current.status)) return;
    const previous =
      current.failure_class === 'INFRASTRUCTURE'
        ? /^Transient control transport failure (\d+)\/3:/.exec(
            current.failure_message ?? ''
          )
        : null;
    const failures = Number(previous?.[1] ?? 0) + 1;
    if (failures >= 3) {
      await this.failTrain(
        current,
        'INFRASTRUCTURE',
        `GitHub transport remained unavailable after ${failures} idempotent attempts: ${message}`
      );
      return;
    }
    await this.transitionTrain(current, {
      status: current.status,
      failureClass: 'INFRASTRUCTURE',
      failureMessage: `Transient control transport failure ${failures}/3: ${message}`,
      recoveryMessage:
        'Retrying the same exact state and idempotency key; no candidate isolation or environment mutation is inferred'
    });
  }

  private async cancelForMovedMain(
    train: ReleaseBusV2TrainRecord,
    message: string
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {});
    if (!current || TERMINAL_TRAINS.has(current.status)) return;
    const context = await this.loadContext(current);
    await this.updateCandidateStatuses(
      relevantCandidates(context),
      'READY_FOR_PRODUCTION',
      null,
      false
    );
    const lease = (await this.repository.listLocks({})).find(
      (lock) =>
        lock.name === 'production-environment' &&
        lock.owner_train_id === current.id
    );
    if (lease?.lease_token)
      await this.repository.releaseLock(
        'production-environment',
        lease.lease_token,
        {}
      );
    await this.publishCandidateStatuses(
      relevantCandidates(context),
      'pending',
      'Main moved; v2 will recompute and requalify this exact production subset'
    );
    await this.transitionTrain(current, {
      status: 'CANCELLED',
      failureClass: 'INTERACTION',
      failureMessage: message,
      recoveryMessage:
        'Main moved before production mutation; the explicit candidate subset was safely requeued for fresh composition and qualification',
      completedAt: Date.now()
    });
  }

  private async publishCandidateStatuses(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    state: 'error' | 'failure' | 'pending' | 'success',
    description: string
  ): Promise<void> {
    await Promise.all(
      candidates.map(async (candidate) => {
        const current = await this.repository.findCandidateById(
          candidate.id,
          {}
        );
        if (!current || ['SUPERSEDED', 'CANCELLED'].includes(current.status))
          return;
        await releaseBusGitHubApp.ensureCommitStatus(
          candidate.repository,
          candidate.head_sha,
          state,
          description,
          'Release Bus v2'
        );
      })
    );
  }
}

export const releaseBusV2Reconciler = new ReleaseBusV2Reconciler();
