import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  getDeployServiceConfigs,
  type DeployEnvironment
} from '@/api/deploy/deploy.config';
import {
  releaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError
} from '@/releaseBusV2/release-bus-v2.github-app';
import {
  getReleaseBusV2BetaAllowlist,
  getReleaseBusV2Mode,
  RELEASE_BUS_V2_LOCK_TTL_MS,
  releaseBusV2BetaAllowsCandidate,
  releaseBusV2BetaInfrastructureFailureInjection,
  releaseBusV2BetaAllowsLane,
  releaseBusV2BetaAllowsLaneInMode,
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
  CANDIDATE_EVIDENCE_READY_STATUS,
  CANDIDATE_STAGING_EVIDENCE_POLICY,
  releaseBusV2Service,
  storedDeployPlan,
  topologicalOrder,
  type ReleaseBusV2Service
} from '@/releaseBusV2/release-bus-v2.service';
import { isHumanGithubContributorLogin } from '@/release-notes/release-note-contributors.config';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2CandidateStagingEvidence,
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2FailureClass,
  ReleaseBusV2ManifestStatus,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2PrEvidence,
  ReleaseBusV2Repository,
  ReleaseBusV2StagingTransition,
  ReleaseBusV2TrainRecord,
  ReleaseBusV2TrainStatus
} from '@/releaseBusV2/release-bus-v2.types';

const TERMINAL_TRAINS = new Set<ReleaseBusV2TrainStatus>([
  'STAGING_VALIDATED',
  'STAGING_ROLLBACK_FAILED',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'CANCELLED'
]);
const TERMINAL_OPERATIONS = new Set<ReleaseBusV2OperationRecord['status']>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
]);
const STAGING_REF_OPERATION_TYPES = new Set([
  'ADVANCE_STAGING_RELEASE_FRONTEND',
  'ADVANCE_STAGING_RELEASE_BACKEND',
  'ADVANCE_STAGING_ROLLBACK_FRONTEND',
  'ADVANCE_STAGING_ROLLBACK_BACKEND'
]);
// The lock is renewed every minute, but its expiry must also outlive the
// longest deployment/E2E workflow during a temporary control-plane outage.
// Workflow timeouts are at most 90 minutes, so two hours prevents overlapping
// mutation while still allowing deterministic recovery from an abandoned lock.
const ENVIRONMENT_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const REQUIRED_MAINTENANCE_LOCKS = [
  'scheduler',
  'staging-environment',
  'production-environment'
] as const;
const ENVIRONMENT_BOUND_ARTIFACT_CONTRACT = 'environment-bound-v3';
const ROLLBACK_ARTIFACT_REVISION = '900001';
const compareStrings = (left: string, right: string): number =>
  left.localeCompare(right, 'en');

export type TrainContext = {
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
  readonly frontend: PreparedArtifactSource | null;
  readonly backend: PreparedArtifactSource | null;
};

type ArtifactDeployBinding = {
  readonly artifact_environment: '' | 'staging' | 'production';
  readonly artifact_contract_version:
    | 'legacy-v2'
    | typeof ENVIRONMENT_BOUND_ARTIFACT_CONTRACT;
};

type PreparedArtifactSource = {
  readonly runId: string;
  readonly digest: string;
  readonly expectedSha: string;
  readonly binding: ArtifactDeployBinding;
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
  readonly expected_frontend_staging_sha?: string;
  readonly expected_backend_staging_sha?: string;
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

class MainMovedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MainMovedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class StagingRefMovedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StagingRefMovedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class StagingRefWorkflowError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StagingRefWorkflowError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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
      /^(frontend|backend) staging-ref operation changed concurrently$/.test(
        error.message
      ) ||
      /^Candidate .* changed during deterministic isolation$/.test(
        error.message
      ))
  );
}

function operationMayStillBeRunning(
  operation: ReleaseBusV2OperationRecord
): boolean {
  return (
    ['DISPATCHED', 'RUNNING'].includes(operation.status) ||
    (operation.status === 'PENDING' && operation.external_id !== null)
  );
}

function isStagingRefOperation(operationType: string): boolean {
  return STAGING_REF_OPERATION_TYPES.has(operationType);
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.values(value).every((item) => typeof item === 'string')
  )
    return null;
  return value as Readonly<Record<string, string>>;
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

export function releaseTrainContributorGithubLogins(
  candidates: readonly ReleaseBusV2CandidateRecord[]
): string[] {
  const logins: string[] = [];
  for (const candidate of candidates) {
    for (const value of prEvidence(candidate)?.contributor_github_logins ??
      []) {
      const login = value.trim();
      if (
        !isHumanGithubContributorLogin(login) ||
        logins.some(
          (existing) => existing.toLowerCase() === login.toLowerCase()
        )
      )
        continue;
      logins.push(login);
    }
  }
  return logins;
}

export function operationContributorCandidates(
  context: TrainContext,
  repository: ReleaseBusV2Repository,
  service?: string
): ReleaseBusV2CandidateRecord[] {
  let candidates: ReleaseBusV2CandidateRecord[];
  if (
    context.train.lane === 'STAGING' &&
    context.train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
  ) {
    const introduced = new Set(
      context.memberships
        .filter(
          (membership) =>
            membership.disposition === 'INCLUDED' &&
            membership.candidate_role === 'NEW'
        )
        .map((membership) => membership.candidate_id)
    );
    candidates = context.candidates.filter(
      (candidate) =>
        candidate.repository === repository && introduced.has(candidate.id)
    );
  } else {
    candidates = relevantCandidates(context, repository);
  }
  if (repository !== 'backend' || !service) return candidates;
  return candidates.filter(
    (candidate) => storedDeployPlan(candidate)?.units.includes(service) === true
  );
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

type CandidateEvidenceMode =
  | 'legacy-whole-train'
  | 'strict-single'
  | 'strict-aggregate';

type CandidateEvidenceSelection = {
  readonly mode: CandidateEvidenceMode;
  readonly aggregateDigest: string | null;
  readonly singular: ReleaseBusV2PrEvidence | null;
};

function hasExactEvidenceAudit(
  evidence: ReleaseBusV2PrEvidence | null
): evidence is ReleaseBusV2PrEvidence & {
  readonly workflow_path: string;
  readonly base_workflow_blob_sha: string;
  readonly merge_workflow_blob_sha: string;
  readonly base_gate_policy_digest: string;
  readonly merge_gate_policy_digest: string;
  readonly trust_mode: 'evidence-manifest-v1' | 'legacy-exact-workflow-v0';
} {
  return Boolean(
    evidence &&
    /^[a-f0-9]{40}$/.test(evidence.base_sha) &&
    /^[a-f0-9]{40}$/.test(evidence.merge_sha) &&
    /^[1-9][0-9]{0,19}$/.test(evidence.checks_run_id) &&
    Number.isSafeInteger(evidence.checks_completed_at) &&
    evidence.checks_completed_at > 0 &&
    evidence?.workflow_path &&
    /^[a-f0-9]{40}$/.test(evidence.base_workflow_blob_sha ?? '') &&
    /^[a-f0-9]{40}$/.test(evidence.merge_workflow_blob_sha ?? '') &&
    /^[a-f0-9]{64}$/.test(evidence.base_gate_policy_digest ?? '') &&
    /^[a-f0-9]{64}$/.test(evidence.merge_gate_policy_digest ?? '') &&
    ['evidence-manifest-v1', 'legacy-exact-workflow-v0'].includes(
      evidence.trust_mode ?? ''
    )
  );
}

export function candidateEvidenceSelection(
  candidates: readonly ReleaseBusV2CandidateRecord[],
  singleFastCandidateId: string | null
): CandidateEvidenceSelection {
  if (candidates.length === 0)
    throw new Error('A selected repository has no exact candidate evidence');
  const entries = candidates.map((candidate) => {
    const evidence = prEvidence(candidate);
    if (!hasExactEvidenceAudit(evidence))
      throw new Error(
        `${candidate.repository}#${candidate.pr_number} has no complete exact PR CI policy evidence`
      );
    const requiredWorkflow =
      candidate.repository === 'frontend'
        ? '.github/workflows/app-pr-ci.yml'
        : '.github/workflows/on-pull-request.yml';
    if (evidence.workflow_path !== requiredWorkflow)
      throw new Error(
        `${candidate.repository}#${candidate.pr_number} exact PR CI evidence names an unexpected workflow`
      );
    const artifactFields = [
      evidence.artifact_run_id,
      evidence.artifact_name,
      evidence.artifact_digest
    ];
    const artifactComplete =
      typeof artifactFields[0] === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(artifactFields[0]) &&
      artifactFields[1] === `release-bus-v2-pr-${evidence.merge_sha}` &&
      typeof artifactFields[2] === 'string' &&
      /^[a-f0-9]{64}$/.test(artifactFields[2]);
    const artifactEmpty = artifactFields.every((value) => value === null);
    if (
      evidence.trust_mode === 'evidence-manifest-v1'
        ? !artifactComplete
        : !artifactComplete && !artifactEmpty
    )
      throw new Error(
        `${candidate.repository}#${candidate.pr_number} has incomplete exact PR CI artifact evidence`
      );
    return { candidate, evidence };
  });
  const modes = new Set(entries.map(({ evidence }) => evidence.trust_mode));
  if (modes.size !== 1)
    throw new Error(
      'Strict and legacy PR CI evidence cannot be mixed in one repository train'
    );
  const trustMode = entries[0].evidence.trust_mode;
  if (trustMode === 'legacy-exact-workflow-v0')
    return {
      mode: 'legacy-whole-train',
      aggregateDigest: null,
      singular: null
    };
  if (entries.length === 1 && singleFastCandidateId === entries[0].candidate.id)
    return {
      mode: 'strict-single',
      aggregateDigest: null,
      singular: entries[0].evidence
    };
  const canonical = entries
    .map(({ candidate, evidence }) => ({
      repository: candidate.repository,
      pr_number: candidate.pr_number,
      candidate_id: candidate.id,
      head_sha: candidate.head_sha,
      base_sha: evidence.base_sha,
      merge_sha: evidence.merge_sha,
      checks_run_id: evidence.checks_run_id,
      checks_completed_at: evidence.checks_completed_at,
      artifact_run_id: evidence.artifact_run_id,
      artifact_name: evidence.artifact_name,
      artifact_digest: evidence.artifact_digest,
      workflow_path: evidence.workflow_path,
      base_workflow_blob_sha: evidence.base_workflow_blob_sha,
      merge_workflow_blob_sha: evidence.merge_workflow_blob_sha,
      base_gate_policy_digest: evidence.base_gate_policy_digest,
      merge_gate_policy_digest: evidence.merge_gate_policy_digest,
      trust_mode: evidence.trust_mode
    }))
    .sort((left, right) => {
      const leftKey = `${left.repository}:${String(left.pr_number).padStart(12, '0')}:${left.candidate_id}`;
      const rightKey = `${right.repository}:${String(right.pr_number).padStart(12, '0')}:${right.candidate_id}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return {
    mode: 'strict-aggregate',
    aggregateDigest: createHash('sha256')
      .update(
        JSON.stringify({
          schema_version: 1,
          contract: 'release-bus-v2-candidate-evidence-aggregate-v1',
          candidates: canonical
        })
      )
      .digest('hex'),
    singular: null
  };
}

export function candidateEvidenceSelectionForPreparation(
  candidates: readonly ReleaseBusV2CandidateRecord[],
  singleFastCandidateId: string | null
): CandidateEvidenceSelection {
  return candidates.length === 0
    ? {
        mode: 'legacy-whole-train',
        aggregateDigest: null,
        singular: null
      }
    : candidateEvidenceSelection(candidates, singleFastCandidateId);
}

export function rollbackEvidenceSelectionForPreparation(): CandidateEvidenceSelection {
  // A rollback rebuilds the exact SHA of an already STAGING_VALIDATED
  // manifest. Its historical candidates are identity/audit data, not fresh
  // composition inputs, and may predate the current PR evidence schema.
  return candidateEvidenceSelectionForPreparation([], null);
}

function artifactEnvironmentForTrain(
  train: ReleaseBusV2TrainRecord
): 'staging' | 'production' {
  return train.lane === 'PRODUCTION' ? 'production' : 'staging';
}

type ArtifactPreparationRequest = {
  readonly workflow?: unknown;
  readonly ref?: unknown;
  readonly workflow_control_sha?: unknown;
  readonly inputs?: unknown;
};

type ArtifactPreparationSummary = Readonly<Record<string, unknown>>;
type ArtifactPreparationInputs = Readonly<Record<string, string>>;

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  return isDeepStrictEqual(
    Object.keys(value).sort(compareStrings),
    [...expected].sort(compareStrings)
  );
}

function parseArtifactUnits(
  value: string | undefined
): readonly string[] | null {
  try {
    const parsed = JSON.parse(value ?? 'null') as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some(
        (unit) =>
          typeof unit !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(unit)
      ) ||
      new Set(parsed).size !== parsed.length
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseArtifactLayers(
  value: string | undefined,
  units: readonly string[],
  deriveWhenAbsent: boolean
): readonly (readonly string[])[] | null {
  if (deriveWhenAbsent && value === undefined)
    return units.map((unit) => [unit]);
  try {
    const parsed = JSON.parse(value ?? 'null') as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some(
        (layer) =>
          !Array.isArray(layer) ||
          layer.length === 0 ||
          layer.some((unit) => typeof unit !== 'string')
      )
    )
      return null;
    const flattened = parsed.flat() as string[];
    if (
      flattened.length !== units.length ||
      new Set(flattened).size !== flattened.length ||
      !isDeepStrictEqual(
        [...flattened].sort(compareStrings),
        [...units].sort(compareStrings)
      )
    )
      return null;
    return parsed as readonly (readonly string[])[];
  } catch {
    return null;
  }
}

function legacyReuseEvidence(
  inputs: ArtifactPreparationInputs,
  allowComplete: boolean
): {
  readonly runId: string | null;
  readonly name: string | null;
  readonly digest: string | null;
} | null {
  const runId = inputs.reuse_artifact_run_id ?? '';
  const name = inputs.reuse_artifact_name ?? '';
  const digest = inputs.reuse_artifact_digest ?? '';
  if (!runId && !name && !digest)
    return { runId: null, name: null, digest: null };
  if (
    !allowComplete ||
    !/^[1-9][0-9]{0,19}$/.test(runId) ||
    !/^release-bus-v2-pr-[a-f0-9]{40}$/.test(name) ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    return null;
  return { runId, name, digest };
}

function isOldLegacyProducerBaseRequest(
  inputs: ArtifactPreparationInputs
): boolean {
  return (
    !Object.prototype.hasOwnProperty.call(
      inputs,
      'artifact_contract_version'
    ) &&
    !Object.prototype.hasOwnProperty.call(inputs, 'candidate_evidence_mode') &&
    !Object.prototype.hasOwnProperty.call(
      inputs,
      'aggregate_candidate_evidence_digest'
    ) &&
    !Object.prototype.hasOwnProperty.call(inputs, 'deploy_layers') &&
    inputs.operation_key === 'replaced-by-reconciler' &&
    /^[1-9][0-9]{0,8}$/.test(inputs.release_train_revision ?? '') &&
    typeof inputs.source_ref === 'string' &&
    inputs.source_ref.length > 0
  );
}

function isNewLegacyProducerBaseRequest(
  request: ArtifactPreparationRequest,
  inputs: ArtifactPreparationInputs
): boolean {
  return (
    request.ref === 'main' &&
    typeof request.workflow_control_sha === 'string' &&
    /^[a-f0-9]{40}$/.test(request.workflow_control_sha) &&
    inputs.operation_key === 'replaced-by-reconciler' &&
    /^[1-9][0-9]{0,8}$/.test(inputs.release_train_revision ?? '') &&
    typeof inputs.source_ref === 'string' &&
    inputs.source_ref.length > 0 &&
    inputs.candidate_evidence_mode === 'legacy-whole-train' &&
    inputs.aggregate_candidate_evidence_digest === '' &&
    inputs.reuse_artifact_run_id === '' &&
    inputs.reuse_artifact_name === '' &&
    inputs.reuse_artifact_digest === ''
  );
}

function isOldLegacyProducer(
  operation: ReleaseBusV2OperationRecord,
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  targetEnvironment: 'staging' | 'production',
  oldProducerBaseRequest: boolean,
  backendUnits: readonly string[] | null
): boolean {
  const oldProducerSummaryShape = exactKeys(summary, [
    'artifact_digest',
    'fresh_or_reused'
  ]);
  if (operation.repository === 'backend')
    return (
      oldProducerBaseRequest &&
      !Object.prototype.hasOwnProperty.call(inputs, 'artifact_environment') &&
      backendUnits !== null &&
      oldProducerSummaryShape &&
      ['fresh', 'reused'].includes(String(summary.fresh_or_reused))
    );
  return (
    oldProducerBaseRequest &&
    inputs.artifact_environment === targetEnvironment &&
    inputs.deploy_units === '[]' &&
    oldProducerSummaryShape &&
    ['fresh-dual-profile', 'reused'].includes(String(summary.fresh_or_reused))
  );
}

function isExactLegacyFrontendBinding(
  operation: ReleaseBusV2OperationRecord,
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  targetEnvironment: 'staging' | 'production',
  oldProducerBaseRequest: boolean,
  newProducerBaseRequest: boolean
): boolean {
  const newFrontendRequest =
    newProducerBaseRequest &&
    exactKeys(inputs, [
      'aggregate_candidate_evidence_digest',
      'artifact_contract_version',
      'artifact_environment',
      'candidate_evidence_mode',
      'deploy_units',
      'expected_sha',
      'operation_key',
      'release_train_id',
      'release_train_revision',
      'reuse_artifact_digest',
      'reuse_artifact_name',
      'reuse_artifact_run_id',
      'source_ref'
    ]) &&
    inputs.artifact_contract_version === 'legacy-v2' &&
    inputs.artifact_environment === targetEnvironment &&
    inputs.deploy_units === '[]';
  const oldFrontendStructuredRequest =
    oldProducerBaseRequest &&
    inputs.artifact_environment === targetEnvironment &&
    inputs.deploy_units === '[]';
  return (
    (newFrontendRequest || oldFrontendStructuredRequest) &&
    exactKeys(summary, [
      'artifact_bytes_reused',
      'artifact_contract',
      'artifact_contract_version',
      'artifact_digest',
      'ci_evidence',
      'environment',
      'fresh_or_reused',
      'package_digest',
      'repository',
      'schema_version',
      'source_evidence_reused',
      'source_sha'
    ]) &&
    summary.schema_version === 2 &&
    summary.artifact_contract === null &&
    summary.artifact_contract_version === 'legacy-v2' &&
    summary.repository === 'frontend' &&
    summary.source_sha === operation.expected_sha &&
    summary.environment === 'dual' &&
    summary.fresh_or_reused === 'fresh-legacy-dual-profile' &&
    summary.source_evidence_reused === false &&
    summary.artifact_bytes_reused === false &&
    summary.ci_evidence === null &&
    typeof summary.package_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(summary.package_digest)
  );
}

function exactPackageDigests(
  value: unknown,
  units: readonly string[]
): boolean {
  const packageDigests = stringRecord(value);
  return (
    packageDigests !== null &&
    isDeepStrictEqual(
      Object.keys(packageDigests).sort(compareStrings),
      [...units].sort(compareStrings)
    ) &&
    Object.values(packageDigests).every((digest) =>
      /^[a-f0-9]{64}$/.test(digest)
    )
  );
}

function isExactLegacyBackendBinding(
  operation: ReleaseBusV2OperationRecord,
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  backendUnits: readonly string[],
  oldProducerBaseRequest: boolean,
  newProducerBaseRequest: boolean
): boolean {
  const newBackendRequest =
    newProducerBaseRequest &&
    exactKeys(inputs, [
      'aggregate_candidate_evidence_digest',
      'artifact_contract_version',
      'artifact_environment',
      'candidate_evidence_mode',
      'deploy_layers',
      'deploy_units',
      'expected_sha',
      'operation_key',
      'release_train_id',
      'release_train_revision',
      'reuse_artifact_digest',
      'reuse_artifact_name',
      'reuse_artifact_run_id',
      'source_ref'
    ]) &&
    inputs.artifact_contract_version === 'legacy-v2' &&
    inputs.artifact_environment === '';
  const oldBackendStructuredRequest =
    oldProducerBaseRequest &&
    !Object.prototype.hasOwnProperty.call(inputs, 'artifact_environment');
  const layers = parseArtifactLayers(
    inputs.deploy_layers,
    backendUnits,
    oldBackendStructuredRequest
  );
  const evidence = legacyReuseEvidence(inputs, oldBackendStructuredRequest);
  return (
    (newBackendRequest || oldBackendStructuredRequest) &&
    layers !== null &&
    evidence !== null &&
    exactKeys(summary, [
      'artifact_bytes_reused',
      'artifact_contract',
      'artifact_contract_version',
      'artifact_digest',
      'ci_evidence',
      'environment',
      'fresh_or_reused',
      'layers',
      'package_digests',
      'repository',
      'schema_version',
      'source_evidence_reused',
      'source_sha',
      'units'
    ]) &&
    summary.schema_version === 2 &&
    summary.artifact_contract === 'legacy-v2' &&
    summary.artifact_contract_version === 'legacy-v2' &&
    summary.repository === 'backend' &&
    summary.source_sha === operation.expected_sha &&
    summary.environment === 'portable' &&
    summary.source_evidence_reused === true &&
    typeof summary.artifact_bytes_reused === 'boolean' &&
    summary.fresh_or_reused ===
      (summary.artifact_bytes_reused ? 'reused' : 'fresh') &&
    isDeepStrictEqual(summary.units, backendUnits) &&
    isDeepStrictEqual(summary.layers, layers) &&
    exactPackageDigests(summary.package_digests, backendUnits) &&
    isDeepStrictEqual(summary.ci_evidence, {
      mode: 'legacy-whole-train',
      artifact_run_id: evidence.runId,
      artifact_name: evidence.name,
      artifact_digest: evidence.digest,
      aggregate_candidate_evidence_digest: null
    })
  );
}

function legacyArtifactDeployBinding(
  operation: ReleaseBusV2OperationRecord,
  request: ArtifactPreparationRequest,
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  targetEnvironment: 'staging' | 'production'
): ArtifactDeployBinding | null {
  const oldProducerBaseRequest = isOldLegacyProducerBaseRequest(inputs);
  const newProducerBaseRequest = isNewLegacyProducerBaseRequest(
    request,
    inputs
  );
  const backendUnits = parseArtifactUnits(inputs.deploy_units);
  const exactOldProducer = isOldLegacyProducer(
    operation,
    inputs,
    summary,
    targetEnvironment,
    oldProducerBaseRequest,
    backendUnits
  );
  const exactFrontend =
    operation.repository === 'frontend' &&
    isExactLegacyFrontendBinding(
      operation,
      inputs,
      summary,
      targetEnvironment,
      oldProducerBaseRequest,
      newProducerBaseRequest
    );
  const exactBackend =
    operation.repository === 'backend' &&
    backendUnits !== null &&
    isExactLegacyBackendBinding(
      operation,
      inputs,
      summary,
      backendUnits,
      oldProducerBaseRequest,
      newProducerBaseRequest
    );
  return exactOldProducer || exactFrontend || exactBackend
    ? {
        artifact_environment: '',
        artifact_contract_version: 'legacy-v2'
      }
    : null;
}

function expectedV3CiEvidence(
  inputs: ArtifactPreparationInputs,
  expectedSha: string
): Readonly<Record<string, unknown>> | null {
  if (
    inputs.candidate_evidence_mode === 'strict-single' &&
    inputs.aggregate_candidate_evidence_digest === '' &&
    /^[1-9][0-9]{0,19}$/.test(inputs.reuse_artifact_run_id ?? '') &&
    inputs.reuse_artifact_name === `release-bus-v2-pr-${expectedSha}` &&
    /^[a-f0-9]{64}$/.test(inputs.reuse_artifact_digest ?? '')
  )
    return {
      mode: 'strict-single',
      artifact_run_id: inputs.reuse_artifact_run_id,
      artifact_name: inputs.reuse_artifact_name,
      artifact_digest: inputs.reuse_artifact_digest,
      aggregate_candidate_evidence_digest: null
    };
  if (
    inputs.candidate_evidence_mode === 'strict-aggregate' &&
    /^[a-f0-9]{64}$/.test(inputs.aggregate_candidate_evidence_digest ?? '') &&
    inputs.reuse_artifact_run_id === '' &&
    inputs.reuse_artifact_name === '' &&
    inputs.reuse_artifact_digest === ''
  )
    return {
      mode: 'strict-aggregate',
      artifact_run_id: null,
      artifact_name: null,
      artifact_digest: null,
      aggregate_candidate_evidence_digest:
        inputs.aggregate_candidate_evidence_digest
    };
  return null;
}

function isExactV3RequestBase(
  request: ArtifactPreparationRequest,
  inputs: ArtifactPreparationInputs,
  targetEnvironment: 'staging' | 'production'
): boolean {
  return (
    inputs.artifact_contract_version === ENVIRONMENT_BOUND_ARTIFACT_CONTRACT &&
    request.ref === 'main' &&
    typeof request.workflow_control_sha === 'string' &&
    /^[a-f0-9]{40}$/.test(request.workflow_control_sha) &&
    inputs.artifact_environment === targetEnvironment &&
    inputs.operation_key === 'replaced-by-reconciler' &&
    /^[1-9][0-9]{0,8}$/.test(inputs.release_train_revision ?? '') &&
    typeof inputs.source_ref === 'string' &&
    inputs.source_ref.length > 0
  );
}

function isExactV3SummaryBase(
  operation: ReleaseBusV2OperationRecord,
  summary: ArtifactPreparationSummary,
  targetEnvironment: 'staging' | 'production',
  expectedCiEvidence: Readonly<Record<string, unknown>> | null
): boolean {
  return (
    summary.schema_version === 3 &&
    summary.artifact_contract === 'environment-bound-v1' &&
    summary.artifact_contract_version === ENVIRONMENT_BOUND_ARTIFACT_CONTRACT &&
    summary.environment === targetEnvironment &&
    summary.repository === operation.repository &&
    summary.source_sha === operation.expected_sha &&
    summary.source_evidence_reused === true &&
    summary.artifact_bytes_reused === false &&
    expectedCiEvidence !== null &&
    isDeepStrictEqual(summary.ci_evidence, expectedCiEvidence)
  );
}

function isExactV3FrontendBinding(
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  exactRequestBase: boolean,
  exactSummaryBase: boolean
): boolean {
  return (
    exactRequestBase &&
    exactKeys(inputs, [
      'aggregate_candidate_evidence_digest',
      'artifact_contract_version',
      'artifact_environment',
      'candidate_evidence_mode',
      'deploy_units',
      'expected_sha',
      'operation_key',
      'release_train_id',
      'release_train_revision',
      'reuse_artifact_digest',
      'reuse_artifact_name',
      'reuse_artifact_run_id',
      'source_ref'
    ]) &&
    inputs.deploy_units === '[]' &&
    exactSummaryBase &&
    exactKeys(summary, [
      'artifact_bytes_reused',
      'artifact_contract',
      'artifact_contract_version',
      'artifact_digest',
      'ci_evidence',
      'environment',
      'fresh_or_reused',
      'package_digest',
      'repository',
      'schema_version',
      'source_evidence_reused',
      'source_sha'
    ]) &&
    summary.fresh_or_reused === 'fresh-environment-bound' &&
    typeof summary.package_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(summary.package_digest)
  );
}

function isExactV3BackendBinding(
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  exactRequestBase: boolean,
  exactSummaryBase: boolean
): boolean {
  const units = parseArtifactUnits(inputs.deploy_units);
  if (!units) return false;
  const layers = parseArtifactLayers(inputs.deploy_layers, units, false);
  return (
    layers !== null &&
    exactRequestBase &&
    exactKeys(inputs, [
      'aggregate_candidate_evidence_digest',
      'artifact_contract_version',
      'artifact_environment',
      'candidate_evidence_mode',
      'deploy_layers',
      'deploy_units',
      'expected_sha',
      'operation_key',
      'release_train_id',
      'release_train_revision',
      'reuse_artifact_digest',
      'reuse_artifact_name',
      'reuse_artifact_run_id',
      'source_ref'
    ]) &&
    exactSummaryBase &&
    exactKeys(summary, [
      'artifact_bytes_reused',
      'artifact_contract',
      'artifact_contract_version',
      'artifact_digest',
      'ci_evidence',
      'environment',
      'fresh_or_reused',
      'layers',
      'package_digests',
      'repository',
      'schema_version',
      'source_evidence_reused',
      'source_sha',
      'units'
    ]) &&
    isDeepStrictEqual(summary.units, units) &&
    isDeepStrictEqual(summary.layers, layers) &&
    exactPackageDigests(summary.package_digests, units) &&
    summary.fresh_or_reused === 'fresh'
  );
}

function environmentBoundArtifactDeployBinding(
  operation: ReleaseBusV2OperationRecord,
  request: ArtifactPreparationRequest,
  inputs: ArtifactPreparationInputs,
  summary: ArtifactPreparationSummary,
  targetEnvironment: 'staging' | 'production'
): ArtifactDeployBinding | null {
  const exactRequestBase = isExactV3RequestBase(
    request,
    inputs,
    targetEnvironment
  );
  const expectedCiEvidence = expectedV3CiEvidence(
    inputs,
    operation.expected_sha!
  );
  const exactSummaryBase = isExactV3SummaryBase(
    operation,
    summary,
    targetEnvironment,
    expectedCiEvidence
  );
  const exactRepositoryBinding =
    operation.repository === 'frontend'
      ? isExactV3FrontendBinding(
          inputs,
          summary,
          exactRequestBase,
          exactSummaryBase
        )
      : isExactV3BackendBinding(
          inputs,
          summary,
          exactRequestBase,
          exactSummaryBase
        );
  return exactRepositoryBinding
    ? {
        artifact_environment: targetEnvironment,
        artifact_contract_version: ENVIRONMENT_BOUND_ARTIFACT_CONTRACT
      }
    : null;
}

function parseArtifactPreparation(operation: ReleaseBusV2OperationRecord): {
  readonly request: ArtifactPreparationRequest;
  readonly inputs: ArtifactPreparationInputs;
  readonly summary: ArtifactPreparationSummary;
} | null {
  const request = parseStoredJson<ArtifactPreparationRequest>(
    operation.request_json
  );
  const inputs = stringRecord(request?.inputs);
  const result = parseStoredJson<{ summary?: unknown }>(operation.result_json);
  const summary =
    result?.summary &&
    typeof result.summary === 'object' &&
    !Array.isArray(result.summary)
      ? (result.summary as ArtifactPreparationSummary)
      : null;
  return request && inputs && summary ? { request, inputs, summary } : null;
}

function hasExactArtifactPreparationEnvelope(
  operation: ReleaseBusV2OperationRecord,
  prepared: ReturnType<typeof parseArtifactPreparation>
): prepared is NonNullable<ReturnType<typeof parseArtifactPreparation>> {
  if (!prepared) return false;
  const { request, inputs, summary } = prepared;
  return (
    operation.status === 'SUCCEEDED' &&
    request.workflow === 'release-bus-v2-preflight.yml' &&
    Boolean(operation.external_id) &&
    /^[1-9][0-9]{0,19}$/.test(operation.external_id ?? '') &&
    Boolean(operation.expected_sha) &&
    /^[a-f0-9]{40}$/.test(operation.expected_sha ?? '') &&
    Boolean(operation.artifact_digest) &&
    /^[a-f0-9]{64}$/.test(operation.artifact_digest ?? '') &&
    inputs.release_train_id === operation.train_id &&
    inputs.expected_sha === operation.expected_sha &&
    summary.artifact_digest === operation.artifact_digest &&
    (summary.repository === undefined ||
      summary.repository === operation.repository) &&
    (summary.source_sha === undefined ||
      summary.source_sha === operation.expected_sha)
  );
}

export function preparedArtifactDeployBinding(
  operation: ReleaseBusV2OperationRecord,
  environment: 'staging' | 'prod'
): ArtifactDeployBinding {
  const prepared = parseArtifactPreparation(operation);
  if (!hasExactArtifactPreparationEnvelope(operation, prepared))
    throw new Error(
      'Successful artifact preparation has no exact immutable deploy binding'
    );
  const { request, inputs, summary } = prepared;
  const targetEnvironment = environment === 'prod' ? 'production' : 'staging';
  const contract = inputs.artifact_contract_version ?? 'legacy-v2';
  const binding =
    contract === 'legacy-v2'
      ? legacyArtifactDeployBinding(
          operation,
          request,
          inputs,
          summary,
          targetEnvironment
        )
      : environmentBoundArtifactDeployBinding(
          operation,
          request,
          inputs,
          summary,
          targetEnvironment
        );
  if (binding) return binding;
  throw new Error(
    contract === 'legacy-v2'
      ? 'Legacy artifact preparation does not prove an immutable portable artifact'
      : 'Environment-bound preparation does not match the exact deploy environment'
  );
}

function frontendDeployBinding(
  binding: ArtifactDeployBinding,
  environment: 'staging' | 'prod'
): ArtifactDeployBinding {
  return binding.artifact_contract_version === 'legacy-v2'
    ? {
        artifact_contract_version: 'legacy-v2',
        artifact_environment: environment === 'prod' ? 'production' : 'staging'
      }
    : binding;
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
  candidates: readonly ReleaseBusV2CandidateRecord[],
  environment?: DeployEnvironment
): {
  readonly units: readonly string[];
  readonly edges: ReadonlyArray<readonly [string, string]>;
  readonly layers: readonly string[][];
} {
  const serviceConfigs = getDeployServiceConfigs();
  const allowedServiceNames = environment
    ? new Set(
        serviceConfigs
          .filter(({ allowed_environments }) =>
            allowed_environments.includes(environment)
          )
          .map(({ name }) => name)
      )
    : null;
  const requestedUnits = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.repository !== 'backend') continue;
    const plan = storedDeployPlan(candidate);
    for (const unit of plan?.units ?? []) requestedUnits.add(unit);
  }
  const allEdgeKeys = new Set<string>();
  const allEdges: Array<readonly [string, string]> = [];
  const addEdge = (
    target: Array<readonly [string, string]>,
    keys: Set<string>,
    from: string,
    to: string
  ) => {
    const key = `${from}\u0000${to}`;
    if (keys.has(key)) return;
    keys.add(key);
    target.push([from, to]);
  };
  for (const candidate of candidates) {
    if (candidate.repository !== 'backend') continue;
    const plan = storedDeployPlan(candidate);
    for (const [from, to] of plan?.edges ?? []) {
      if (!requestedUnits.has(from) || !requestedUnits.has(to)) continue;
      addEdge(allEdges, allEdgeKeys, from, to);
    }
  }
  for (const service of serviceConfigs) {
    if (!requestedUnits.has(service.name)) continue;
    for (const dependency of service.default_dependencies) {
      if (!requestedUnits.has(dependency)) continue;
      addEdge(allEdges, allEdgeKeys, dependency, service.name);
    }
  }
  const units = new Set(
    Array.from(requestedUnits).filter(
      (unit) => !allowedServiceNames || allowedServiceNames.has(unit)
    )
  );
  let edges = allEdges;
  if (allowedServiceNames) {
    const adjacency = new Map(
      Array.from(requestedUnits).map((unit) => [unit, [] as string[]])
    );
    for (const [from, to] of allEdges) adjacency.get(from)?.push(to);
    const projectedEdges: Array<readonly [string, string]> = [];
    const projectedKeys = new Set<string>();
    for (const source of Array.from(units)) {
      const visited = new Set<string>();
      const pending = [...(adjacency.get(source) ?? [])];
      while (pending.length > 0) {
        const target = pending.shift()!;
        if (visited.has(target)) continue;
        visited.add(target);
        if (units.has(target)) {
          addEdge(projectedEdges, projectedKeys, source, target);
          continue;
        }
        pending.push(...(adjacency.get(target) ?? []));
      }
    }
    edges = projectedEdges;
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

export function relevantCandidates(
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

export function stagingStatusCandidates(
  context: TrainContext
): ReleaseBusV2CandidateRecord[] {
  if (
    context.train.lane !== 'STAGING' ||
    context.train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1'
  )
    return relevantCandidates(context);
  const mutable = new Set(
    context.memberships
      .filter(({ candidate_role }) => candidate_role === 'NEW')
      .map(({ candidate_id }) => candidate_id)
  );
  return relevantCandidates(context).filter(({ id }) => mutable.has(id));
}

export function candidateStatusMutationCandidates(
  context: TrainContext
): ReleaseBusV2CandidateRecord[] {
  return context.train.lane === 'STAGING'
    ? stagingStatusCandidates(context)
    : relevantCandidates(context);
}

export function candidateEvidenceCandidates(
  context: TrainContext,
  repository?: ReleaseBusV2Repository
): ReleaseBusV2CandidateRecord[] {
  const candidates =
    context.train.lane === 'STAGING' &&
    context.train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
      ? stagingStatusCandidates(context)
      : relevantCandidates(context);
  return repository
    ? candidates.filter((candidate) => candidate.repository === repository)
    : candidates;
}

export function stagingDeploymentCandidates(
  context: TrainContext,
  repository?: ReleaseBusV2Repository
): ReleaseBusV2CandidateRecord[] {
  if (
    context.train.lane !== 'STAGING' ||
    context.train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1'
  )
    return relevantCandidates(context, repository);
  const deployRoles = new Set(['NEW', 'REMOVAL', 'ABSORPTION']);
  // Removal/absorption candidates are intentionally excluded from the
  // composition (AUDIT_ONLY) but still identify runtime units that must be
  // redeployed from the new cumulative composition to scrub their old bytes.
  const included = new Set(
    context.memberships
      .filter(({ candidate_role }) => deployRoles.has(candidate_role ?? 'NEW'))
      .map(({ candidate_id }) => candidate_id)
  );
  return context.candidates.filter(
    (candidate) =>
      included.has(candidate.id) &&
      (!repository || candidate.repository === repository)
  );
}

function cumulativeStagingReleaseParent(
  context: TrainContext,
  repository: ReleaseBusV2Repository
): string | null {
  if (
    context.train.lane !== 'STAGING' ||
    context.train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1'
  )
    return null;
  const transition = parseStoredJson<ReleaseBusV2StagingTransition>(
    context.train.staging_transition_json
  );
  const sha =
    repository === 'frontend'
      ? transition?.observed_frontend_staging_sha
      : transition?.observed_backend_staging_sha;
  if (!sha || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error(
      `Cumulative staging has no exact ${repository} release parent`
    );
  return sha;
}

export function candidateUnavailableForTrainUpdate(
  current: ReleaseBusV2CandidateRecord,
  claimed: ReleaseBusV2CandidateRecord
): boolean {
  if (['CANCELLED', 'SUPERSEDED', 'DEREGISTERED'].includes(current.status))
    return true;
  if (
    claimed.current_train_id &&
    current.current_train_id !== claimed.current_train_id
  )
    return true;
  return false;
}

export function deletedProductionCandidateCanRetainReadiness(
  candidate: ReleaseBusV2CandidateRecord
): boolean {
  return (
    candidate.current_train_id === null &&
    candidate.production_requested_at !== null &&
    candidate.staging_validated_manifest_id !== null &&
    [
      'READY_FOR_PRODUCTION',
      CANDIDATE_EVIDENCE_READY_STATUS,
      'WAITING_FOR_PRODUCTION_REPLAN',
      'SUPERSEDED'
    ].includes(candidate.status)
  );
}

type E2EWorkflowInputFields = {
  readonly release_train_id: string;
  readonly release_train_revision: string;
  readonly operation_key: string;
  readonly staging_source_ref: string;
  readonly expected_sha: string;
  readonly release_manifest_id: string;
  readonly release_manifest_identity_sha256: string;
  readonly frontend_sha: string;
  readonly backend_sha: string;
  readonly frontend_artifact_digest: string;
  readonly backend_artifact_digest: string;
};

export function e2eWorkflowInputs(
  environment: 'staging' | 'prod',
  fields: E2EWorkflowInputFields
): Record<string, string> {
  const { staging_source_ref: stagingSourceRef, ...shared } = fields;
  return {
    ...(environment === 'staging' ? { pack: 'all' } : {}),
    ...shared,
    source_ref: environment === 'staging' ? stagingSourceRef : 'main'
  };
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
    if (mode === 'OFF' || mode === 'STAGING') {
      let betaAllowlistValid = false;
      try {
        betaAllowlist = getReleaseBusV2BetaAllowlist();
        betaAllowlistValid = true;
      } catch {
        const scope = mode === 'OFF' ? 'ALL' : 'PRODUCTION';
        const controls = await this.repository.listControls({});
        const control = controls.find((item) => item.scope === scope);
        if (!control?.paused)
          await this.service.setPaused(
            scope,
            true,
            mode === 'OFF'
              ? 'Release Bus v2 OFF beta allowlist is invalid; automation remains disabled'
              : 'Release Bus v2 production beta allowlist is invalid; staging remains enabled',
            'release-bus-v2-beta'
          );
        if (mode === 'OFF') return { mode, claimed, advanced: [] };
        betaAllowlist = [];
      }
      if (betaAllowlistValid) {
        const betaScope = mode === 'OFF' ? 'ALL' : 'PRODUCTION';
        const betaControl = (await this.repository.listControls({})).find(
          (item) => item.scope === betaScope
        );
        if (
          betaControl?.paused &&
          betaControl.github_actor === 'release-bus-v2-beta'
        )
          await this.service.setPaused(
            betaScope,
            false,
            mode === 'OFF'
              ? 'Release Bus v2 beta allowlist configuration recovered; OFF manual fallback remains authoritative'
              : 'Release Bus v2 production beta allowlist configuration recovered',
            'release-bus-v2-beta'
          );
      }
      if (mode === 'OFF' && betaAllowlist.length === 0)
        return { mode, claimed, advanced: [] };
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
        releaseBusV2BetaAllowsLaneInMode(mode, betaAllowlist, 'PRODUCTION'));
    if (stagingEnabled) {
      try {
        await this.service.repairTerminalCumulativeCarryForwardStatuses(
          'release-bus-v2-reconciler'
        );
      } catch (error) {
        // A concurrent row-version winner will be observed on the next tick
        // and must not delay unrelated train advancement. Other failures stay
        // fail-closed and propagate.
        if (!isOptimisticConcurrencyConflict(error)) throw error;
      }
    }
    if (stagingEnabled || productionEnabled) {
      try {
        await this.reconcileQueuedCandidateHeads(betaAllowlist, mode);
        const [frontendMain, backendMain, frontendStaging, backendStaging] =
          await Promise.all([
            releaseBusGitHubApp.resolveRef('frontend', 'main'),
            releaseBusGitHubApp.resolveRef('backend', 'main'),
            releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
            releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
          ]);
        if (stagingEnabled) {
          const staging = await this.service.claimLane(
            'STAGING',
            frontendMain,
            backendMain,
            `${invocationId}:staging`,
            {
              frontendSha: frontendStaging,
              backendSha: backendStaging
            }
          );
          if (staging) claimed.push(staging.id);
        }
        if (productionEnabled) {
          const production = await this.service.claimLane(
            'PRODUCTION',
            frontendMain,
            backendMain,
            `${invocationId}:production`,
            {
              frontendSha: frontendStaging,
              backendSha: backendStaging
            }
          );
          if (production) claimed.push(production.id);
        }
      } catch (error) {
        // A GitHub infrastructure error rolls the claim transaction back and
        // leaves every explicit intent unchanged for the next scheduled tick.
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
      .filter(
        (train) => train.staging_policy !== 'ADOPT_EXACT_DEPLOYED_BASELINE_V1'
      )
      .filter((train) => {
        if (train.lane === 'STAGING') return stagingEnabled;
        if (train.lane === 'PRODUCTION') return productionEnabled;
        return stagingEnabled && productionEnabled;
      });
    const active: ReleaseBusV2TrainRecord[] = [];
    for (const train of activeByLane) {
      const requiresBetaEligibility =
        mode === 'OFF' || (mode === 'STAGING' && train.lane !== 'STAGING');
      if (
        !requiresBetaEligibility ||
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
        if (error instanceof StagingRefMovedError) {
          await this.failStagingForRefDrift(train, error.message);
          continue;
        }
        if (error instanceof StagingRefWorkflowError) {
          await this.failTrain(train, 'CONTROL_PLANE', error.message);
          continue;
        }
        if (isGitHubInfrastructureError(error)) {
          await this.deferTrainForInfrastructure(train, error.message);
          continue;
        }
        if (
          train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1' &&
          ['DEPLOYING', 'STAGING_DEPLOYED', 'E2E_RUNNING'].includes(
            train.status
          )
        ) {
          await this.beginCumulativeStagingRollback(
            train,
            'CONTROL_PLANE',
            error instanceof Error
              ? error.message
              : 'Unknown cumulative staging failure'
          );
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
    betaAllowlist: readonly ReleaseBusV2BetaEntry[] = [],
    mode = getReleaseBusV2Mode()
  ): Promise<void> {
    const candidates = (
      await this.repository.listCandidates(
        [
          'READY_FOR_STAGING',
          'WAITING_FOR_DEPENDENCY',
          'STAGING_IN_TRAIN',
          'STAGING_BUILDING',
          'STAGING_DEPLOYING',
          'STAGING_DEPLOYED',
          'STAGING_VALIDATING',
          'READY_FOR_PRODUCTION',
          CANDIDATE_EVIDENCE_READY_STATUS,
          'WAITING_FOR_PRODUCTION_REPLAN',
          'SUPERSEDED'
        ],
        500,
        {}
      )
    )
      .filter(
        (candidate) =>
          candidate.status !== 'SUPERSEDED' ||
          (candidate.current_train_id === null &&
            candidate.production_requested_at !== null &&
            candidate.staging_validated_manifest_id !== null)
      )
      .filter(
        (candidate) =>
          ![
            'STAGING_IN_TRAIN',
            'STAGING_BUILDING',
            'STAGING_DEPLOYING',
            'STAGING_DEPLOYED',
            'STAGING_VALIDATING'
          ].includes(candidate.status) ||
          candidate.staging_live_state !== 'LIVE'
      )
      .filter((candidate) => {
        const lane =
          candidate.status === 'READY_FOR_PRODUCTION' ||
          candidate.status === CANDIDATE_EVIDENCE_READY_STATUS ||
          candidate.status === 'WAITING_FOR_PRODUCTION_REPLAN' ||
          candidate.status === 'SUPERSEDED'
            ? 'PRODUCTION'
            : 'STAGING';
        if (mode === 'STAGING') {
          if (lane === 'STAGING') return true;
          return (
            betaAllowlist.length > 0 &&
            releaseBusV2BetaAllowsCandidate(betaAllowlist, candidate, lane)
          );
        }
        if (betaAllowlist.length === 0) return true;
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
      if (
        currentHead === null &&
        deletedProductionCandidateCanRetainReadiness(candidate) &&
        (await releaseBusGitHubApp.refContainsCommit(
          candidate.repository,
          'main',
          candidate.head_sha
        ))
      ) {
        if (candidate.status === 'SUPERSEDED')
          await this.service.restoreProductionReadinessAfterBranchCleanup(
            candidate.id,
            'release-bus-v2-reconciler'
          );
        continue;
      }
      if (candidate.status === 'SUPERSEDED') continue;
      await this.service.invalidateBranch(
        candidate.repository,
        candidate.branch_name,
        currentHead ?? 'deleted',
        'release-bus-v2-reconciler',
        candidate.current_train_id ?? undefined
      );
    }
  }

  private async advanceUntilExternalWait(
    initial: ReleaseBusV2TrainRecord
  ): Promise<void> {
    let current = initial;
    for (let transition = 0; transition < 12; transition += 1) {
      await this.advance(current);
      const refreshed = await this.repository.findTrain(
        current.id,
        {},
        false,
        true
      );
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
    if (train.status === 'STAGING_ROLLING_BACK') {
      await this.advanceCumulativeStagingRollback(context);
      return;
    }
    if (await this.deferSupersededStagingPlan(context)) return;
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
    const memberships = await this.repository.listTrainCandidates(
      train.id,
      {},
      true
    );
    const candidates = (
      await Promise.all(
        memberships.map((membership) =>
          this.repository.findCandidateById(
            membership.candidate_id,
            {},
            false,
            true
          )
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
        {},
        true
      )
    };
  }

  private async deferMovedProductionPlan(
    context: TrainContext
  ): Promise<boolean> {
    const train = context.train;
    if (train.lane !== 'PRODUCTION') return false;
    const repositories = ['backend', 'frontend'] as const;
    const current = await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        sha: await releaseBusGitHubApp.resolveRef(repository, 'main')
      }))
    );
    for (const { repository, sha } of current) {
      if (!/^[a-f0-9]{40}$/.test(sha))
        throw new Error(
          `Invalid SHA returned for ${repository}:main while fencing a production replan`
        );
    }
    const moved = current.find(({ repository, sha }) => {
      const base =
        repository === 'frontend'
          ? train.frontend_base_sha
          : train.backend_base_sha;
      const composed =
        repository === 'frontend'
          ? train.frontend_composed_sha
          : train.backend_composed_sha;
      return sha !== base && sha !== composed;
    });
    if (!moved) return false;
    const base =
      moved.repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    const message = `${moved.repository} main moved from ${base} to ${moved.sha}; production composition must be rebuilt and requalified`;
    const stillRunningIds = await this.observeAlreadyDispatchedWorkflows(train);
    if (stillRunningIds.length === 0) throw new MainMovedError(message);
    const recoveryMessage = `${message}; waiting for already-dispatched orchestration to report terminal before the safe replan; observing operations: ${stillRunningIds.join(',')}`;
    if (train.recovery_message !== recoveryMessage)
      await this.transitionTrain(train, {
        status: train.status,
        recoveryMessage
      });
    return true;
  }

  private async observeAlreadyDispatchedWorkflows(
    train: ReleaseBusV2TrainRecord
  ): Promise<readonly string[]> {
    const operations = await this.repository.listOperations(train.id, {});
    const carriedOperationIds = new Set(
      /; observing operations: ([^;]+)$/
        .exec(train.recovery_message ?? '')?.[1]
        ?.split(',')
        .map((id) => id.trim())
        .filter(Boolean) ?? []
    );
    const observed = operations.filter(
      (operation) =>
        operationMayStillBeRunning(operation) ||
        carriedOperationIds.has(operation.id)
    );
    if (observed.length === 0) return [];
    const results = await Promise.all(
      observed.map(async (operation) => {
        const request = parseStoredJson<{
          readonly workflow?: unknown;
          readonly ref?: unknown;
          readonly inputs?: unknown;
        }>(operation.request_json);
        const inputs = stringRecord(request?.inputs);
        if (
          !operation.repository ||
          !operation.environment ||
          !operation.expected_sha ||
          typeof request?.workflow !== 'string' ||
          typeof request.ref !== 'string' ||
          !inputs
        )
          throw new Error(
            `Dispatched operation ${operation.id} has no immutable workflow identity`
          );
        if (operationMayStillBeRunning(operation))
          await releaseBusV2Operations.reconcileWorkflow({
            idempotencyKey: operation.idempotency_key,
            trainId: operation.train_id,
            operationType: operation.operation_type,
            repository: operation.repository,
            workflow: request.workflow,
            ref: request.ref,
            environment: operation.environment,
            service: operation.service,
            expectedSha: operation.expected_sha,
            artifactDigest: operation.artifact_digest,
            inputs,
            maxAttempts: operation.max_attempts
          });
        const refreshed =
          (await this.repository.findOperation(
            operation.idempotency_key,
            {},
            true
          )) ?? operation;
        if (operationMayStillBeRunning(refreshed))
          return { id: operation.id, stillRunning: true };
        if (!refreshed.external_id)
          return { id: operation.id, stillRunning: false };
        const run = await releaseBusGitHubApp.findWorkflowRun(
          operation.repository,
          request.workflow,
          `${operation.idempotency_key}:a${refreshed.attempt}`,
          refreshed.external_id
        );
        return {
          id: operation.id,
          stillRunning: run !== null && run.status !== 'completed'
        };
      })
    );
    return results
      .filter(({ stillRunning }) => stillRunning)
      .map(({ id }) => id);
  }

  private async deferSupersededStagingPlan(
    context: TrainContext
  ): Promise<boolean> {
    const train = context.train;
    if (train.lane !== 'STAGING') return false;
    const newCandidates = stagingStatusCandidates(context);
    const currentHeads = await Promise.all(
      newCandidates
        .filter(({ status }) => status !== 'SUPERSEDED')
        .map(async (candidate) => ({
          candidate,
          currentHead: await releaseBusGitHubApp.resolveRefIfExists(
            candidate.repository,
            candidate.branch_name
          )
        }))
    );
    const moved = currentHeads.filter(
      ({ candidate, currentHead }) => currentHead !== candidate.head_sha
    );
    for (const { candidate, currentHead } of moved)
      await this.service.invalidateBranch(
        candidate.repository,
        candidate.branch_name,
        currentHead ?? 'deleted',
        'release-bus-v2-reconciler',
        train.id
      );
    const currentTrain = await this.repository.findTrain(
      train.id,
      {},
      false,
      true
    );
    if (!currentTrain || TERMINAL_TRAINS.has(currentTrain.status)) return true;
    const refreshed = await this.loadContext(currentTrain);
    const superseded = stagingStatusCandidates(refreshed).filter(
      (candidate) =>
        candidate.status === 'SUPERSEDED' &&
        candidate.current_train_id === train.id
    );
    if (superseded.length === 0) {
      if (moved.length > 0)
        throw new Error(
          `Active staging train ${train.id} did not durably supersede its moved candidate head`
        );
      return false;
    }
    const supersededSummary = superseded
      .map(
        ({ repository, pr_number, head_sha }) =>
          `${repository}#${pr_number}@${head_sha}`
      )
      .join(',');
    const message = `Active staging train contains superseded candidate head(s): ${supersededSummary}`;
    const stillRunningIds =
      await this.observeAlreadyDispatchedWorkflows(currentTrain);
    if (stillRunningIds.length > 0) {
      const recoveryMessage = `${message}; no further operations will be dispatched while already-dispatched workflows drain; observing operations: ${stillRunningIds.join(',')}`;
      if (currentTrain.recovery_message !== recoveryMessage)
        await this.transitionTrain(currentTrain, {
          status: currentTrain.status,
          recoveryMessage
        });
      return true;
    }
    const operations = await this.repository.listOperations(train.id, {});
    for (const operation of operations) {
      if (TERMINAL_OPERATIONS.has(operation.status)) continue;
      if (
        !(await this.repository.updateOperation(
          operation.id,
          operation.row_version,
          {
            status: 'CANCELLED',
            failureClass: 'INTERACTION',
            failureMessage: message,
            completedAt: Date.now()
          },
          {}
        ))
      )
        throw new Error('Release Bus v2 operation changed concurrently');
    }
    const stagingMutationStarted = operations.some(
      (operation) =>
        operation.environment === 'staging' && operation.external_id !== null
    );
    if (
      stagingMutationStarted &&
      currentTrain.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
    ) {
      await this.beginCumulativeStagingRollback(
        currentTrain,
        'INTERACTION',
        message
      );
      return true;
    }
    await this.replanSupersededStagingCandidates(refreshed, message);
    const latest = await this.repository.findTrain(train.id, {}, false, true);
    if (latest && !TERMINAL_TRAINS.has(latest.status))
      await this.transitionTrain(latest, {
        status: 'CANCELLED',
        failureClass: 'INTERACTION',
        failureMessage: message,
        recoveryMessage:
          'Obsolete exact heads were superseded and unrelated NEW candidates were returned immediately to the next staging train',
        completedAt: Date.now()
      });
    await this.releaseTerminalEnvironmentLocks();
    return true;
  }

  private async replanSupersededStagingCandidates(
    context: TrainContext,
    reason: string
  ): Promise<void> {
    const mutable = stagingStatusCandidates(context);
    const supersededIds = new Set(
      mutable
        .filter(({ status }) => status === 'SUPERSEDED')
        .map(({ id }) => id)
    );
    if (supersededIds.size === 0) return;
    const blockedIds = candidateExclusionClosure(
      Array.from(supersededIds),
      context.dependencies
    );
    const returned: ReleaseBusV2CandidateRecord[] = [];
    const blocked: ReleaseBusV2CandidateRecord[] = [];
    for (const candidate of mutable) {
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (!current || current.status === 'CANCELLED') continue;
      const superseded = supersededIds.has(candidate.id);
      const dependencyBlocked = !superseded && blockedIds.has(candidate.id);
      const status: ReleaseBusV2CandidateStatus = superseded
        ? 'SUPERSEDED'
        : dependencyBlocked
          ? 'WAITING_FOR_DEPENDENCY'
          : 'READY_FOR_STAGING';
      const holdReason = superseded
        ? reason
        : dependencyBlocked
          ? 'A required exact staging candidate was superseded'
          : null;
      if (
        !(await this.repository.updateCandidate(
          current.id,
          current.row_version,
          {
            status,
            currentTrainId: null,
            holdReason
          },
          {}
        ))
      )
        throw new Error('Candidate changed concurrently');
      await this.repository.updateTrainCandidateDisposition(
        context.train.id,
        current.id,
        superseded
          ? 'SUPERSEDED_HEAD'
          : dependencyBlocked
            ? 'DEPENDENCY_EXCLUDED'
            : 'RETURNED_TO_QUEUE',
        {}
      );
      if (dependencyBlocked) blocked.push(current);
      else if (!superseded) returned.push(current);
    }
    await Promise.all([
      this.publishCandidateStatuses(
        blocked,
        'pending',
        'Waiting because an exact staging dependency was superseded'
      ),
      this.publishCandidateStatuses(
        returned,
        'pending',
        'Independent candidate returned to the next exact v2 staging train'
      )
    ]);
    await this.repository.appendEvent(
      {
        trainId: context.train.id,
        eventType: 'ACTIVE_STAGING_HEADS_SUPERSEDED_AND_REPLANNED',
        actor: 'release-bus-v2',
        payload: {
          superseded_candidate_ids: Array.from(supersededIds),
          dependency_blocked_candidate_ids: blocked.map(({ id }) => id),
          returned_candidate_ids: returned.map(({ id }) => id)
        }
      },
      {}
    );
  }

  private async advancePreparation(context: TrainContext): Promise<void> {
    const train = context.train;
    if (await this.deferMovedProductionPlan(context)) return;
    if (
      relevantCandidates(context).length === 0 &&
      stagingDeploymentCandidates(context).length === 0
    ) {
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
    const evidenceFailures: Array<
      Pick<
        ReleaseBusV2OperationRecord,
        'id' | 'repository' | 'failure_class' | 'failure_message'
      >
    > = [];
    for (const repository of ['frontend', 'backend'] as const) {
      const repositoryCandidates = candidateEvidenceCandidates(
        context,
        repository
      );
      if (repositoryCandidates.length === 0) continue;
      try {
        candidateEvidenceSelection(repositoryCandidates, null);
      } catch (error) {
        evidenceFailures.push({
          id: `candidate-evidence-validation:${train.id}:${repository}`,
          repository,
          failure_class: 'CANDIDATE',
          failure_message:
            error instanceof Error
              ? error.message
              : 'Selected candidate PR CI evidence is invalid'
        });
      }
    }
    if (evidenceFailures.length > 0) {
      if (train.lane === 'STAGING') {
        await this.failStagingRepositoryCandidateGroups(
          context,
          evidenceFailures
        );
        return;
      }
      const message = evidenceFailures
        .map(({ failure_message }) => failure_message)
        .filter((value): value is string => Boolean(value))
        .join('; ');
      await this.failTrain(
        train,
        'CANDIDATE',
        message || 'Selected candidate PR CI evidence is invalid'
      );
      return;
    }
    await this.updateCandidateStatuses(
      candidateStatusMutationCandidates(context),
      candidateStatusForBuild(train.lane),
      train.id
    );
    const usesCandidateEvidence =
      train.lane === 'PRODUCTION' &&
      train.qualification_policy === CANDIDATE_STAGING_EVIDENCE_POLICY;
    const compositionOnly =
      train.lane === 'PRODUCTION' &&
      ['CLAIMED', 'COMPOSING'].includes(train.status);
    const [frontend, backend] = await Promise.all([
      this.prepareRepository(context, 'frontend', compositionOnly),
      this.prepareRepository(context, 'backend', compositionOnly)
    ]);
    const currentAfterPreparation = await this.repository.findTrain(
      train.id,
      {},
      false,
      true
    );
    if (
      currentAfterPreparation &&
      TERMINAL_TRAINS.has(currentAfterPreparation.status)
    )
      return;
    const failedOperations = [
      frontend.failedOperation,
      backend.failedOperation
    ].filter(
      (operation): operation is ReleaseBusV2OperationRecord =>
        operation !== null
    );
    if (failedOperations.length > 0) {
      const interactionFailure = failedOperations.find(
        ({ failure_class }) => failure_class === 'INTERACTION'
      );
      if (interactionFailure) {
        if (
          train.lane === 'PRODUCTION' &&
          (await this.deferMovedProductionPlan(context))
        )
          return;
        if (
          train.lane === 'STAGING' &&
          (await this.deferSupersededStagingPlan(context))
        )
          return;
      }
      const nonCandidateFailure = failedOperations.find(
        ({ failure_class }) => failure_class !== 'CANDIDATE'
      );
      if (nonCandidateFailure) {
        await this.failTrain(
          train,
          nonCandidateFailure.failure_class ?? 'CONTROL_PLANE',
          nonCandidateFailure.failure_message ??
            `${nonCandidateFailure.operation_type} failed`
        );
        return;
      }
      if (train.lane === 'STAGING') {
        await this.failStagingRepositoryCandidateGroups(
          context,
          failedOperations
        );
        return;
      }
      const failed = failedOperations[0];
      if (
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
      await this.transitionTrain(train, {
        status: 'PREFLIGHTING',
        frontendComposedSha: frontend.composedSha,
        backendComposedSha: backend.composedSha,
        frontendArtifactDigest: null,
        backendArtifactDigest: null,
        manifestId: null,
        recoveryMessage: usesCandidateEvidence
          ? 'Fresh production composition is preparing environment-bound immutable artifacts against the current trusted production bases'
          : 'Production is freshly packaging its exact composition; staging artifact bytes are evidence only and are never production inputs'
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
    const evidenceCandidates = candidateEvidenceCandidates(context, repository);
    const deployCandidates = stagingDeploymentCandidates(context, repository);
    const releaseParentSha = cumulativeStagingReleaseParent(
      context,
      repository
    );
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) throw new Error(`Missing ${repository} base SHA`);
    if (deployCandidates.length === 0) {
      return {
        repository,
        composedSha: releaseParentSha ?? baseSha,
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
      !(
        train.lane === 'PRODUCTION' &&
        train.qualification_policy === CANDIDATE_STAGING_EVIDENCE_POLICY
      ) &&
      candidates.length === 1 &&
      canUseSingleCandidateFastPath(candidates[0], baseSha)
        ? candidates[0]
        : null;
    const releaseFastCandidate = releaseParentSha ? null : fastCandidate;
    const evidenceSelection = candidateEvidenceSelectionForPreparation(
      evidenceCandidates,
      releaseFastCandidate?.id ?? null
    );
    let initialComposedSha: string | null | undefined = null;
    if (!releaseParentSha)
      initialComposedSha =
        candidates.length === 0
          ? baseSha
          : prEvidence(releaseFastCandidate ?? candidates[0])?.merge_sha;
    let composedSha = storedComposedSha ?? initialComposedSha;
    if (
      !storedComposedSha &&
      !releaseFastCandidate &&
      (candidates.length > 0 || releaseParentSha)
    ) {
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
            candidates.length > 0
              ? candidates.map(({ head_sha }) => head_sha)
              : [baseSha]
          ),
          release_branch: releaseBusV2Branch(train, repository),
          release_parent_sha: releaseParentSha ?? ''
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
    if (releaseFastCandidate || candidates.length === 0) {
      // The compose workflow creates the immutable release ref for multi-PR
      // trains. The single-PR fast path skips that workflow, so bind the same
      // lane-scoped ref here before any artifact preparation or deployment.
      // createRef is idempotent only when an existing ref already resolves to
      // this exact SHA; a moved or conflicting ref fails closed.
      await releaseBusGitHubApp.createRef(
        repository,
        releaseBusV2Branch(train, repository),
        composedSha
      );
    }
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
    const graph =
      repository === 'backend'
        ? backendGraph(
            deployCandidates,
            train.lane === 'PRODUCTION' ? 'prod' : 'staging'
          )
        : null;
    const evidence = evidenceSelection.singular;
    const artifactEnvironment = artifactEnvironmentForTrain(train);
    const artifactContract =
      evidenceSelection.mode === 'legacy-whole-train'
        ? 'legacy-v2'
        : ENVIRONMENT_BOUND_ARTIFACT_CONTRACT;
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
        source_ref: releaseBusV2Branch(train, repository),
        expected_sha: composedSha,
        deploy_units: JSON.stringify(graph?.units ?? []),
        ...(repository === 'backend'
          ? { deploy_layers: JSON.stringify(graph?.layers ?? []) }
          : {}),
        reuse_artifact_run_id: evidence?.artifact_run_id ?? '',
        reuse_artifact_name: evidence?.artifact_name ?? '',
        reuse_artifact_digest: evidence?.artifact_digest ?? '',
        candidate_evidence_mode: evidenceSelection.mode,
        aggregate_candidate_evidence_digest:
          evidenceSelection.aggregateDigest ?? '',
        artifact_environment:
          artifactContract === 'legacy-v2' && repository === 'backend'
            ? ''
            : artifactEnvironment,
        artifact_contract_version: artifactContract
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
    if (context.train.lane === 'STAGING')
      throw new Error(
        'Ordinary staging never runs deterministic candidate subset isolation'
      );
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
      context.train.qualification_policy === CANDIDATE_STAGING_EVIDENCE_POLICY
        ? CANDIDATE_EVIDENCE_READY_STATUS
        : 'READY_FOR_PRODUCTION';
    const failedCandidates: ReleaseBusV2CandidateRecord[] = [];
    const blockedCandidates: ReleaseBusV2CandidateRecord[] = [];
    const returnedCandidates: ReleaseBusV2CandidateRecord[] = [];

    for (const candidate of relevantCandidates(context)) {
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (
        !current ||
        ['SUPERSEDED', 'CANCELLED', 'DEREGISTERED'].includes(current.status)
      )
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

  private async failStagingRepositoryCandidateGroups(
    context: TrainContext,
    failedOperations: ReadonlyArray<
      Pick<
        ReleaseBusV2OperationRecord,
        'id' | 'repository' | 'failure_class' | 'failure_message'
      >
    >
  ): Promise<void> {
    const failedRepositories = new Set(
      failedOperations
        .map(({ repository }) => repository)
        .filter(
          (repository): repository is ReleaseBusV2Repository =>
            repository === 'frontend' || repository === 'backend'
        )
    );
    if (failedRepositories.size === 0)
      throw new Error(
        'Staging candidate preflight failure has no repository identity'
      );
    const stillRunningIds = await this.observeAlreadyDispatchedWorkflows(
      context.train
    );
    if (stillRunningIds.length > 0) {
      const recoveryMessage = `Combined ${Array.from(failedRepositories).join('+')} preflight failed; subset isolation is disabled and unrelated candidates will be replanned after already-dispatched workflows drain; observing operations: ${stillRunningIds.join(',')}`;
      if (context.train.recovery_message !== recoveryMessage)
        await this.transitionTrain(context.train, {
          status: 'PREFLIGHTING',
          recoveryMessage
        });
      return;
    }
    const mutable = stagingStatusCandidates(context);
    const failedIds = new Set(
      mutable
        .filter(({ repository }) => failedRepositories.has(repository))
        .map(({ id }) => id)
    );
    const blockedIds = candidateExclusionClosure(
      Array.from(failedIds),
      context.dependencies
    );
    const failed: ReleaseBusV2CandidateRecord[] = [];
    const blocked: ReleaseBusV2CandidateRecord[] = [];
    const returned: ReleaseBusV2CandidateRecord[] = [];
    for (const candidate of mutable) {
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (
        !current ||
        ['SUPERSEDED', 'CANCELLED', 'DEREGISTERED'].includes(current.status)
      )
        continue;
      const repositoryFailed = failedIds.has(candidate.id);
      const dependencyBlocked =
        !repositoryFailed && blockedIds.has(candidate.id);
      const status: ReleaseBusV2CandidateStatus = repositoryFailed
        ? 'FAILED'
        : dependencyBlocked
          ? 'WAITING_FOR_DEPENDENCY'
          : 'READY_FOR_STAGING';
      const holdReason = repositoryFailed
        ? `Combined ${candidate.repository} preflight failed for this train's NEW candidate group`
        : dependencyBlocked
          ? 'A required repository candidate group failed combined preflight'
          : null;
      if (
        !(await this.repository.updateCandidate(
          current.id,
          current.row_version,
          { status, currentTrainId: null, holdReason },
          {}
        ))
      )
        throw new Error('Candidate changed concurrently');
      if (repositoryFailed)
        await this.repository.appendEvent(
          {
            trainId: context.train.id,
            candidateId: current.id,
            eventType: 'STAGING_REPOSITORY_PREFLIGHT_GROUP_FAILED',
            actor: 'release-bus-v2',
            payload: {
              repository: current.repository,
              pr_number: current.pr_number,
              head_sha: current.head_sha,
              failed_candidate_row_version: current.row_version + 1,
              failed_group_candidate_ids: mutable
                .filter(
                  (item) =>
                    item.repository === current.repository &&
                    failedIds.has(item.id)
                )
                .map(({ id }) => id),
              failed_operation_ids: failedOperations
                .filter(
                  (operation) =>
                    operation.repository === current.repository &&
                    operation.failure_class === 'CANDIDATE'
                )
                .map(({ id }) => id),
              failure_messages: failedOperations
                .filter(
                  (operation) =>
                    operation.repository === current.repository &&
                    operation.failure_class === 'CANDIDATE'
                )
                .map(({ failure_message }) => failure_message)
                .filter((message): message is string => Boolean(message))
            }
          },
          {}
        );
      await this.repository.updateTrainCandidateDisposition(
        context.train.id,
        current.id,
        repositoryFailed
          ? 'REPOSITORY_PREFLIGHT_FAILED'
          : dependencyBlocked
            ? 'DEPENDENCY_EXCLUDED'
            : 'RETURNED_TO_QUEUE',
        {}
      );
      if (repositoryFailed) failed.push(current);
      else if (dependencyBlocked) blocked.push(current);
      else returned.push(current);
    }
    await Promise.all([
      this.publishCandidateStatuses(
        failed,
        'failure',
        'Combined repository preflight failed for this NEW candidate group'
      ),
      this.publishCandidateStatuses(
        blocked,
        'pending',
        'Waiting because a required repository candidate group failed'
      ),
      this.publishCandidateStatuses(
        returned,
        'pending',
        'Independent repository candidate returned to the next staging train'
      )
    ]);
    const current = await this.repository.findTrain(
      context.train.id,
      {},
      false,
      true
    );
    if (current && !TERMINAL_TRAINS.has(current.status))
      await this.transitionTrain(current, {
        status: 'FAILED',
        failureClass: 'CANDIDATE',
        failureMessage: `Combined preflight failed for NEW ${Array.from(failedRepositories).join('+')} candidate group(s)`,
        recoveryMessage:
          'Failing repository NEW groups are terminal; dependency-blocked candidates are held and independent repository NEW candidates are immediately eligible for a new train',
        completedAt: Date.now()
      });
    await this.releaseTerminalEnvironmentLocks();
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
    const graph =
      repository === 'backend'
        ? backendGraph(
            candidates,
            train.lane === 'PRODUCTION' ? 'prod' : 'staging'
          )
        : null;
    const evidenceSelection = candidateEvidenceSelection(candidates, null);
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
        ...(repository === 'backend'
          ? { deploy_layers: JSON.stringify(graph?.layers ?? []) }
          : {}),
        reuse_artifact_run_id: '',
        reuse_artifact_name: '',
        reuse_artifact_digest: '',
        candidate_evidence_mode: evidenceSelection.mode,
        aggregate_candidate_evidence_digest:
          evidenceSelection.aggregateDigest ?? '',
        artifact_environment:
          evidenceSelection.mode === 'legacy-whole-train' &&
          repository === 'backend'
            ? ''
            : artifactEnvironmentForTrain(train),
        artifact_contract_version:
          evidenceSelection.mode === 'legacy-whole-train'
            ? 'legacy-v2'
            : ENVIRONMENT_BOUND_ARTIFACT_CONTRACT
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
    if (
      context.train.lane === 'STAGING' &&
      context.train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
    ) {
      const newCandidates = stagingStatusCandidates(context);
      for (const candidate of newCandidates) {
        const current = await this.repository.findCandidateById(
          candidate.id,
          {},
          false,
          true
        );
        if (!current) continue;
        await this.repository.updateCandidate(
          current.id,
          current.row_version,
          {
            status: excludedShas.has(current.head_sha)
              ? 'NEEDS_REBASE'
              : 'READY_FOR_STAGING',
            currentTrainId: null,
            holdReason: excludedShas.has(current.head_sha)
              ? 'Cumulative composition conflicted; the admitted staging manifest was left unchanged'
              : 'Cumulative train failed closed because one exact candidate conflicted'
          },
          {}
        );
      }
      await this.transitionTrain(context.train, {
        status: 'FAILED',
        failureClass: 'CANDIDATE',
        failureMessage:
          'Cumulative staging composition conflicted; no candidate was omitted and shared staging was not mutated',
        recoveryMessage:
          'The last validated admitted staging manifest remains authoritative and live',
        completedAt: Date.now()
      });
      await this.repository.appendEvent(
        {
          trainId: context.train.id,
          eventType: 'CUMULATIVE_STAGING_COMPOSITION_FAILED_CLOSED',
          actor: 'release-bus-v2',
          payload: {
            excluded_shas: Array.from(excludedShas),
            baseline_manifest_id: context.train.staging_baseline_manifest_id,
            admitted_candidate_ids: relevantCandidates(context)
              .filter(
                ({ id }) =>
                  !newCandidates.some((candidate) => candidate.id === id)
              )
              .map(({ id }) => id)
          }
        },
        {}
      );
      return true;
    }
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
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (
        !current ||
        ['SUPERSEDED', 'CANCELLED', 'DEREGISTERED'].includes(current.status)
      )
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

  private async beginCumulativeStagingRollback(
    train: ReleaseBusV2TrainRecord,
    failureClass: ReleaseBusV2FailureClass,
    message: string
  ): Promise<void> {
    if (train.manifest_id)
      await this.repository.updateManifestStatus(
        train.manifest_id,
        'FAILED',
        null,
        {}
      );
    if (!train.staging_baseline_manifest_id) {
      const current = await this.repository.findTrain(
        train.id,
        {},
        false,
        true
      );
      if (!current || TERMINAL_TRAINS.has(current.status)) return;
      const context = await this.loadContext(current);
      const transition = parseStoredJson<ReleaseBusV2StagingTransition>(
        current.staging_transition_json
      );
      const newCandidateIds = new Set(
        transition?.new_candidate_ids ??
          context.memberships
            .filter(({ candidate_role }) => candidate_role === 'NEW')
            .map(({ candidate_id }) => candidate_id)
      );
      const newCandidates = context.candidates.filter(({ id }) =>
        newCandidateIds.has(id)
      );
      await this.updateCandidateStatuses(
        newCandidates,
        'READY_FOR_STAGING',
        null,
        false
      );
      await this.repository.appendEvent(
        {
          trainId: current.id,
          eventType: 'CUMULATIVE_STAGING_CLEAN_MAIN_RECOVERY_REQUIRED',
          actor: 'release-bus-v2',
          payload: {
            failed_manifest_id: current.manifest_id,
            failure_class: failureClass,
            failure_message: message,
            requeued_new_candidate_ids: newCandidates.map(({ id }) => id),
            recovery_policy: 'SERIALIZED_MANUAL_STAGING_RECOVERY'
          }
        },
        {}
      );
      await this.failCumulativeStagingRollback(
        context,
        `The first cumulative train failed after staging mutation without a validated baseline to restore: ${message}`
      );
      await this.publishCandidateStatuses(
        newCandidates,
        'error',
        'First cumulative staging release needs serialized recovery; exact candidate intent was retained'
      );
      return;
    }
    await this.repository.appendEvent(
      {
        trainId: train.id,
        eventType: 'CUMULATIVE_STAGING_ROLLBACK_STARTED',
        actor: 'release-bus-v2',
        payload: {
          baseline_manifest_id: train.staging_baseline_manifest_id,
          failed_manifest_id: train.manifest_id,
          failure_class: failureClass,
          failure_message: message,
          rollback_policy: 'RESTORE_VALIDATED_STAGING_V1'
        }
      },
      {}
    );
    await this.transitionTrain(train, {
      status: 'STAGING_ROLLING_BACK',
      failureClass,
      failureMessage: message,
      recoveryMessage:
        'Restoring the exact last successfully validated live manifest before releasing staging ownership'
    });
  }

  private rollbackBranch(
    train: ReleaseBusV2TrainRecord,
    repository: ReleaseBusV2Repository
  ): string {
    return `release-bus-v2/rollback-train-${train.id}-${repository}`;
  }

  private async cumulativeRollbackBaseline(context: TrainContext): Promise<{
    readonly manifest: ReleaseBusV2ManifestRecord;
    readonly candidateIds: readonly string[];
    readonly frontendSha: string;
    readonly backendSha: string;
    readonly graph: ReturnType<typeof backendGraph>;
    readonly deployFrontend: boolean;
  }> {
    const manifestId = context.train.staging_baseline_manifest_id;
    if (!manifestId)
      throw new Error('Cumulative rollback has no baseline manifest');
    const manifest = await this.repository.findManifest(manifestId, {});
    if (!manifest?.frontend_sha || !manifest.backend_sha)
      throw new Error('Cumulative rollback baseline identity is incomplete');
    const body = parseStoredJson<{
      candidates?: Array<{
        candidate_id?: string;
        repository?: ReleaseBusV2Repository;
        pr_number?: number;
        head_sha?: string;
      }>;
    }>(manifest.manifest_json);
    const resolvedCandidateIds = (body?.candidates ?? []).map((entry) => {
      const id =
        entry.candidate_id ??
        context.candidates.find(
          (candidate) =>
            candidate.repository === entry.repository &&
            candidate.pr_number === entry.pr_number &&
            candidate.head_sha === entry.head_sha
        )?.id;
      if (!id)
        throw new Error(
          `Cumulative rollback baseline manifest ${manifestId} has an unresolvable candidate identity`
        );
      return id;
    });
    const candidateIds = Array.from(new Set(resolvedCandidateIds));
    return {
      manifest,
      candidateIds,
      frontendSha: manifest.frontend_sha,
      backendSha: manifest.backend_sha,
      graph: backendGraph(
        stagingDeploymentCandidates(context, 'backend'),
        'staging'
      ),
      deployFrontend:
        stagingDeploymentCandidates(context, 'frontend').length > 0
    };
  }

  private async prepareCumulativeRollbackRepository(
    context: TrainContext,
    repository: ReleaseBusV2Repository
  ): Promise<PreparedRepository> {
    const train = context.train;
    const baseline = await this.cumulativeRollbackBaseline(context);
    const selected =
      repository === 'frontend'
        ? baseline.deployFrontend
        : baseline.graph.units.length > 0;
    const composedSha =
      repository === 'frontend' ? baseline.frontendSha : baseline.backendSha;
    const releaseParentSha =
      repository === 'frontend'
        ? train.frontend_composed_sha
        : train.backend_composed_sha;
    if (!releaseParentSha)
      throw new Error(
        `Cumulative rollback has no ${repository} release parent`
      );
    if (!selected)
      return {
        repository,
        composedSha: releaseParentSha,
        artifactDigest: null,
        pending: false,
        failedOperation: null
      };
    const branch = this.rollbackBranch(train, repository);
    const composition = await releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(train.id, `rollback:compose:${repository}`),
      trainId: train.id,
      operationType: `ROLLBACK_COMPOSE_${repository.toUpperCase()}`,
      repository,
      workflow: 'release-bus-v2-compose.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: composedSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: ROLLBACK_ARTIFACT_REVISION,
        operation_key: 'replaced-by-reconciler',
        base_sha: composedSha,
        expected_sha: composedSha,
        candidate_shas: JSON.stringify([composedSha]),
        release_branch: branch,
        release_parent_sha: releaseParentSha
      },
      maxAttempts: 3
    });
    if (composition.status === 'FAILED')
      return {
        repository,
        composedSha: '',
        artifactDigest: null,
        pending: false,
        failedOperation: composition
      };
    if (composition.status !== 'SUCCEEDED')
      return {
        repository,
        composedSha: '',
        artifactDigest: null,
        pending: true,
        failedOperation: null
      };
    const rollbackSha = await releaseBusGitHubApp.resolveRef(
      repository,
      branch
    );
    const evidenceSelection = rollbackEvidenceSelectionForPreparation();
    const operation = await releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(train.id, `rollback:prepare:${repository}`),
      trainId: train.id,
      operationType: `ROLLBACK_PREPARE_ARTIFACT_${repository.toUpperCase()}`,
      repository,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: rollbackSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: 'rollback-1',
        operation_key: 'replaced-by-reconciler',
        source_ref: branch,
        expected_sha: rollbackSha,
        deploy_units:
          repository === 'backend'
            ? JSON.stringify(baseline.graph.units)
            : '[]',
        ...(repository === 'backend'
          ? { deploy_layers: JSON.stringify(baseline.graph.layers) }
          : {}),
        reuse_artifact_run_id: '',
        reuse_artifact_name: '',
        reuse_artifact_digest: '',
        candidate_evidence_mode: evidenceSelection.mode,
        aggregate_candidate_evidence_digest:
          evidenceSelection.aggregateDigest ?? '',
        artifact_environment:
          evidenceSelection.mode === 'legacy-whole-train' &&
          repository === 'backend'
            ? ''
            : 'staging',
        artifact_contract_version:
          evidenceSelection.mode === 'legacy-whole-train'
            ? 'legacy-v2'
            : ENVIRONMENT_BOUND_ARTIFACT_CONTRACT
      },
      maxAttempts: 3
    });
    return {
      repository,
      composedSha: rollbackSha,
      artifactDigest: operation.artifact_digest,
      pending: !['SUCCEEDED', 'FAILED'].includes(operation.status),
      failedOperation: operation.status === 'FAILED' ? operation : null
    };
  }

  private async reconcileCumulativeRollbackDeployments(
    context: TrainContext,
    frontendArtifact: ReleaseBusV2OperationRecord | null,
    backendArtifact: ReleaseBusV2OperationRecord | null,
    frontendReleaseSha: string,
    backendReleaseSha: string
  ): Promise<DeployResult> {
    const train = context.train;
    const baseline = await this.cumulativeRollbackBaseline(context);
    const baselineCandidates = context.candidates.filter((candidate) =>
      baseline.candidateIds.includes(candidate.id)
    );
    const backendCandidates = baselineCandidates.filter(
      ({ repository }) => repository === 'backend'
    );
    const frontendCandidates = baselineCandidates.filter(
      ({ repository }) => repository === 'frontend'
    );
    const backendArtifactBinding =
      backendCandidates.length > 0 && backendArtifact
        ? preparedArtifactDeployBinding(backendArtifact, 'staging')
        : null;
    const frontendArtifactBinding =
      frontendCandidates.length > 0 && frontendArtifact
        ? preparedArtifactDeployBinding(frontendArtifact, 'staging')
        : null;
    const operations: ReleaseBusV2OperationRecord[] = [];
    const existing = await this.repository.listOperations(train.id, {});
    let backendComplete = baseline.graph.units.length === 0;
    for (const layer of baseline.graph.layers) {
      const previous = baseline.graph.layers
        .slice(0, baseline.graph.layers.indexOf(layer))
        .flat();
      if (
        !previous.every((unit) =>
          [...existing, ...operations].some(
            ({ operation_type, status }) =>
              operation_type === `ROLLBACK_DEPLOY_BACKEND_STAGING_${unit}` &&
              status === 'SUCCEEDED'
          )
        )
      )
        break;
      const results = await Promise.all(
        layer.map((unit) => {
          if (!backendArtifact?.external_id || !backendArtifact.artifact_digest)
            throw new Error('Rollback backend artifact identity is missing');
          return releaseBusV2Operations.reconcileWorkflow({
            idempotencyKey: operationKey(
              train.id,
              `rollback:deploy:staging:backend:${unit}`
            ),
            trainId: train.id,
            operationType: `ROLLBACK_DEPLOY_BACKEND_STAGING_${unit}`,
            repository: 'backend',
            workflow: 'deploy.yml',
            ref: 'main',
            environment: 'staging',
            service: unit,
            expectedSha: backendReleaseSha,
            artifactDigest: backendArtifact.artifact_digest,
            inputs: {
              environment: 'staging',
              service: unit,
              release_train_id: train.id,
              release_train_revision: ROLLBACK_ARTIFACT_REVISION,
              operation_key: 'replaced-by-reconciler',
              expected_sha: backendReleaseSha,
              artifact_run_id: backendArtifact.external_id,
              artifact_train_id: train.id,
              artifact_digest: backendArtifact.artifact_digest,
              artifact_environment:
                backendArtifactBinding?.artifact_environment ?? '',
              artifact_contract_version:
                backendArtifactBinding?.artifact_contract_version ??
                'legacy-v2',
              release_contributors: '[]',
              release_pull_request: '',
              release_group_services: '',
              release_note_publish: 'false',
              release_note_groups: '',
              release_note_opt_out: 'true'
            }
          });
        })
      );
      operations.push(...results);
      const failed = results.find(({ status }) => status === 'FAILED');
      if (failed)
        return { complete: false, failedOperation: failed, operations };
      if (results.some(({ status }) => status !== 'SUCCEEDED')) break;
      if (layer === baseline.graph.layers.at(-1)) backendComplete = true;
    }
    if (!backendComplete)
      return { complete: false, failedOperation: null, operations };
    let frontendComplete = !baseline.deployFrontend;
    if (baseline.deployFrontend) {
      if (!frontendArtifact?.external_id || !frontendArtifact.artifact_digest)
        throw new Error('Rollback frontend artifact identity is missing');
      const frontend = await releaseBusV2Operations.reconcileWorkflow({
        idempotencyKey: operationKey(
          train.id,
          'rollback:deploy:staging:frontend'
        ),
        trainId: train.id,
        operationType: 'ROLLBACK_DEPLOY_FRONTEND_STAGING',
        repository: 'frontend',
        workflow: 'release-bus-deploy-staging.yml',
        ref: 'main',
        environment: 'staging',
        service: null,
        expectedSha: frontendReleaseSha,
        artifactDigest: frontendArtifact.artifact_digest,
        inputs: {
          release_train_id: train.id,
          release_train_revision: ROLLBACK_ARTIFACT_REVISION,
          operation_key: 'replaced-by-reconciler',
          source_ref: this.rollbackBranch(train, 'frontend'),
          expected_sha: frontendReleaseSha,
          artifact_run_id: frontendArtifact.external_id,
          artifact_train_id: train.id,
          artifact_digest: frontendArtifact.artifact_digest,
          ...frontendDeployBinding(
            frontendArtifactBinding ?? {
              artifact_environment: '',
              artifact_contract_version: 'legacy-v2'
            },
            'staging'
          ),
          release_contributors: '[]'
        }
      });
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

  private async advanceCumulativeRollbackRefs(
    context: TrainContext,
    frontendReleaseSha: string,
    backendReleaseSha: string
  ): Promise<boolean> {
    const train = context.train;
    const selected = (['backend', 'frontend'] as const).filter(
      (repository) =>
        stagingDeploymentCandidates(context, repository).length > 0
    );
    const current = await Promise.all(
      selected.map(async (repository) => ({
        repository,
        observedSha: await releaseBusGitHubApp.resolveRef(
          repository,
          '1a-staging'
        ),
        baseSha:
          repository === 'frontend'
            ? train.frontend_composed_sha
            : train.backend_composed_sha,
        targetSha:
          repository === 'frontend' ? frontendReleaseSha : backendReleaseSha
      }))
    );
    const invalid = current.find(
      ({ observedSha, baseSha, targetSha }) =>
        !baseSha || (observedSha !== baseSha && observedSha !== targetSha)
    );
    // targetSha is accepted because GitHub may have applied one repository's
    // CAS before the worker crashed; advanceStagingRef records that leg as
    // succeeded and continues the still-pending repository.
    if (invalid)
      throw new StagingRefMovedError(
        `${invalid.repository} 1a-staging moved outside rollback intent ${invalid.baseSha} -> ${invalid.targetSha}`
      );
    const ready = await Promise.all(
      current.map((item) =>
        this.advanceStagingRef(
          train,
          item.repository,
          item.observedSha,
          item.baseSha!,
          item.targetSha,
          'rollback'
        )
      )
    );
    return ready.every(Boolean);
  }

  private async createCumulativeRollbackManifest(
    context: TrainContext,
    frontendArtifact: ReleaseBusV2OperationRecord | null,
    backendArtifact: ReleaseBusV2OperationRecord | null,
    frontendReleaseSha: string,
    backendReleaseSha: string
  ): Promise<ReleaseBusV2ManifestRecord> {
    const baseline = await this.cumulativeRollbackBaseline(context);
    const operations = await this.repository.listOperations(
      context.train.id,
      {}
    );
    const identity = {
      train_id: context.train.id,
      lane: context.train.lane,
      scope: 'cumulative-staging-rollback',
      staging_policy: 'RESTORE_VALIDATED_STAGING_V1',
      source_manifest_id: baseline.manifest.id,
      frontend_sha: frontendReleaseSha,
      backend_sha: backendReleaseSha,
      frontend_staging_ref_sha: frontendReleaseSha,
      backend_staging_ref_sha: backendReleaseSha,
      frontend_artifact_digest: frontendArtifact?.artifact_digest ?? null,
      backend_artifact_digest: backendArtifact?.artifact_digest ?? null,
      candidates: baseline.candidateIds
    };
    return this.repository.createManifest(
      {
        train_id: context.train.id,
        lane: context.train.lane,
        identity_sha256: sha256(identity),
        status: 'STAGING_DEPLOYED',
        frontend_sha: frontendReleaseSha,
        backend_sha: backendReleaseSha,
        frontend_artifact_digest: frontendArtifact?.artifact_digest ?? null,
        backend_artifact_digest: backendArtifact?.artifact_digest ?? null,
        e2e_run_id: null,
        manifest_json: {
          schema_version: 2,
          ...identity,
          candidates:
            parseStoredJson<{ candidates?: unknown[] }>(
              baseline.manifest.manifest_json
            )?.candidates ?? [],
          operations: operations
            .filter(({ operation_type }) =>
              operation_type.startsWith('ROLLBACK_')
            )
            .map(
              ({
                operation_type,
                service,
                expected_sha,
                external_id,
                completed_at
              }) => ({
                type: operation_type,
                service,
                expected_sha,
                workflow_run_id: external_id,
                completed_at
              })
            )
        },
        deployed_at: Date.now(),
        validated_at: null
      },
      {}
    );
  }

  private async reconcileCumulativeRollbackE2E(
    context: TrainContext,
    manifest: ReleaseBusV2ManifestRecord,
    frontendReleaseSha: string,
    backendReleaseSha: string
  ): Promise<ReleaseBusV2OperationRecord> {
    const sourceRef = this.rollbackBranch(context.train, 'frontend');
    await releaseBusGitHubApp.createRef(
      'frontend',
      sourceRef,
      frontendReleaseSha
    );
    return releaseBusV2Operations.reconcileWorkflow({
      idempotencyKey: operationKey(context.train.id, 'rollback:e2e:staging'),
      trainId: context.train.id,
      operationType: 'ROLLBACK_E2E_STAGING',
      repository: 'frontend',
      workflow: 'staging-e2e.yml',
      ref: sourceRef,
      environment: 'staging',
      service: null,
      expectedSha: frontendReleaseSha,
      artifactDigest: manifest.identity_sha256,
      inputs: e2eWorkflowInputs('staging', {
        release_train_id: context.train.id,
        release_train_revision: ROLLBACK_ARTIFACT_REVISION,
        operation_key: 'replaced-by-reconciler',
        staging_source_ref: sourceRef,
        expected_sha: frontendReleaseSha,
        release_manifest_id: manifest.id,
        release_manifest_identity_sha256: manifest.identity_sha256,
        frontend_sha: frontendReleaseSha,
        backend_sha: backendReleaseSha,
        frontend_artifact_digest: manifest.frontend_artifact_digest ?? '',
        backend_artifact_digest: manifest.backend_artifact_digest ?? ''
      }),
      maxAttempts: 2
    });
  }

  private async advanceCumulativeStagingRollback(
    context: TrainContext
  ): Promise<void> {
    const train = context.train;
    const [frontendPreparation, backendPreparation] = await Promise.all([
      this.prepareCumulativeRollbackRepository(context, 'frontend'),
      this.prepareCumulativeRollbackRepository(context, 'backend')
    ]);
    if (
      frontendPreparation.failedOperation ||
      backendPreparation.failedOperation
    ) {
      if (frontendPreparation.pending || backendPreparation.pending) return;
      await this.failCumulativeStagingRollback(
        context,
        (
          frontendPreparation.failedOperation ??
          backendPreparation.failedOperation
        )?.failure_message ?? 'Rollback artifact preparation failed'
      );
      return;
    }
    if (frontendPreparation.pending || backendPreparation.pending) return;
    const operations = await this.repository.listOperations(train.id, {});
    const frontendArtifact =
      operations.find(
        ({ operation_type, status }) =>
          operation_type === 'ROLLBACK_PREPARE_ARTIFACT_FRONTEND' &&
          status === 'SUCCEEDED'
      ) ?? null;
    const backendArtifact =
      operations.find(
        ({ operation_type, status }) =>
          operation_type === 'ROLLBACK_PREPARE_ARTIFACT_BACKEND' &&
          status === 'SUCCEEDED'
      ) ?? null;
    const frontendReleaseSha = frontendPreparation.composedSha;
    const backendReleaseSha = backendPreparation.composedSha;
    const rollbackRefsReady = await this.advanceCumulativeRollbackRefs(
      context,
      frontendReleaseSha,
      backendReleaseSha
    );
    if (!rollbackRefsReady) return;
    const deployed = await this.reconcileCumulativeRollbackDeployments(
      context,
      frontendArtifact,
      backendArtifact,
      frontendReleaseSha,
      backendReleaseSha
    );
    if (deployed.failedOperation) {
      await this.failCumulativeStagingRollback(
        context,
        deployed.failedOperation.failure_message ?? 'Rollback deployment failed'
      );
      return;
    }
    if (!deployed.complete) return;
    let manifest: ReleaseBusV2ManifestRecord | null = null;
    if (train.manifest_id) {
      const candidate = await this.repository.findManifest(
        train.manifest_id,
        {}
      );
      const body = parseStoredJson<{ scope?: string }>(
        candidate?.manifest_json
      );
      if (body?.scope === 'cumulative-staging-rollback') manifest = candidate;
    }
    manifest ??= await this.createCumulativeRollbackManifest(
      context,
      frontendArtifact,
      backendArtifact,
      frontendReleaseSha,
      backendReleaseSha
    );
    if (train.manifest_id !== manifest.id) {
      await this.transitionTrain(train, {
        status: 'STAGING_ROLLING_BACK',
        manifestId: manifest.id,
        failureClass: train.failure_class,
        failureMessage: train.failure_message,
        recoveryMessage:
          'The exact prior manifest is restored; rollback E2E is now required before releasing staging'
      });
      return;
    }
    const e2e = await this.reconcileCumulativeRollbackE2E(
      context,
      manifest,
      frontendReleaseSha,
      backendReleaseSha
    );
    if (e2e.status === 'FAILED') {
      await this.failCumulativeStagingRollback(
        context,
        e2e.failure_message ?? 'Rollback staging E2E failed'
      );
      return;
    }
    if (e2e.status !== 'SUCCEEDED') return;
    const handshake = await this.findStagingIdleHandshake(train.id);
    const runIds = await this.stagingFenceRunIds(train.id);
    const stable =
      handshake &&
      (await this.captureStagingIdleSnapshot({
        since: handshake.workflow_fence_started_at,
        ignoredRunIds: runIds
      }));
    if (
      !stable ||
      stable.frontend_staging_sha !== frontendReleaseSha ||
      stable.backend_staging_sha !== backendReleaseSha
    ) {
      await this.failCumulativeStagingRollback(
        context,
        'Shared staging changed during rollback; the restored runtime cannot be certified'
      );
      return;
    }
    await this.repository.updateManifestStatus(
      manifest.id,
      'STAGING_VALIDATED',
      e2e.external_id,
      {}
    );
    const baseline = await this.cumulativeRollbackBaseline(context);
    const statusCandidates = stagingStatusCandidates(context);
    const supersededHeadRollback = statusCandidates.some(
      ({ status }) => status === 'SUPERSEDED'
    );
    const terminalCandidateStatus: ReleaseBusV2CandidateStatus = [
      'INFRASTRUCTURE',
      'CONTROL_PLANE'
    ].includes(train.failure_class ?? '')
      ? 'READY_FOR_STAGING'
      : 'FAILED';
    const commitResult =
      await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const lockedState = await this.repository.getStagingState(
            { connection },
            true
          );
          if (
            lockedState.last_transition_train_id === train.id &&
            lockedState.current_manifest_id === manifest.id
          )
            return 'ALREADY_COMMITTED' as const;
          // The current manifest identity is the authoritative epoch check.
          // Any newer staging transition makes this callback a safe no-op.
          if (
            lockedState.current_manifest_id !==
            train.staging_baseline_manifest_id
          )
            return 'SUPERSEDED' as const;
          await this.repository.commitValidatedStaging(
            {
              trainId: train.id,
              expectedStateVersion: lockedState.row_version,
              manifestId: manifest.id,
              frontendSha: frontendReleaseSha,
              backendSha: backendReleaseSha,
              frontendStagingRefSha: frontendReleaseSha,
              backendStagingRefSha: backendReleaseSha,
              admittedCandidateIds: baseline.candidateIds,
              removedCandidateIds: [],
              newCandidateIds: []
            },
            { connection }
          );
          return 'COMMITTED' as const;
        }
      );
    if (commitResult === 'SUPERSEDED') {
      if (supersededHeadRollback)
        await this.replanSupersededStagingCandidates(
          context,
          train.failure_message ??
            'Active staging candidate head was superseded'
        );
      else
        await this.updateCandidateStatuses(
          statusCandidates,
          terminalCandidateStatus,
          null,
          false
        );
      const current = await this.repository.findTrain(
        train.id,
        {},
        false,
        true
      );
      if (current && !TERMINAL_TRAINS.has(current.status))
        await this.transitionTrain(current, {
          status: 'FAILED',
          failureClass: train.failure_class,
          failureMessage: train.failure_message,
          recoveryMessage:
            'A newer authoritative staging transition superseded this stale rollback callback; current live state was not changed',
          completedAt: Date.now()
        });
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'CUMULATIVE_STAGING_ROLLBACK_SUPERSEDED',
          actor: 'release-bus-v2',
          payload: {
            source_manifest_id: train.staging_baseline_manifest_id,
            attempted_restored_manifest_id: manifest.id
          }
        },
        {}
      );
      await this.releaseTerminalEnvironmentLocks();
      return;
    }
    if (supersededHeadRollback)
      await this.replanSupersededStagingCandidates(
        context,
        train.failure_message ?? 'Active staging candidate head was superseded'
      );
    else
      await this.updateCandidateStatuses(
        statusCandidates,
        terminalCandidateStatus,
        null,
        false
      );
    const current = await this.repository.findTrain(train.id, {}, false, true);
    if (!current) throw new Error('Rollback train disappeared');
    if (TERMINAL_TRAINS.has(current.status)) {
      await this.releaseTerminalEnvironmentLocks();
      return;
    }
    await this.transitionTrain(current, {
      status: 'FAILED',
      failureClass: train.failure_class,
      failureMessage: train.failure_message,
      recoveryMessage: supersededHeadRollback
        ? 'The exact last validated manifest was restored; obsolete heads were superseded and unrelated NEW candidates were returned to the queue'
        : 'The exact last validated admitted manifest was restored and passed rollback E2E; new candidate intent/evidence was retained appropriately',
      completedAt: Date.now()
    });
    await this.repository.appendEvent(
      {
        trainId: train.id,
        eventType: 'CUMULATIVE_STAGING_ROLLBACK_SUCCEEDED',
        actor: 'release-bus-v2',
        payload: {
          source_manifest_id: train.staging_baseline_manifest_id,
          restored_manifest_id: manifest.id,
          rollback_e2e_run_id: e2e.external_id,
          admitted_candidate_ids: baseline.candidateIds,
          failed_new_candidate_ids: statusCandidates.map(({ id }) => id)
        }
      },
      {}
    );
    await this.releaseTerminalEnvironmentLocks();
  }

  private async failCumulativeStagingRollback(
    context: TrainContext,
    message: string
  ): Promise<void> {
    const [frontendStagingRefSha, backendStagingRefSha] = await Promise.all([
      releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
      releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
    ]);
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const state = await this.repository.getStagingState(ctx, true);
        const train = await this.repository.findTrain(
          context.train.id,
          ctx,
          true
        );
        if (!train) throw new Error('Rollback train disappeared');
        const stateAlreadyMarked =
          state.status === 'ROLLBACK_FAILED' &&
          state.last_transition_train_id === context.train.id;
        const stateSuperseded =
          !stateAlreadyMarked &&
          state.current_manifest_id !==
            context.train.staging_baseline_manifest_id;
        if (stateSuperseded) {
          if (TERMINAL_TRAINS.has(train.status)) return;
          const recoveryMessage =
            'A newer authoritative staging transition superseded this failed rollback callback; current live state was not changed or paused';
          if (
            !(await this.repository.updateTrain(
              train.id,
              train.row_version,
              {
                status: 'FAILED',
                failureClass: context.train.failure_class,
                failureMessage: message,
                recoveryMessage,
                completedAt: Date.now()
              },
              ctx
            ))
          )
            throw new Error(
              'Rollback train changed while recording a superseded failure'
            );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'TRAIN_FAILED',
              actor: 'release-bus-v2',
              payload: {
                previous_status: train.status,
                failure_class: context.train.failure_class,
                recovery_message: recoveryMessage
              }
            },
            ctx
          );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'CUMULATIVE_STAGING_ROLLBACK_FAILURE_SUPERSEDED',
              actor: 'release-bus-v2',
              payload: {
                source_manifest_id: context.train.staging_baseline_manifest_id,
                failure_message: message
              }
            },
            ctx
          );
          return;
        }
        if (!TERMINAL_TRAINS.has(train.status)) {
          if (
            !stateAlreadyMarked &&
            !(await this.repository.updateStagingState(
              state.row_version,
              {
                status: 'ROLLBACK_FAILED',
                currentManifestId: null,
                lastValidatedManifestId: state.last_validated_manifest_id,
                frontendSha: null,
                backendSha: null,
                frontendStagingRefSha,
                backendStagingRefSha,
                cleanMain: false,
                lastTransitionTrainId: train.id
              },
              ctx
            ))
          )
            throw new Error(
              'Authoritative staging state changed while recording rollback failure'
            );
          const recoveryMessage =
            'Rollback could not be proven. Current staging membership is unknown; keep STAGING paused and use the documented serialized manual recovery';
          if (
            !(await this.repository.updateTrain(
              train.id,
              train.row_version,
              {
                status: 'STAGING_ROLLBACK_FAILED',
                failureClass: 'CONTROL_PLANE',
                failureMessage: message,
                recoveryMessage,
                completedAt: Date.now()
              },
              ctx
            ))
          )
            throw new Error(
              'Rollback train changed while recording its terminal failure'
            );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'TRAIN_STAGING_ROLLBACK_FAILED',
              actor: 'release-bus-v2',
              payload: {
                previous_status: train.status,
                failure_class: 'CONTROL_PLANE',
                recovery_message: recoveryMessage
              }
            },
            ctx
          );
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'CUMULATIVE_STAGING_ROLLBACK_FAILED',
              actor: 'release-bus-v2',
              payload: {
                source_manifest_id: context.train.staging_baseline_manifest_id,
                failure_message: message,
                recover_with: 'SERIALIZED_MANUAL_STAGING_RECOVERY'
              }
            },
            ctx
          );
        }
        const controls = await this.repository.listControls(ctx);
        if (
          !controls.some(({ scope, paused }) => scope === 'STAGING' && paused)
        ) {
          const reason = `Cumulative staging rollback failed in train ${train.id}: ${message}`;
          await this.repository.setControl(
            'STAGING',
            true,
            reason,
            'release-bus-v2',
            ctx
          );
          await this.repository.appendEvent(
            {
              eventType: 'BUS_PAUSED',
              actor: 'release-bus-v2',
              payload: { scope: 'STAGING', reason }
            },
            ctx
          );
        }
      }
    );
    await this.releaseTerminalEnvironmentLocks();
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
    if (
      requiresIdleHandshake &&
      relevantCandidates(context, 'frontend').length > 0
    ) {
      if (!train.frontend_composed_sha)
        throw new Error(
          'Frontend qualification has no exact composed SHA for its immutable workflow ref'
        );
      // createRef is retry-safe: an existing ref is accepted only when it
      // already resolves to this exact SHA; a conflicting target fails closed.
      await releaseBusGitHubApp.createRef(
        'frontend',
        releaseBusV2Branch(train, 'frontend'),
        train.frontend_composed_sha
      );
    }
    const workflowFenceStartedAt = requiresIdleHandshake ? Date.now() : null;
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
        await this.service.yieldUnsatisfiableProductionQualification({
          qualificationTrainId: train.id,
          stagingIdentity: {
            frontendSha: afterLock.frontend_staging_sha,
            backendSha: afterLock.backend_staging_sha
          },
          actor: 'release-bus-v2'
        });
        // The immutable mismatch is terminalized transactionally without an
        // environment mutation. Its exact candidates retain production opt-in
        // and may join only a current-base batch that can bind both sides.
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
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'STAGING_IDLE_HANDSHAKE',
          actor: 'release-bus-v2',
          payload: {
            ...afterLock,
            expected_frontend_staging_sha:
              train.lane === 'STAGING' &&
              train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
                ? environmentBinding.frontendSha
                : afterLock.frontend_staging_sha,
            expected_backend_staging_sha:
              train.lane === 'STAGING' &&
              train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
                ? environmentBinding.backendSha
                : afterLock.backend_staging_sha,
            staging_lock: 'owned',
            workflow_fence_started_at: workflowFenceStartedAt,
            verified_at: Date.now()
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
              expected_frontend_staging_sha:
                train.lane === 'STAGING' &&
                train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
                  ? environmentBinding.frontendSha
                  : afterLock.frontend_staging_sha,
              expected_backend_staging_sha:
                train.lane === 'STAGING' &&
                train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
                  ? environmentBinding.backendSha
                  : afterLock.backend_staging_sha,
              beta_test_id: getReleaseBusV2BetaAllowlist()[0]?.test_id,
              staging_lock: 'owned',
              workflow_fence_started_at: workflowFenceStartedAt,
              verified_at: Date.now()
            }
          },
          {}
        );
      }
      if (
        train.lane === 'STAGING' &&
        train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1'
      ) {
        const stagingRefsReady = await this.advanceCumulativeStagingRefs(
          context,
          afterLock,
          environmentBinding
        );
        if (!stagingRefsReady) return;
      }
    }
    const sourceTrainId = train.parent_train_id ?? train.id;
    if (['PREPARED', 'WAITING_FOR_ENVIRONMENT'].includes(train.status)) {
      if (train.lane === 'STAGING')
        await this.updateCandidateStatuses(
          stagingStatusCandidates(context),
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
        if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
          await this.beginCumulativeStagingRollback(
            train,
            deployed.failedOperation.failure_class ?? 'DEPLOYMENT',
            deployed.failedOperation.failure_message ??
              'Staging deployment failed'
          );
        else
          await this.failTrain(
            train,
            deployed.failedOperation.failure_class ?? 'DEPLOYMENT',
            deployed.failedOperation.failure_message ??
              'Staging deployment failed'
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
          stagingStatusCandidates(context),
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
        if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
          await this.beginCumulativeStagingRollback(
            train,
            e2e.failure_class ?? 'E2E',
            e2e.failure_message ?? 'Staging E2E failed'
          );
        else
          await this.failTrain(
            train,
            e2e.failure_class ?? 'E2E',
            e2e.failure_message ?? 'Staging E2E failed'
          );
        return;
      }
      if (train.lane === 'STAGING')
        await this.updateCandidateStatuses(
          stagingStatusCandidates(context),
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
        if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
          await this.beginCumulativeStagingRollback(
            train,
            e2e.failure_class ?? 'E2E',
            e2e.failure_message ?? 'Staging E2E failed'
          );
        else
          await this.failTrain(
            train,
            e2e.failure_class ?? 'E2E',
            e2e.failure_message ?? 'Staging E2E failed'
          );
        return;
      }
      if (e2e.status !== 'SUCCEEDED') return;
      if (!(await this.verifyStagingFinalFence(train, e2e, lease))) return;
      if (train.manifest_id)
        await this.repository.updateManifestStatus(
          train.manifest_id,
          'STAGING_VALIDATED',
          e2e.external_id,
          {}
        );
      if (train.lane === 'STAGING') {
        if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
          await this.commitCumulativeStagingValidation(context);
        else await this.markStagingValidated(context, train.manifest_id);
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
    const hasFrontend =
      stagingDeploymentCandidates(context, 'frontend').length > 0;
    const hasBackend =
      stagingDeploymentCandidates(context, 'backend').length > 0;
    this.assertCumulativeStagingRefIntent(
      context,
      'frontend',
      hasFrontend,
      frontendStaging,
      frontendTarget
    );
    this.assertCumulativeStagingRefIntent(
      context,
      'backend',
      hasBackend,
      backendStaging,
      backendTarget
    );
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

  private assertCumulativeStagingRefIntent(
    context: TrainContext,
    repository: ReleaseBusV2Repository,
    affected: boolean,
    stagingSha: string,
    targetSha: string
  ): void {
    const train = context.train;
    if (
      train.lane !== 'STAGING' ||
      train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1'
    )
      return;
    const baseSha = cumulativeStagingReleaseParent(context, repository);
    const matchesIntent = affected
      ? [baseSha, targetSha].includes(stagingSha)
      : stagingSha === targetSha;
    if (!matchesIntent)
      throw new StagingRefMovedError(
        `${repository} 1a-staging moved outside train ${train.id}'s exact ${baseSha} -> ${targetSha} release intent`
      );
  }

  private async advanceCumulativeStagingRefs(
    context: TrainContext,
    snapshot: StagingIdleSnapshot,
    binding: StagingEnvironmentBinding
  ): Promise<boolean> {
    const selected = (['backend', 'frontend'] as const)
      .filter(
        (repository) =>
          stagingDeploymentCandidates(context, repository).length > 0
      )
      .map((repository) => ({
        repository,
        observedSha:
          repository === 'frontend'
            ? snapshot.frontend_staging_sha
            : snapshot.backend_staging_sha,
        baseSha: cumulativeStagingReleaseParent(context, repository),
        targetSha:
          repository === 'frontend' ? binding.frontendSha : binding.backendSha
      }));
    const invalid = selected.find(
      ({ observedSha, baseSha, targetSha }) =>
        observedSha !== baseSha && observedSha !== targetSha
    );
    if (invalid)
      throw new StagingRefMovedError(
        `${invalid.repository} 1a-staging moved from expected ${invalid.baseSha} to ${invalid.observedSha}; exact train ${context.train.id} was not deployed`
      );
    const ready = await Promise.all(
      selected.map((item) =>
        this.advanceStagingRef(
          context.train,
          item.repository,
          item.observedSha,
          item.baseSha!,
          item.targetSha,
          'release'
        )
      )
    );
    return ready.every(Boolean);
  }

  private stagingRefWorkflowSpec(
    train: ReleaseBusV2TrainRecord,
    repository: ReleaseBusV2Repository,
    baseSha: string,
    targetSha: string,
    phase: 'release' | 'rollback'
  ): ReleaseBusV2WorkflowSpec {
    return {
      idempotencyKey: operationKey(
        train.id,
        `advance-staging:${phase}:${repository}`
      ),
      trainId: train.id,
      operationType: `ADVANCE_STAGING_${phase.toUpperCase()}_${repository.toUpperCase()}`,
      repository,
      workflow: 'release-bus-v2-advance-staging-ref.yml',
      ref: 'main',
      environment: 'staging',
      service: null,
      expectedSha: targetSha,
      artifactDigest: null,
      inputs: {
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        expected_old_sha: baseSha,
        expected_sha: targetSha,
        phase
      },
      maxAttempts: 3
    };
  }

  private async recordUndispatchedStagingRefDrift(
    train: ReleaseBusV2TrainRecord,
    repository: ReleaseBusV2Repository,
    baseSha: string,
    targetSha: string,
    observedSha: string | null,
    phase: 'release' | 'rollback'
  ): Promise<never> {
    const spec = this.stagingRefWorkflowSpec(
      train,
      repository,
      baseSha,
      targetSha,
      phase
    );
    const operation = await this.repository.getOrCreateOperation(
      {
        idempotencyKey: spec.idempotencyKey,
        trainId: spec.trainId,
        operationType: spec.operationType,
        repository: spec.repository,
        service: spec.service,
        environment: spec.environment,
        expectedSha: spec.expectedSha,
        artifactDigest: spec.artifactDigest,
        request: {
          workflow: spec.workflow,
          ref: spec.ref,
          inputs: spec.inputs
        },
        maxAttempts: spec.maxAttempts
      },
      {}
    );
    return this.rejectStagingRefDrift(
      operation,
      repository,
      baseSha,
      observedSha,
      phase,
      'before'
    );
  }

  private assertStagingRefWorkflowResult(
    operation: ReleaseBusV2OperationRecord,
    repository: ReleaseBusV2Repository,
    baseSha: string,
    targetSha: string,
    phase: 'release' | 'rollback'
  ): void {
    const result = parseStoredJson<{
      summary?: {
        ref?: unknown;
        phase?: unknown;
        expected_old_sha?: unknown;
        release_sha?: unknown;
        observed_sha?: unknown;
        changed?: unknown;
      };
    }>(operation.result_json);
    if (
      result?.summary?.ref !== '1a-staging' ||
      result.summary.phase !== phase ||
      result.summary.expected_old_sha !== baseSha ||
      result.summary.release_sha !== targetSha ||
      result.summary.observed_sha !== targetSha ||
      typeof result.summary.changed !== 'boolean'
    )
      // This is a terminal workflow protocol failure, not evidence that the
      // shared ref moved. The runOnce boundary explicitly routes this error
      // through failTrain(CONTROL_PLANE): STAGING alone pauses, candidate
      // intent is retained, and the lease releases only after all exact
      // operations are terminal.
      throw new StagingRefWorkflowError(
        `${repository} staging-ref workflow returned malformed terminal evidence`
      );
  }

  private async advanceStagingRef(
    train: ReleaseBusV2TrainRecord,
    repository: ReleaseBusV2Repository,
    observedSha: string | null,
    baseSha: string,
    targetSha: string,
    phase: 'release' | 'rollback'
  ): Promise<boolean> {
    if (observedSha !== baseSha && observedSha !== targetSha)
      return this.recordUndispatchedStagingRefDrift(
        train,
        repository,
        baseSha,
        targetSha,
        observedSha,
        phase
      );
    const operation = await releaseBusV2Operations.reconcileWorkflow(
      this.stagingRefWorkflowSpec(train, repository, baseSha, targetSha, phase)
    );
    if (operation.status === 'SUCCEEDED') {
      this.assertStagingRefWorkflowResult(
        operation,
        repository,
        baseSha,
        targetSha,
        phase
      );
      await this.verifyCompletedStagingRef(repository, targetSha, phase);
      return true;
    }
    if (!TERMINAL_OPERATIONS.has(operation.status)) return false;
    const current = await releaseBusGitHubApp.resolveRefIfExists(
      repository,
      '1a-staging'
    );
    if (current !== baseSha && current !== targetSha)
      throw new StagingRefMovedError(
        `${repository} 1a-staging moved from ${baseSha} to ${current} during exact ${phase} workflow`
      );
    // The workflow is terminal and the ref is still within exact intent, so
    // this is a lane-local control-plane failure rather than ref drift.
    throw new StagingRefWorkflowError(
      operation.failure_message ??
        `${repository} staging-ref workflow failed closed`
    );
  }

  private async verifyCompletedStagingRef(
    repository: ReleaseBusV2Repository,
    targetSha: string,
    phase: 'release' | 'rollback'
  ): Promise<void> {
    const current = await releaseBusGitHubApp.resolveRef(
      repository,
      '1a-staging'
    );
    if (current !== targetSha)
      throw new StagingRefMovedError(
        `${repository} 1a-staging moved after exact ${phase} CAS from ${targetSha} to ${current}`
      );
  }

  private async terminalizeStagingRefOperation(
    operation: ReleaseBusV2OperationRecord,
    repository: ReleaseBusV2Repository,
    status: 'CANCELLED' | 'FAILED',
    failureClass: ReleaseBusV2FailureClass,
    failureMessage: string
  ): Promise<void> {
    if (
      !(await this.repository.updateOperation(
        operation.id,
        operation.row_version,
        {
          status,
          failureClass,
          failureMessage,
          completedAt: Date.now()
        },
        {}
      ))
    )
      throw new Error(
        `${repository} staging-ref operation changed concurrently`
      );
  }

  private async rejectStagingRefDrift(
    operation: ReleaseBusV2OperationRecord,
    repository: ReleaseBusV2Repository,
    baseSha: string,
    observedSha: string | null,
    phase: 'release' | 'rollback',
    timing: 'before' | 'during'
  ): Promise<never> {
    if (!TERMINAL_OPERATIONS.has(operation.status))
      await this.terminalizeStagingRefOperation(
        operation,
        repository,
        'CANCELLED',
        'INTERACTION',
        `${repository} 1a-staging moved to ${observedSha} ${timing} exact ${phase} CAS`
      );
    throw new StagingRefMovedError(
      `${repository} 1a-staging moved from ${baseSha} to ${observedSha} ${timing} exact ${phase} CAS`
    );
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

  public async recoverUnsatisfiableProductionQualifications(
    actor: string
  ): Promise<{
    readonly recovered: readonly {
      readonly parent_train_id: string;
      readonly qualification_train_id: string;
      readonly candidate_ids: readonly string[];
    }[];
    readonly staging_identity: {
      readonly frontend_sha: string;
      readonly backend_sha: string;
    };
    readonly has_more: boolean;
  }> {
    const mode = getReleaseBusV2Mode();
    if (!['OFF', 'STAGING'].includes(mode))
      throw new Error(
        'Stalled qualification maintenance recovery requires production automation to be disabled'
      );
    const controls = await this.repository.listControls({});
    const all = controls.find(({ scope }) => scope === 'ALL');
    const production = controls.find(({ scope }) => scope === 'PRODUCTION');
    if (
      (mode === 'OFF' && !all?.paused) ||
      (mode === 'STAGING' && !production?.paused)
    )
      throw new Error(
        mode === 'OFF'
          ? 'Stalled qualification maintenance recovery requires ALL to be paused while v2 is OFF'
          : 'Stalled qualification maintenance recovery requires PRODUCTION to be paused while STAGING remains enabled'
      );
    const locks = await this.repository.listLocks({});
    if (
      REQUIRED_MAINTENANCE_LOCKS.some(
        (name) => !locks.some((lock) => lock.name === name)
      ) ||
      locks.some(
        ({ owner_train_id, lease_token }) =>
          owner_train_id !== null || lease_token !== null
      )
    )
      throw new Error(
        'Stalled qualification maintenance recovery requires every v2 lock to be free'
      );
    const scheduler = await this.repository.acquireLock(
      'scheduler',
      null,
      `release-bus-v2-maintenance:${actor}:${randomUUID()}`,
      RELEASE_BUS_V2_LOCK_TTL_MS,
      {}
    );
    if (!scheduler?.lease_token)
      throw new Error(
        'Stalled qualification maintenance recovery could not acquire its exclusive scheduler fence'
      );
    try {
      const before = await this.captureStagingIdleSnapshot();
      const after = await this.captureStagingIdleSnapshot();
      if (
        !before ||
        !after ||
        !after.frontend_staging_sha ||
        !after.backend_staging_sha ||
        before.frontend_staging_sha !== after.frontend_staging_sha ||
        before.backend_staging_sha !== after.backend_staging_sha
      )
        throw new Error(
          'Stalled qualification maintenance recovery requires a stable idle staging identity'
        );
      const recovered: Array<{
        readonly parent_train_id: string;
        readonly qualification_train_id: string;
        readonly candidate_ids: readonly string[];
      }> = [];
      const qualifications = (await this.repository.listTrains(200, {}))
        .filter(({ lane }) => lane === 'PRODUCTION_QUALIFICATION')
        .filter(({ status }) =>
          ['PREPARED', 'WAITING_FOR_ENVIRONMENT'].includes(status)
        )
        .sort(
          (left, right) => Number(left.created_at) - Number(right.created_at)
        );
      for (const qualification of qualifications) {
        const current = await this.repository.findTrain(
          qualification.id,
          {},
          false,
          true
        );
        if (
          !current ||
          current.lane !== 'PRODUCTION_QUALIFICATION' ||
          !['PREPARED', 'WAITING_FOR_ENVIRONMENT'].includes(current.status)
        )
          continue;
        const context = await this.loadContext(current);
        if (this.bindStagingEnvironmentIdentity(context, after)) continue;
        const result =
          await this.service.yieldUnsatisfiableProductionQualification({
            qualificationTrainId: current.id,
            stagingIdentity: {
              frontendSha: after.frontend_staging_sha,
              backendSha: after.backend_staging_sha
            },
            actor,
            maintenanceSchedulerLeaseToken: scheduler.lease_token
          });
        if (!result.yielded) continue;
        recovered.push({
          parent_train_id: result.parentTrainId,
          qualification_train_id: result.qualificationTrainId,
          candidate_ids: result.candidateIds
        });
        break;
      }
      // Recovery intentionally commits at most one yield per request. A
      // successful yield can change the live yieldability of other
      // qualifications, so the pre-yield snapshot cannot answer whether the
      // backlog is drained. Require one follow-up check after every committed
      // yield; only an invocation that recovers nothing proves this drain pass
      // is complete.
      const hasMore = recovered.length > 0;
      if (recovered.length > 0)
        await this.repository.appendEvent(
          {
            eventType: 'STALLED_PRODUCTION_QUALIFICATION_RECOVERY_COMPLETED',
            actor,
            payload: {
              recovered,
              has_more: hasMore,
              staging_frontend_sha: after.frontend_staging_sha,
              staging_backend_sha: after.backend_staging_sha
            }
          },
          {}
        );
      return {
        recovered,
        staging_identity: {
          frontend_sha: after.frontend_staging_sha,
          backend_sha: after.backend_staging_sha
        },
        has_more: hasMore
      };
    } finally {
      await this.releaseMaintenanceSchedulerFence(scheduler.lease_token);
    }
  }

  private async releaseMaintenanceSchedulerFence(token: string): Promise<void> {
    if (await this.repository.releaseLock('scheduler', token, {})) return;
    throw new Error(
      'Stalled qualification maintenance recovery could not release its exclusive scheduler fence'
    );
  }

  private async verifyStagingFinalFence(
    train: ReleaseBusV2TrainRecord,
    e2e: ReleaseBusV2OperationRecord,
    lease: ReleaseBusV2LockRecord
  ): Promise<boolean> {
    const betaFinalFence = getReleaseBusV2Mode() === 'OFF';
    const actor = betaFinalFence ? 'release-bus-v2-beta' : 'release-bus-v2';
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
          eventType: betaFinalFence
            ? 'BETA_STAGING_FINAL_FENCE_MISSING'
            : 'STAGING_FINAL_FENCE_MISSING',
          actor,
          payload: { e2e_run_id: e2e.external_id }
        },
        {}
      );
      if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
        await this.beginCumulativeStagingRollback(
          train,
          'CONTROL_PLANE',
          'Staging idle-handshake evidence is missing or malformed; successful E2E cannot be accepted without an end-to-end fence'
        );
      else
        await this.failTrain(
          train,
          'CONTROL_PLANE',
          'Staging idle-handshake evidence is missing or malformed; successful E2E cannot be accepted without an end-to-end fence'
        );
      return false;
    }
    const operationRunIds = await this.stagingFenceRunIds(train.id);
    const currentSnapshot = await this.captureStagingIdleSnapshot({
      since: handshake.workflow_fence_started_at,
      ignoredRunIds: operationRunIds
    });
    const expectedFrontend =
      handshake.expected_frontend_staging_sha ?? handshake.frontend_staging_sha;
    const expectedBackend =
      handshake.expected_backend_staging_sha ?? handshake.backend_staging_sha;
    const stable =
      currentSnapshot !== null &&
      currentSnapshot.frontend_staging_sha === expectedFrontend &&
      currentSnapshot.backend_staging_sha === expectedBackend;
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
          eventType: betaFinalFence
            ? 'BETA_STAGING_FINAL_FENCE_VIOLATED'
            : 'STAGING_FINAL_FENCE_VIOLATED',
          actor,
          payload: {
            handshake,
            current_snapshot: currentSnapshot,
            ignored_train_run_ids: operationRunIds
          }
        },
        {}
      );
      const message =
        'Shared staging refs or deploy/E2E workflows changed after the idle handshake; successful E2E cannot validate a mixed environment';
      if (train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1')
        throw new StagingRefMovedError(message);
      await this.failTrain(train, 'CONTROL_PLANE', message);
      return false;
    }
    await this.repository.appendEvent(
      {
        trainId: train.id,
        eventType: betaFinalFence
          ? 'BETA_STAGING_FINAL_FENCE_VERIFIED'
          : 'STAGING_FINAL_FENCE_VERIFIED',
        actor,
        payload: {
          ...currentSnapshot,
          handshake_verified_at: handshake.verified_at,
          verified_at: Date.now()
        }
      },
      {}
    );
    return true;
  }

  /**
   * Operation rows retain the current attempt so reconciliation stays exactly
   * idempotent, but an infrastructure retry replaces external_id with the new
   * run. Recover every earlier exact attempt from its immutable operation key
   * before evaluating the final shared-state fence. If GitHub can no longer
   * prove an earlier attempt, the ordinary workflow scan still sees it and the
   * fence fails closed.
   */
  private async stagingFenceRunIds(trainId: string): Promise<string[]> {
    const operations = await this.repository.listOperations(trainId, {});
    const runIds = new Set(
      operations
        .map(({ external_id }) => external_id)
        .filter(
          (runId): runId is string =>
            runId !== null && /^[1-9][0-9]{0,19}$/.test(runId)
        )
    );
    const previousAttempts = operations.flatMap((operation) => {
      if (operation.attempt <= 1 || operation.repository === null) return [];
      const request = parseStoredJson<{ workflow?: unknown }>(
        operation.request_json
      );
      if (typeof request?.workflow !== 'string' || !request.workflow)
        throw new Error(
          `Retried operation ${operation.id} has no immutable workflow identity`
        );
      return Array.from({ length: operation.attempt - 1 }, (_, index) => ({
        operation,
        attempt: index + 1,
        workflow: request.workflow as string
      }));
    });
    const discovered = await Promise.all(
      previousAttempts.map(({ operation, attempt, workflow }) =>
        releaseBusGitHubApp.findWorkflowRun(
          operation.repository!,
          workflow,
          `${operation.idempotency_key}:a${attempt}`
        )
      )
    );
    for (const run of discovered) {
      if (run) runIds.add(String(run.id));
    }
    return Array.from(runIds).sort((left, right) =>
      left.localeCompare(right, 'en')
    );
  }

  private async findStagingIdleHandshake(
    trainId: string
  ): Promise<StagingIdleHandshakeSnapshot | null> {
    const event = (await this.repository.listEvents(trainId, 200, {})).find(
      ({ event_type }) =>
        event_type === 'STAGING_IDLE_HANDSHAKE' ||
        event_type === 'BETA_STAGING_IDLE_HANDSHAKE'
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
      !this.isOptionalSha(payload.backend_staging_sha) ||
      !this.isOptionalSha(payload.expected_frontend_staging_sha) ||
      !this.isOptionalSha(payload.expected_backend_staging_sha)
    )
      return null;
    return {
      workflow_fence_started_at: Number(payload.workflow_fence_started_at),
      verified_at: Number(payload.verified_at),
      frontend_staging_sha: payload.frontend_staging_sha ?? null,
      backend_staging_sha: payload.backend_staging_sha ?? null,
      expected_frontend_staging_sha:
        payload.expected_frontend_staging_sha ?? undefined,
      expected_backend_staging_sha:
        payload.expected_backend_staging_sha ?? undefined
    };
  }

  private isOptionalSha(value: unknown): value is string | null | undefined {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value))
    );
  }

  private async assertCandidateEvidenceCurrent(
    context: TrainContext
  ): Promise<readonly ReleaseBusV2CandidateStagingEvidence[]> {
    const train = context.train;
    if (train.qualification_policy !== CANDIDATE_STAGING_EVIDENCE_POLICY)
      throw new Error(
        `Train ${train.id} does not carry the candidate-evidence production policy`
      );
    const stored = parseStoredJson<
      readonly ReleaseBusV2CandidateStagingEvidence[]
    >(train.qualification_evidence_json);
    const candidates = relevantCandidates(context);
    const expectedCandidateIds = new Set(candidates.map(({ id }) => id));
    const storedCandidateIds = new Set(
      stored?.map(({ candidate_id }) => candidate_id) ?? []
    );
    if (
      !stored ||
      stored.length !== candidates.length ||
      storedCandidateIds.size !== stored.length ||
      storedCandidateIds.size !== expectedCandidateIds.size ||
      Array.from(expectedCandidateIds).some(
        (candidateId) => !storedCandidateIds.has(candidateId)
      )
    )
      throw new Error(
        `Train ${train.id} has missing or ambiguous candidate staging evidence`
      );
    const current = await this.service.resolveCandidateStagingEvidence(
      candidates,
      {}
    );
    if (!isDeepStrictEqual(stored, current))
      throw new Error(
        `Train ${train.id} candidate staging evidence changed after claim`
      );
    const heads = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        currentHead: await releaseBusGitHubApp.resolveRefIfExists(
          candidate.repository,
          candidate.branch_name
        )
      }))
    );
    const moved = heads.find(
      ({ candidate, currentHead }) => currentHead !== candidate.head_sha
    );
    if (moved)
      throw new Error(
        `Candidate ${moved.candidate.id} branch moved from ${moved.candidate.head_sha} to ${moved.currentHead ?? 'deleted'}`
      );
    return current;
  }

  private async advanceProduction(context: TrainContext): Promise<void> {
    const train = context.train;
    if (
      [
        'PREPARED',
        'WAITING_FOR_ENVIRONMENT',
        'MERGING_PRODUCTION',
        'PRODUCTION_DEPLOYING'
      ].includes(train.status) &&
      (train.status === 'WAITING_FOR_ENVIRONMENT' ||
        train.qualification_policy !== CANDIDATE_STAGING_EVIDENCE_POLICY)
    ) {
      const message =
        'Legacy staging-qualified artifacts cannot be reused for production; drain this legacy train and re-admit its exact candidates through the fresh production composition policy';
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'PRODUCTION_LEGACY_ARTIFACT_REUSE_REJECTED',
          actor: 'release-bus-v2',
          payload: {
            qualification_policy: train.qualification_policy,
            artifact_reuse: 'REJECTED',
            production_ref_mutation:
              train.status === 'PRODUCTION_DEPLOYING'
                ? 'MAY_HAVE_STARTED_BEFORE_UPGRADE'
                : 'NOT_STARTED',
            production_deployment: 'BLOCKED',
            recovery_contract:
              train.status === 'PRODUCTION_DEPLOYING'
                ? 'PROVE_EXACT_MAIN_RUNTIME_PARITY_OR_EXPLICIT_ROLLBACK_BEFORE_RESUME'
                : 'DRAIN_AND_READMIT_EXACT_CANDIDATES_WITH_CANDIDATE_STAGING_EVIDENCE_V1'
          }
        },
        {}
      );
      await this.failTrain(train, 'CONTROL_PLANE', message);
      return;
    }
    if (train.status === 'PREPARED') {
      if (await this.deferMovedProductionPlan(context)) return;
      const evidence = await this.assertCandidateEvidenceCurrent(context);
      const preparationOperations = (
        await this.repository.listOperations(train.id, {})
      ).filter(({ status }) => status === 'SUCCEEDED');
      const manifest = await this.createManifest(
        context,
        train.id,
        preparationOperations,
        'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
      );
      await this.repository.appendEvent(
        {
          trainId: train.id,
          eventType: 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
          actor: 'release-bus-v2',
          payload: {
            qualification_policy: CANDIDATE_STAGING_EVIDENCE_POLICY,
            qualification_manifest_id: manifest.id,
            qualification_manifest_identity_sha256: manifest.identity_sha256,
            candidate_evidence: evidence
          }
        },
        {}
      );
      await this.transitionTrain(train, {
        status: 'MERGING_PRODUCTION',
        manifestId: manifest.id,
        recoveryMessage:
          'Every selected exact candidate SHA has successful staging E2E evidence; the fresh current-base composition is qualified for production without mutating staging'
      });
      return;
    }
    const mode = getReleaseBusV2Mode();
    const betaAllowlist =
      mode === 'OFF' || mode === 'STAGING'
        ? getReleaseBusV2BetaAllowlist()
        : [];
    const stagingModeProductionBeta =
      mode === 'STAGING' &&
      releaseBusV2BetaAllowsLaneInMode(mode, betaAllowlist, 'PRODUCTION') &&
      (await this.service.isBetaTrainAllowed(train, betaAllowlist, {}));
    const requiresBetaIdleHandshake =
      train.status === 'MERGING_PRODUCTION' &&
      (mode === 'OFF' || stagingModeProductionBeta);
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
            // Config validation requires one shared test_id across all entries.
            beta_test_id: betaAllowlist[0]?.test_id,
            production_lock: 'owned',
            verified_at: Date.now()
          }
        },
        {}
      );
    }
    if (train.status === 'MERGING_PRODUCTION') {
      await this.assertCandidateEvidenceCurrent(context);
      await this.advanceProductionRefs(context);
      await this.updateCandidateStatuses(
        relevantCandidates(context),
        'PRODUCTION_DEPLOYING',
        train.id
      );
      await this.transitionTrain(train, {
        status: 'PRODUCTION_DEPLOYING',
        recoveryMessage:
          'Fresh candidate-evidence-qualified composition is on main; immutable production artifacts are deploying'
      });
      return;
    }
    if (train.status === 'PRODUCTION_DEPLOYING') {
      // A merge can delete the source branch and race the push webhook. Keep
      // the immutable, already-claimed membership authoritative and repair any
      // stale superseded bookkeeping before reconciling its deployments.
      await this.updateCandidateStatuses(
        relevantCandidates(context),
        'PRODUCTION_DEPLOYING',
        train.id,
        false
      );
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
            'Production deployment failed'
        );
        return;
      }
      if (!deployed.complete) return;
      const e2e = await this.reconcileE2E(context, 'prod');
      if (e2e.status === 'FAILED') {
        await this.failTrain(
          train,
          e2e.failure_class ?? 'E2E',
          e2e.failure_message ?? 'Production E2E failed'
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
          'Explicit candidate-evidence production subset deployed its fresh production artifacts and passed read-only production E2E'
      });
      await this.releaseEnvironmentLease('production-environment', lease);
      await this.publishCandidateStatuses(
        relevantCandidates(context),
        'success',
        'Candidate-evidence v2 production deployment completed'
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
    // Both repository bases are part of the qualified production identity,
    // even when the explicit subset changes only one application.
    const repositories = ['backend', 'frontend'] as const;
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
    const advanced: ReleaseBusV2Repository[] = [];
    for (const item of current.filter(
      ({ repository }) => relevantCandidates(context, repository).length > 0
    )) {
      try {
        await this.advanceMainRef(train, item.repository, item.sha);
        advanced.push(item.repository);
      } catch (error) {
        if (advanced.length > 0)
          throw new Error(
            `Partial production main advance: ${advanced.join(', ')} reached the exact composed SHA before ${item.repository} failed; automation must remain paused for exact reconciliation. ${
              error instanceof Error ? error.message : 'Unknown ref failure'
            }`
          );
        throw error;
      }
    }
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
        maxAttempts: 3
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
    if (observedSha === base) {
      try {
        await releaseBusGitHubApp.updateRef(repository, 'main', base, composed);
      } catch (error) {
        // A ref update can fail after GitHub accepted it. Re-read the ref before
        // deciding whether the durable operation is complete, retryable, or a
        // terminal control-plane failure. This keeps exact main advancement
        // idempotent and prevents a known-rejected update from leaving a
        // permanently PENDING operation behind a terminal train lock.
        const afterFailure = await releaseBusGitHubApp.resolveRef(
          repository,
          'main'
        );
        if (afterFailure !== composed) {
          const message =
            error instanceof Error
              ? error.message
              : `Failed to advance ${repository} main`;
          if (afterFailure !== base) {
            if (
              !(await this.repository.updateOperation(
                operation.id,
                operation.row_version,
                {
                  status: 'CANCELLED',
                  failureClass: 'INTERACTION',
                  failureMessage: `${repository} main moved to ${afterFailure} during exact advancement`,
                  completedAt: Date.now()
                },
                {}
              ))
            )
              throw new Error(
                `${repository} main operation changed concurrently`
              );
            throw new MainMovedError(
              `${repository} main moved from ${base} to ${afterFailure}`
            );
          }
          if (isGitHubInfrastructureError(error)) {
            const exhausted = operation.attempt >= operation.max_attempts;
            if (
              !(await this.repository.updateOperation(
                operation.id,
                operation.row_version,
                {
                  status: exhausted ? 'FAILED' : 'PENDING',
                  failureClass: 'INFRASTRUCTURE',
                  failureMessage: `Exact ${repository} main advancement transport failure ${operation.attempt}/${operation.max_attempts}: ${message}`,
                  attempt: exhausted
                    ? operation.attempt
                    : operation.attempt + 1,
                  completedAt: exhausted ? Date.now() : null
                },
                {}
              ))
            )
              throw new Error(
                `${repository} main operation changed concurrently`
              );
            throw error;
          }
          if (
            !(await this.repository.updateOperation(
              operation.id,
              operation.row_version,
              {
                status: 'FAILED',
                failureClass: 'CONTROL_PLANE',
                failureMessage: message,
                completedAt: Date.now()
              },
              {}
            ))
          )
            throw new Error(
              `${repository} main operation changed concurrently`
            );
          throw error;
        }
      }
    } else if (observedSha !== composed)
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
    operation =
      (await this.repository.findOperation(key, {}, true)) ?? operation;
  }

  private async reconcileDeployments(
    context: TrainContext,
    environment: 'staging' | 'prod',
    artifactSourceTrainId: string
  ): Promise<DeployResult> {
    const train = context.train;
    if (environment === 'prod' && artifactSourceTrainId !== train.id)
      throw new Error(
        'Production deployment requires a freshly prepared same-train artifact'
      );
    const source = await this.artifactSource(
      artifactSourceTrainId,
      environment
    );
    const backendCandidates = stagingDeploymentCandidates(context, 'backend');
    const graph = backendGraph(backendCandidates, environment);
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
            context,
            train,
            environment,
            artifactSourceTrainId,
            source.backend,
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

    const frontendCandidates = stagingDeploymentCandidates(context, 'frontend');
    let frontendComplete = frontendCandidates.length === 0;
    if (
      frontendCandidates.length > 0 &&
      (!frontendDependsOnBackend(context) || backendComplete)
    ) {
      const frontend = await this.reconcileFrontendDeploy(
        context,
        train,
        environment,
        artifactSourceTrainId,
        source.frontend
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
    context: TrainContext,
    train: ReleaseBusV2TrainRecord,
    environment: 'staging' | 'prod',
    artifactTrainId: string,
    artifactSource: PreparedArtifactSource | null,
    service: string,
    candidates: readonly ReleaseBusV2CandidateRecord[]
  ): Promise<ReleaseBusV2OperationRecord> {
    if (!artifactSource)
      throw new Error('Missing backend artifact workflow run');
    const expectedSha = train.backend_composed_sha;
    if (!expectedSha) throw new Error('Missing backend composed SHA');
    if (
      artifactSource.expectedSha !== expectedSha ||
      artifactSource.digest !== train.backend_artifact_digest
    )
      throw new Error(
        'Backend deploy artifact does not match the exact prepared train identity'
      );
    const releaseNoteInputs = backendReleaseNoteInputs(
      candidates,
      service,
      environment
    );
    const releaseContributors = JSON.stringify(
      releaseTrainContributorGithubLogins(
        operationContributorCandidates(context, 'backend', service)
      )
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
        artifact_run_id: artifactSource.runId,
        artifact_train_id: artifactTrainId,
        artifact_digest: train.backend_artifact_digest ?? '',
        ...artifactSource.binding,
        release_contributors: releaseContributors,
        ...releaseNoteInputs
      }
    });
  }

  private async reconcileFrontendDeploy(
    context: TrainContext,
    train: ReleaseBusV2TrainRecord,
    environment: 'staging' | 'prod',
    artifactTrainId: string,
    artifactSource: PreparedArtifactSource | null
  ): Promise<ReleaseBusV2OperationRecord> {
    if (!artifactSource)
      throw new Error('Missing frontend artifact workflow run');
    const expectedSha = train.frontend_composed_sha;
    if (!expectedSha) throw new Error('Missing frontend composed SHA');
    if (
      artifactSource.expectedSha !== expectedSha ||
      artifactSource.digest !== train.frontend_artifact_digest
    )
      throw new Error(
        'Frontend deploy artifact does not match the exact prepared train identity'
      );
    const workflow =
      environment === 'staging'
        ? 'release-bus-deploy-staging.yml'
        : 'release-bus-deploy-production.yml';
    const releaseContributors = JSON.stringify(
      releaseTrainContributorGithubLogins(
        operationContributorCandidates(context, 'frontend')
      )
    );
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
        artifact_run_id: artifactSource.runId,
        artifact_train_id: artifactTrainId,
        artifact_digest: train.frontend_artifact_digest ?? '',
        ...frontendDeployBinding(artifactSource.binding, environment),
        release_contributors: releaseContributors
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
    this.assertE2EManifestMatchesTrain(context, manifest);
    if (environment === 'staging')
      await this.assertCumulativeStagingE2ERefParity(train, manifest);
    const releaseBranch = releaseBusV2Branch(train, 'frontend');
    let exactSourceRef = 'main';
    if (environment === 'staging') {
      const sourceRefs = [releaseBranch, '1a-staging', 'main'];
      const sourceShas = await Promise.all(
        sourceRefs.map((ref) =>
          releaseBusGitHubApp.resolveRefIfExists('frontend', ref)
        )
      );
      const exactIndex = sourceShas.findIndex((sha) => sha === expectedSha);
      if (exactIndex < 0)
        throw new Error(
          `No immutable frontend workflow ref resolves to exact staging SHA ${expectedSha}`
        );
      exactSourceRef = sourceRefs[exactIndex];
    }
    const spec: ReleaseBusV2WorkflowSpec = {
      idempotencyKey: operationKey(train.id, `e2e:${environment}`),
      trainId: train.id,
      operationType: `E2E_${environment.toUpperCase()}`,
      repository: 'frontend',
      workflow:
        environment === 'staging' ? 'staging-e2e.yml' : 'production-e2e.yml',
      ref: exactSourceRef,
      environment,
      service: null,
      expectedSha,
      artifactDigest: manifest.identity_sha256,
      inputs: e2eWorkflowInputs(environment, {
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        staging_source_ref: exactSourceRef,
        expected_sha: expectedSha,
        release_manifest_id: manifest.id,
        release_manifest_identity_sha256: manifest.identity_sha256,
        frontend_sha: manifest.frontend_sha ?? '',
        backend_sha: manifest.backend_sha ?? '',
        frontend_artifact_digest: manifest.frontend_artifact_digest ?? '',
        backend_artifact_digest: manifest.backend_artifact_digest ?? ''
      }),
      maxAttempts: 2
    };
    return releaseBusV2Operations.reconcileWorkflow(spec);
  }

  private assertE2EManifestMatchesTrain(
    context: TrainContext,
    manifest: ReleaseBusV2ManifestRecord
  ): void {
    const train = context.train;
    if (
      manifest.frontend_sha !== train.frontend_composed_sha ||
      manifest.backend_sha !== train.backend_composed_sha ||
      manifest.frontend_artifact_digest !==
        (stagingDeploymentCandidates(context, 'frontend').length
          ? train.frontend_artifact_digest
          : null) ||
      manifest.backend_artifact_digest !==
        (stagingDeploymentCandidates(context, 'backend').length
          ? train.backend_artifact_digest
          : null)
    )
      throw new Error('E2E manifest does not match the exact train release');
  }

  private async assertCumulativeStagingE2ERefParity(
    train: ReleaseBusV2TrainRecord,
    manifest: ReleaseBusV2ManifestRecord
  ): Promise<void> {
    if (
      train.lane !== 'STAGING' ||
      train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1'
    )
      return;
    const identity = parseStoredJson<{
      frontend_staging_ref_sha?: unknown;
      backend_staging_ref_sha?: unknown;
    }>(manifest.manifest_json);
    const [frontendStaging, backendStaging] = await Promise.all([
      releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
      releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
    ]);
    if (
      identity?.frontend_staging_ref_sha !== manifest.frontend_sha ||
      identity.backend_staging_ref_sha !== manifest.backend_sha ||
      frontendStaging !== manifest.frontend_sha ||
      backendStaging !== manifest.backend_sha
    )
      throw new StagingRefMovedError(
        'E2E refused a staging manifest whose 1a-staging refs no longer match its exact release SHAs'
      );
  }

  private async artifactSource(
    trainId: string,
    environment: 'staging' | 'prod'
  ): Promise<ArtifactSource> {
    const operations = await this.repository.listOperations(trainId, {});
    const frontendOperations = operations.filter(
      ({ operation_type, status }) =>
        operation_type === 'PREPARE_ARTIFACT_FRONTEND' && status === 'SUCCEEDED'
    );
    const backendOperations = operations.filter(
      ({ operation_type, status }) =>
        operation_type === 'PREPARE_ARTIFACT_BACKEND' && status === 'SUCCEEDED'
    );
    if (frontendOperations.length > 1 || backendOperations.length > 1)
      throw new Error(
        'Artifact source train has ambiguous successful preparation operations'
      );
    const preparedSource = (
      operation: ReleaseBusV2OperationRecord | undefined
    ): PreparedArtifactSource | null => {
      if (!operation) return null;
      if (operation.train_id !== trainId)
        throw new Error(
          'Artifact preparation operation belongs to a different train'
        );
      const binding = preparedArtifactDeployBinding(operation, environment);
      return {
        runId: operation.external_id!,
        digest: operation.artifact_digest!,
        expectedSha: operation.expected_sha!,
        binding
      };
    };
    return {
      trainId,
      frontend: preparedSource(frontendOperations[0]),
      backend: preparedSource(backendOperations[0])
    };
  }

  private async artifactSourceTrainId(
    train: ReleaseBusV2TrainRecord
  ): Promise<string> {
    // Production artifacts are always built by the exact production train.
    // A staging/qualification manifest may prove source and E2E history, but
    // its artifact run can never become a production deploy input.
    if (train.lane === 'PRODUCTION') return train.id;
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
    const requiresStagingBranchParity =
      train.lane === 'STAGING' &&
      train.staging_policy === 'CUMULATIVE_ADMITTED_SET_V1';
    const handshake = requiresStagingBranchParity
      ? await this.findStagingIdleHandshake(train.id)
      : null;
    const observedStagingRefs = requiresStagingBranchParity
      ? await Promise.all([
          releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
          releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
        ])
      : null;
    const stagingRefs = requiresStagingBranchParity
      ? {
          frontend_staging_ref_sha: observedStagingRefs?.[0] ?? null,
          backend_staging_ref_sha: observedStagingRefs?.[1] ?? null
        }
      : null;
    const expectedFrontendStaging =
      handshake?.expected_frontend_staging_sha ??
      handshake?.frontend_staging_sha;
    const expectedBackendStaging =
      handshake?.expected_backend_staging_sha ?? handshake?.backend_staging_sha;
    if (
      requiresStagingBranchParity &&
      (expectedFrontendStaging !== train.frontend_composed_sha ||
        expectedBackendStaging !== train.backend_composed_sha ||
        !stagingRefs?.frontend_staging_ref_sha ||
        !stagingRefs.backend_staging_ref_sha ||
        stagingRefs.frontend_staging_ref_sha !== train.frontend_composed_sha ||
        stagingRefs.backend_staging_ref_sha !== train.backend_composed_sha)
    )
      throw new StagingRefMovedError(
        'Staging manifest refused 1a-staging refs that do not match the exact deployed release'
      );
    const hasFrontend =
      (train.lane === 'STAGING'
        ? stagingDeploymentCandidates(context, 'frontend')
        : relevantCandidates(context, 'frontend')
      ).length > 0;
    const hasBackend =
      (train.lane === 'STAGING'
        ? stagingDeploymentCandidates(context, 'backend')
        : relevantCandidates(context, 'backend')
      ).length > 0;
    const isProductionManifest =
      status === 'PRODUCTION_DEPLOYED' ||
      status === 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED';
    const qualificationEvidence = parseStoredJson<
      readonly ReleaseBusV2CandidateStagingEvidence[]
    >(train.qualification_evidence_json);
    const identity = {
      train_id: train.id,
      lane: train.lane,
      scope:
        status === 'PRODUCTION_DEPLOYED'
          ? 'production'
          : status === 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
            ? 'production-candidate-evidence-qualification'
            : 'staging',
      staging_policy: train.staging_policy,
      staging_baseline_manifest_id: train.staging_baseline_manifest_id,
      qualification_policy: train.qualification_policy,
      candidate_staging_evidence: qualificationEvidence,
      // The manifest is the exact environment identity used by E2E, not only
      // the changed subset. Preparation always resolves both repositories to
      // either their composed tree or their unchanged base tree.
      frontend_sha: train.frontend_composed_sha,
      backend_sha: train.backend_composed_sha,
      frontend_staging_ref_sha:
        stagingRefs?.frontend_staging_ref_sha ?? undefined,
      backend_staging_ref_sha:
        stagingRefs?.backend_staging_ref_sha ?? undefined,
      frontend_artifact_digest: hasFrontend
        ? train.frontend_artifact_digest
        : null,
      backend_artifact_digest: hasBackend
        ? train.backend_artifact_digest
        : null,
      candidates: relevantCandidates(context).map(
        ({ id, repository, pr_number, head_sha }) => ({
          candidate_id: id,
          repository,
          pr_number,
          head_sha,
          role:
            context.memberships.find(({ candidate_id }) => candidate_id === id)
              ?.candidate_role ?? 'NEW'
        })
      )
    };
    const manifestJson = {
      schema_version: 2,
      ...identity,
      artifact_source_train_id: artifactSourceTrainId,
      train_id: train.id,
      lane: train.lane,
      staging_policy: train.staging_policy,
      staging_baseline_manifest_id: train.staging_baseline_manifest_id,
      staging_transition: parseStoredJson(train.staging_transition_json),
      qualification_policy: train.qualification_policy,
      candidate_staging_evidence: qualificationEvidence,
      backend_graph: backendGraph(
        train.lane === 'STAGING'
          ? stagingDeploymentCandidates(context, 'backend')
          : relevantCandidates(context, 'backend'),
        isProductionManifest ? 'prod' : 'staging'
      ),
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
    const successfulE2eRunId =
      operations.find(
        (operation) =>
          operation.status === 'SUCCEEDED' &&
          ['E2E_STAGING', 'E2E_PROD'].includes(operation.operation_type)
      )?.external_id ?? null;
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
        e2e_run_id: successfulE2eRunId,
        manifest_json: manifestJson,
        deployed_at:
          status === 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
            ? null
            : Date.now(),
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
    const statusCandidates = stagingStatusCandidates(context);
    for (const candidate of statusCandidates) {
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (!current || candidateUnavailableForTrainUpdate(current, candidate))
        continue;
      await this.repository.updateCandidate(
        current.id,
        current.row_version,
        {
          status: 'STAGING_VALIDATED',
          currentTrainId: null,
          stagingValidatedTrainId: context.train.id,
          stagingValidatedManifestId: manifestId,
          holdReason: null,
          supersededAt: current.status === 'SUPERSEDED' ? null : undefined
        },
        {}
      );
    }
    await this.publishCandidateStatuses(
      statusCandidates,
      'success',
      'Exact v2 staging manifest validated; production remains explicit'
    );
  }

  private async commitCumulativeStagingValidation(
    context: TrainContext
  ): Promise<void> {
    const train = context.train;
    if (
      train.staging_policy !== 'CUMULATIVE_ADMITTED_SET_V1' ||
      !train.manifest_id ||
      !train.frontend_composed_sha ||
      !train.backend_composed_sha
    )
      throw new Error('Cumulative staging validation identity is incomplete');
    const transition = parseStoredJson<ReleaseBusV2StagingTransition>(
      train.staging_transition_json
    );
    if (
      !transition ||
      !Number.isInteger(transition.baseline_state_version) ||
      transition.baseline_state_version < 1
    )
      throw new Error('Cumulative staging transition fence is malformed');
    const handshake = await this.findStagingIdleHandshake(train.id);
    const frontendStagingSha =
      handshake?.expected_frontend_staging_sha ??
      handshake?.frontend_staging_sha;
    const backendStagingSha =
      handshake?.expected_backend_staging_sha ?? handshake?.backend_staging_sha;
    if (
      !frontendStagingSha ||
      !backendStagingSha ||
      frontendStagingSha !== train.frontend_composed_sha ||
      backendStagingSha !== train.backend_composed_sha
    )
      throw new Error('Cumulative staging validation lost its ref fence');
    const admittedCandidateIds = relevantCandidates(context).map(
      ({ id }) => id
    );
    const newCandidateIds = transition.new_candidate_ids ?? [];
    const replacedCandidateIds = transition.replaced_candidate_ids ?? [];
    const newCandidateIdSet = new Set(newCandidateIds);
    if (
      newCandidateIdSet.size !== newCandidateIds.length ||
      replacedCandidateIds.some((id) => newCandidateIdSet.has(id))
    )
      throw new Error(
        'Cumulative staging NEW and REPLACED candidate sets overlap'
      );
    const lifecycleRemovedCandidateIds = [
      ...(transition.removed_candidate_ids ?? []),
      ...(transition.absorbed_candidate_ids ?? [])
    ];
    const removedCandidateIds = [
      ...replacedCandidateIds,
      ...lifecycleRemovedCandidateIds
    ];
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.repository.commitValidatedStaging(
          {
            trainId: train.id,
            expectedStateVersion: transition.baseline_state_version,
            manifestId: train.manifest_id!,
            frontendSha: train.frontend_composed_sha!,
            backendSha: train.backend_composed_sha!,
            frontendStagingRefSha: frontendStagingSha,
            backendStagingRefSha: backendStagingSha,
            admittedCandidateIds,
            removedCandidateIds,
            newCandidateIds
          },
          { connection }
        );
        for (const candidateId of newCandidateIds) {
          const candidate = await this.repository.findCandidateById(
            candidateId,
            { connection },
            true
          );
          if (
            !candidate ||
            candidateUnavailableForTrainUpdate(candidate, candidate)
          )
            continue;
          await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: 'STAGING_VALIDATED',
              currentTrainId: null,
              stagingValidatedTrainId: train.id,
              stagingValidatedManifestId: train.manifest_id,
              holdReason: null,
              supersededAt: candidate.status === 'SUPERSEDED' ? null : undefined
            },
            { connection }
          );
        }
        for (const candidateId of replacedCandidateIds) {
          const candidate = await this.repository.findCandidateById(
            candidateId,
            { connection },
            true
          );
          if (!candidate) continue;
          await this.repository.updateCandidate(
            candidate.id,
            candidate.row_version,
            {
              status: 'SUPERSEDED',
              currentTrainId: null,
              stagingLiveState: 'NOT_LIVE',
              stagingLiveManifestId: null,
              stagingLiveUpdatedAt: Date.now(),
              supersededAt: Date.now(),
              holdReason: `Replaced in cumulative staging by train ${train.id}`
            },
            { connection }
          );
        }
        await this.repository.appendEvent(
          {
            trainId: train.id,
            eventType: 'CUMULATIVE_STAGING_ADMITTED_SET_COMMITTED',
            actor: 'release-bus-v2',
            payload: {
              staging_policy: train.staging_policy,
              manifest_id: train.manifest_id,
              admitted_candidate_ids: admittedCandidateIds,
              removed_candidate_ids: removedCandidateIds,
              superseded_candidate_ids: replacedCandidateIds,
              deliberately_removed_candidate_ids:
                transition.removed_candidate_ids ?? [],
              absorbed_candidate_ids: transition.absorbed_candidate_ids ?? [],
              new_candidate_ids: transition.new_candidate_ids ?? [],
              carried_candidate_ids: transition.carried_candidate_ids ?? [],
              frontend_sha: train.frontend_composed_sha,
              backend_sha: train.backend_composed_sha,
              frontend_staging_ref_sha: frontendStagingSha,
              backend_staging_ref_sha: backendStagingSha
            }
          },
          { connection }
        );
      }
    );
    await this.publishCandidateStatuses(
      stagingStatusCandidates(context),
      'success',
      'Exact cumulative staging manifest validated; production remains explicit'
    );
  }

  private async updateCandidateStatuses(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    status: ReleaseBusV2CandidateStatus,
    currentTrainId: string | null,
    publishStatus = true
  ): Promise<void> {
    for (const candidate of candidates) {
      const current = await this.repository.findCandidateById(
        candidate.id,
        {},
        false,
        true
      );
      if (
        !current ||
        candidateUnavailableForTrainUpdate(current, candidate) ||
        (current.status === status &&
          current.current_train_id === currentTrainId &&
          current.hold_reason === null)
      )
        continue;
      await this.repository.updateCandidate(
        current.id,
        current.row_version,
        {
          status,
          currentTrainId,
          holdReason: null,
          supersededAt: current.status === 'SUPERSEDED' ? null : undefined
        },
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
      READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION:
        'Explicit candidate-evidence production selection queued',
      PRODUCTION_IN_TRAIN: 'Claimed by an explicit v2 production train',
      PRODUCTION_BUILDING_OR_QUALIFYING:
        'Exact production composition is building or qualifying',
      WAITING_FOR_PRODUCTION_REPLAN:
        'Explicit production readiness is preserved for a safe current-base replan',
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
    const current = await this.repository.findTrain(train.id, {}, false, true);
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
    const locks = await this.repository.listLocks({}, false, true);
    for (const lock of locks) {
      if (
        !lock.owner_train_id ||
        !lock.lease_token ||
        !['staging-environment', 'production-environment'].includes(lock.name)
      )
        continue;
      const train = await this.repository.findTrain(
        lock.owner_train_id,
        {},
        false,
        true
      );
      if (!train || !TERMINAL_TRAINS.has(train.status)) continue;
      let operations = await this.repository.listOperations(
        train.id,
        {},
        false,
        true
      );
      for (const operation of operations) {
        if (!operationMayStillBeRunning(operation)) continue;
        let request: {
          readonly workflow?: unknown;
          readonly ref?: unknown;
          readonly inputs?: unknown;
        } | null = null;
        try {
          request = parseStoredJson(operation.request_json);
        } catch {
          // A malformed stored request cannot be guessed. Keep the lock until
          // an operator can inspect the durable operation identity.
          continue;
        }
        const inputs = stringRecord(request?.inputs);
        if (
          !operation.repository ||
          !operation.environment ||
          !operation.expected_sha ||
          typeof request?.workflow !== 'string' ||
          typeof request.ref !== 'string' ||
          !inputs
        )
          continue;
        let reconciled: ReleaseBusV2OperationRecord;
        try {
          reconciled = await releaseBusV2Operations.reconcileWorkflow({
            idempotencyKey: operation.idempotency_key,
            trainId: operation.train_id,
            operationType: operation.operation_type,
            repository: operation.repository,
            workflow: request.workflow,
            ref: request.ref,
            environment: operation.environment,
            service: operation.service,
            expectedSha: operation.expected_sha,
            artifactDigest: operation.artifact_digest,
            inputs,
            maxAttempts: operation.max_attempts
          });
        } catch {
          // GitHub/API ambiguity is retried on the next reconciler pass. A
          // reset never guesses that old bytes stopped running.
          continue;
        }
        if (reconciled.status === 'RETRY_WAIT')
          await this.repository.updateOperation(
            reconciled.id,
            reconciled.row_version,
            {
              status: 'CANCELLED',
              failureClass: 'CONTROL_PLANE',
              failureMessage: `Terminal train ${train.id} will not redispatch after authoritative staging reset`,
              completedAt: Date.now()
            },
            {}
          );
      }
      operations = await this.repository.listOperations(
        train.id,
        {},
        false,
        true
      );
      for (const operation of operations) {
        if (
          operation.status !== 'PENDING' ||
          !['ADVANCE_MAIN_BACKEND', 'ADVANCE_MAIN_FRONTEND'].includes(
            operation.operation_type
          ) ||
          !operation.repository ||
          !operation.expected_sha
        )
          continue;
        const base =
          operation.repository === 'frontend'
            ? train.frontend_base_sha
            : train.backend_base_sha;
        if (!base) continue;
        let observedSha: string;
        try {
          observedSha = await releaseBusGitHubApp.resolveRef(
            operation.repository,
            'main'
          );
        } catch {
          // A terminal cleanup may never guess at an ambiguous ref outcome.
          // Retain the lock and retry the read on a later invocation.
          continue;
        }
        const status =
          observedSha === operation.expected_sha
            ? ('SUCCEEDED' as const)
            : observedSha === base
              ? ('FAILED' as const)
              : null;
        if (!status) continue;
        if (
          await this.repository.updateOperation(
            operation.id,
            operation.row_version,
            {
              status,
              externalId:
                status === 'SUCCEEDED' ? operation.expected_sha : undefined,
              result: {
                base_sha: base,
                deployed_sha:
                  status === 'SUCCEEDED' ? operation.expected_sha : null,
                observed_sha: observedSha,
                reconciled_after_terminal_train: true
              },
              failureClass:
                status === 'FAILED'
                  ? (train.failure_class ?? 'CONTROL_PLANE')
                  : null,
              failureMessage:
                status === 'FAILED'
                  ? 'Terminal train retained main at its exact recorded base'
                  : null,
              completedAt: Date.now()
            },
            {}
          )
        )
          await this.repository.appendEvent(
            {
              trainId: train.id,
              eventType: 'TERMINAL_INTERNAL_REF_OPERATION_RECONCILED',
              actor: 'release-bus-v2',
              payload: {
                operation_id: operation.id,
                repository: operation.repository,
                operation_status: status,
                observed_sha: observedSha,
                expected_base_sha: base,
                expected_target_sha: operation.expected_sha
              }
            },
            {}
          );
      }
      operations = await this.repository.listOperations(
        train.id,
        {},
        false,
        true
      );
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
    message: string
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {}, false, true);
    if (!current || TERMINAL_TRAINS.has(current.status)) return;
    const context = await this.loadContext(current);
    // PRODUCTION_DEPLOYING is entered only after advanceProductionRefs has
    // compare-and-swap advanced every affected main ref to the exact composed
    // SHA. A later deploy/E2E failure must therefore stop new production
    // claims until an operator proves main/runtime parity or completes an
    // explicit rollback. Requeueing these candidates would let a later train
    // inherit already-landed, potentially only partially deployed code.
    const productionMainAdvanced =
      current.lane === 'PRODUCTION' &&
      current.status === 'PRODUCTION_DEPLOYING';
    const postMainRecoveryMessage =
      'The exact production composition is already on main, but deployment or read-only E2E did not complete successfully. PRODUCTION is paused and selected candidates are failed closed; reconcile the recorded main SHAs with production runtime before explicitly resuming';
    if (productionMainAdvanced) {
      const controls = await this.repository.listControls({});
      if (
        !controls.some(
          ({ scope, paused }) => scope === 'PRODUCTION' && Boolean(paused)
        )
      )
        await this.service.setPaused(
          'PRODUCTION',
          true,
          `Release Bus v2 post-main production failure in train ${train.id}: ${message}`,
          'release-bus-v2'
        );
      const alreadyAudited = (
        await this.repository.listEvents(current.id, 200, {})
      ).some(
        ({ event_type }) => event_type === 'PRODUCTION_POST_MAIN_FAILURE_PAUSED'
      );
      if (!alreadyAudited)
        await this.repository.appendEvent(
          {
            trainId: current.id,
            eventType: 'PRODUCTION_POST_MAIN_FAILURE_PAUSED',
            actor: 'release-bus-v2',
            payload: {
              failure_class: failureClass,
              failure_message: message,
              frontend_main_sha: current.frontend_composed_sha,
              backend_main_sha: current.backend_composed_sha,
              production_control: 'PAUSED',
              selected_candidate_status: 'FAILED',
              recovery_contract:
                'PROVE_EXACT_MAIN_RUNTIME_PARITY_OR_EXPLICIT_ROLLBACK_BEFORE_RESUME'
            }
          },
          {}
        );
    }
    const retryStatus: ReleaseBusV2CandidateStatus =
      current.lane === 'STAGING'
        ? 'READY_FOR_STAGING'
        : current.qualification_policy === CANDIDATE_STAGING_EVIDENCE_POLICY
          ? CANDIDATE_EVIDENCE_READY_STATUS
          : 'READY_FOR_PRODUCTION';
    const candidateStatus = productionMainAdvanced
      ? 'FAILED'
      : ['INFRASTRUCTURE', 'CONTROL_PLANE'].includes(failureClass)
        ? retryStatus
        : 'FAILED';
    const statusCandidates =
      current.lane === 'STAGING'
        ? stagingStatusCandidates(context)
        : relevantCandidates(context);
    await this.updateCandidateStatuses(
      statusCandidates,
      candidateStatus,
      null,
      false
    );
    if (failureClass === 'CONTROL_PLANE' && !productionMainAdvanced) {
      const affectedLane =
        current.lane === 'STAGING' ? 'STAGING' : 'PRODUCTION';
      await this.service.setPaused(
        affectedLane,
        true,
        `Release Bus v2 ${affectedLane.toLowerCase()} control-plane failure in train ${train.id}: ${message}`,
        'release-bus-v2'
      );
    }
    await this.publishCandidateStatuses(
      statusCandidates,
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
      recoveryMessage: productionMainAdvanced
        ? postMainRecoveryMessage
        : failureClass === 'CONTROL_PLANE'
          ? `${current.lane === 'STAGING' ? 'Staging' : 'Production'} automation is paused independently; retain exact state and use that lane's documented manual fallback`
          : 'Exact state is retained for idempotent diagnosis or retry',
      completedAt: Date.now()
    });
    // Release ownership only after the train and every operation are terminal.
    // If a mutation outcome is still ambiguous, the nonterminal operation
    // deliberately retains the lease until reconciliation can prove its state.
    await this.releaseTerminalEnvironmentLocks();
  }

  private async failStagingForRefDrift(
    train: ReleaseBusV2TrainRecord,
    message: string
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {}, false, true);
    if (!current || TERMINAL_TRAINS.has(current.status)) return;
    const context = await this.loadContext(current);
    const statusCandidates = stagingStatusCandidates(context);
    const deploymentStarted = [
      'DEPLOYING',
      'STAGING_DEPLOYED',
      'E2E_RUNNING'
    ].includes(current.status);
    const [frontendStagingSha, backendStagingSha] = await Promise.all([
      releaseBusGitHubApp.resolveRefIfExists('frontend', '1a-staging'),
      releaseBusGitHubApp.resolveRefIfExists('backend', '1a-staging')
    ]);
    const driftRecorded =
      await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const state = await this.repository.getStagingState(ctx, true);
          if (
            state.status !== 'ROLLBACK_FAILED' ||
            state.last_transition_train_id !== current.id
          ) {
            if (
              !(await this.repository.updateStagingState(
                state.row_version,
                {
                  status: 'ROLLBACK_FAILED',
                  currentManifestId: null,
                  lastValidatedManifestId: state.last_validated_manifest_id,
                  frontendSha: null,
                  backendSha: null,
                  frontendStagingRefSha: frontendStagingSha,
                  backendStagingRefSha: backendStagingSha,
                  cleanMain: false,
                  lastTransitionTrainId: current.id
                },
                ctx
              ))
            )
              return false;
          }
          await this.repository.appendEvent(
            {
              trainId: current.id,
              eventType: 'STAGING_REF_DRIFT_DETECTED',
              actor: 'release-bus-v2',
              payload: {
                failure_message: message,
                frontend_staging_sha: frontendStagingSha,
                backend_staging_sha: backendStagingSha,
                deployment_started: deploymentStarted,
                recover_with: 'SERIALIZED_MANUAL_STAGING_RECOVERY'
              }
            },
            ctx
          );
          return true;
        }
      );
    if (!driftRecorded) return;
    await this.updateCandidateStatuses(
      statusCandidates,
      'READY_FOR_STAGING',
      null,
      false
    );
    const controls = await this.repository.listControls({});
    if (!controls.some(({ scope, paused }) => scope === 'STAGING' && paused))
      await this.service.setPaused(
        'STAGING',
        true,
        `Exact 1a-staging CAS failed in train ${current.id}: ${message}`,
        'release-bus-v2'
      );
    await this.publishCandidateStatuses(
      statusCandidates,
      'error',
      `Staging ref drift prevented deployment: ${message}`
    );
    await this.transitionTrain(current, {
      status: 'FAILED',
      failureClass: 'CONTROL_PLANE',
      failureMessage: message,
      recoveryMessage: `${
        deploymentStarted
          ? 'Train deployment may have started; runtime identity is not being guessed.'
          : 'No train deployment started.'
      } STAGING alone is paused with exact ref intent retained for serialized recovery; production and manual fallback controls are unchanged`,
      completedAt: Date.now()
    });
    await this.releaseTerminalEnvironmentLocks();
  }

  private async deferTrainForInfrastructure(
    train: ReleaseBusV2TrainRecord,
    message: string
  ): Promise<void> {
    const current = await this.repository.findTrain(train.id, {}, false, true);
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
    const result = await this.service.preserveProductionIntentsForSafeReplan({
      trainId: train.id,
      reason: message,
      actor: 'release-bus-v2'
    });
    if (result.status === 'NOOP') return;
    if (result.status === 'FROZEN') {
      const controls = await this.repository.listControls({});
      if (
        !controls.some(
          ({ scope, paused }) => scope === 'PRODUCTION' && Boolean(paused)
        )
      )
        await this.service.setPaused(
          'PRODUCTION',
          true,
          `${result.reason}; train ${train.id} must recover its original exact set`,
          'release-bus-v2'
        );
      return;
    }
    const candidates = (
      await Promise.all(
        result.candidateIds.map((candidateId) =>
          this.repository.findCandidateById(candidateId, {}, false, true)
        )
      )
    ).filter((candidate): candidate is ReleaseBusV2CandidateRecord =>
      Boolean(candidate)
    );
    await this.publishCandidateStatuses(
      candidates,
      'pending',
      'Main moved before mutation; explicit intent is preserved for a new audited replacement'
    );
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
          {},
          false,
          true
        );
        if (
          !current ||
          ['SUPERSEDED', 'CANCELLED', 'DEREGISTERED'].includes(current.status)
        )
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
