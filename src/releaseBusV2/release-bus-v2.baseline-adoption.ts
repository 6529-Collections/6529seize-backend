import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Logger } from '@/logging';
import {
  deriveReleaseBusV2LaneStates,
  getReleaseBusV2Mode
} from '@/releaseBusV2/release-bus-v2.config';
import {
  releaseBusGitHubApp,
  type ReleaseBusWorkflowRunIdentity
} from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2Operations,
  type ReleaseBusV2WorkflowSpec
} from '@/releaseBusV2/release-bus-v2.operations';
import {
  releaseBusV2Repository,
  type ReleaseBusV2ControlRecord,
  type ReleaseBusV2EventRecord,
  type ReleaseBusV2LockRecord,
  type ReleaseBusV2ManifestRecord,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type { RequestContext } from '@/request.context';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2Repository,
  ReleaseBusV2StagingStateRecord,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

const ADOPTION_POLICY = 'ADOPT_EXACT_DEPLOYED_BASELINE_V1' as const;
const PREPARED_EVENT = 'EXACT_STAGING_BASELINE_ADOPTION_INTENT_PREPARED';
const FAILED_EVENT = 'EXACT_STAGING_BASELINE_ADOPTION_FAILED';
const FRONTEND_VERIFIED_EVENT =
  'EXACT_STAGING_BASELINE_FRONTEND_DEPLOYMENT_VERIFIED';
const BACKEND_VERIFIED_EVENT = 'EXACT_STAGING_BASELINE_BACKEND_UNIT_VERIFIED';
const DEFERRED_EVENT = 'EXACT_STAGING_BASELINE_AUTOMATIC_E2E_DEFERRED';
const FROZEN_EVENT = 'EXACT_STAGING_BASELINE_MANIFEST_FROZEN';
const ADOPTED_EVENT = 'EXACT_STAGING_BASELINE_ADOPTED';
const UNDISPATCHED_OPERATION_CANCELLED_EVENT =
  'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED';
const INTENT_EVENT_TYPES = [
  PREPARED_EVENT,
  FAILED_EVENT,
  FROZEN_EVENT
] as const;
const INTENT_MIN_TTL_MS = 5 * 60 * 1000;
const INTENT_MAX_TTL_MS = 2 * 60 * 60 * 1000;
const ADOPTION_STAGING_LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const BACKEND_RUNTIME_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const MAX_CANDIDATES = 500;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[1-9]\d{0,19}$/;
const UNIT_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const OPERATION_ATTEMPT_SUFFIX_PATTERN = /^a[1-9]\d{0,8}$/;
const RELEASE_BUS_OPERATION_ATTEMPT_PATTERN =
  /^rb2:[A-Za-z0-9:._-]+:a[1-9]\d{0,8}$/;

export type ReleaseBusV2BaselineAdoptionCandidate = {
  readonly candidate_id: string;
  readonly repository: ReleaseBusV2Repository;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly row_version: number;
};

export type ReleaseBusV2BaselineAdoptionBackendUnit = {
  readonly service: string;
  readonly expected_sha: string;
};

export type ReleaseBusV2BaselineAdoptionInput = {
  readonly idempotency_key: string;
  readonly reason: string;
  readonly expires_at: number;
  readonly expected_staging_state_row_version: number;
  readonly expected_frontend_ref: '1a-staging';
  readonly expected_frontend_sha: string;
  readonly expected_frontend_runtime_sha: string;
  readonly expected_backend_ref: '1a-staging';
  readonly expected_backend_sha: string;
  readonly expected_backend_runtime_sha: string;
  readonly required_backend_units: readonly ReleaseBusV2BaselineAdoptionBackendUnit[];
  readonly candidates: readonly ReleaseBusV2BaselineAdoptionCandidate[];
};

export type ReleaseBusV2BaselineAdoptionResult = {
  readonly adoption_id: string;
  readonly intent_identity_sha256: string;
  readonly operation_key: string;
  readonly expires_at: number;
  readonly manifest_id: string | null;
  readonly manifest_identity_sha256: string | null;
  readonly operation_id: string | null;
  readonly workflow_run_id: string | null;
  readonly status:
    | 'WAITING_FOR_DEPLOYMENTS'
    | 'E2E_RUNNING'
    | 'STAGING_VALIDATED'
    | 'FAILED';
  readonly reused: boolean;
};

export type ReleaseBusV2BaselineAutomaticE2EDecisionInput = {
  readonly e2e_workflow_run_id: string;
  readonly deploy_workflow_run_id: string;
  readonly deployed_ref: '1a-staging';
  readonly deployed_sha: string;
};

export type ReleaseBusV2BaselineAutomaticE2EDecision =
  | {
      readonly decision: 'LEGACY';
      readonly adoption_id: null;
      readonly operation_key: null;
      readonly expires_at: null;
    }
  | {
      readonly decision: 'DEFERRED';
      readonly adoption_id: string;
      readonly operation_key: string;
      readonly expires_at: number;
      readonly manifest_ready: boolean;
    };

export type ReleaseBusV2BaselineBackendDeploymentEventInput = {
  readonly environment: 'staging';
  readonly service: string;
  readonly workflow_run_id: string;
  readonly workflow_run_attempt: number;
  readonly source_ref: '1a-staging';
  readonly source_sha: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
};

export type ReleaseBusV2BaselineBackendDeploymentEventResult = {
  readonly outcome: 'NO_MATCH' | 'RECORDED' | 'E2E_DISPATCHED';
  readonly adoption_id: string | null;
  readonly operation_key: string | null;
};

type RuntimeShas = {
  readonly frontend: string;
  readonly backend: string;
};

type StagingRefs = RuntimeShas;

type IntentCore = Omit<ReleaseBusV2BaselineAdoptionInput, 'idempotency_key'> & {
  readonly contract: 'release-bus-v2-baseline-adoption-intent-v1';
  readonly intent_id: string;
  readonly requested_by: string;
  readonly operation_key: string;
};

type PreparedIntent = IntentCore & {
  readonly intent_identity_sha256: string;
};

type FrontendEvidence = {
  readonly contract: 'release-bus-v2-baseline-frontend-evidence-v1';
  readonly intent_id: string;
  readonly intent_identity_sha256: string;
  readonly deploy_workflow_run_id: string;
  readonly deploy_workflow_run_attempt: number;
  readonly e2e_workflow_run_id: string;
  readonly e2e_workflow_run_attempt: number;
  readonly ref: '1a-staging';
  readonly sha: string;
  readonly runtime_sha: string;
};

type BackendEvidence = {
  readonly contract: 'release-bus-v2-baseline-backend-evidence-v1';
  readonly intent_id: string;
  readonly intent_identity_sha256: string;
  readonly service: string;
  readonly workflow_run_id: string;
  readonly workflow_run_attempt: number;
  readonly ref: '1a-staging';
  readonly sha: string;
  readonly runtime_sha: string | null;
};

type DeferredEvidence = {
  readonly contract: 'release-bus-v2-baseline-automatic-e2e-deferred-v1';
  readonly intent_id: string;
  readonly intent_identity_sha256: string;
  readonly deploy_workflow_run_id: string;
  readonly e2e_workflow_run_id: string;
  readonly expensive_suite_executed: false;
};

type FrozenEventPayload = {
  readonly contract: 'release-bus-v2-baseline-manifest-frozen-v1';
  readonly intent_id: string;
  readonly intent_identity_sha256: string;
  readonly manifest_id: string;
  readonly manifest_identity_sha256: string;
  readonly operation_key: string;
};

type BaselineManifestBody = {
  readonly contract: 'release-bus-v2-exact-deployed-baseline-adoption-v2';
  readonly intent: PreparedIntent;
  readonly staging_state_before: ReturnType<typeof stateIdentity>;
  readonly exact_staging_refs: StagingRefs;
  readonly exact_deployed_runtimes: RuntimeShas;
  readonly frontend_deployment: FrontendEvidence;
  readonly automatic_e2e_defer: DeferredEvidence;
  readonly backend_deployments: readonly BackendEvidence[];
  readonly candidates: readonly ReleaseBusV2BaselineAdoptionCandidate[];
  readonly mutation_contract: {
    readonly ref_mutation: false;
    readonly deployment: false;
    readonly authoritative_state_activation: 'AFTER_EXACT_MANIFEST_BOUND_E2E_AND_FINAL_CAS';
    readonly production_lane_ownership: false;
  };
};

type IntentLifecycle = {
  readonly prepared: PreparedIntent;
  readonly failed: ReleaseBusV2EventRecord | null;
  readonly frozen: ReleaseBusV2EventRecord | null;
};

type BaselineAdoptionDependencies = {
  readonly getMode: typeof getReleaseBusV2Mode;
  readonly now: () => number;
  readonly resolveStagingRefs: () => Promise<StagingRefs>;
  readonly readRuntimeShas: () => Promise<RuntimeShas>;
  readonly readFrontendRuntimeSha: () => Promise<string>;
  readonly readBackendRuntimeSha: () => Promise<string>;
  readonly waitForBackendRuntimeRetry: (delayMs: number) => Promise<void>;
  readonly hasActiveStagingWorkflow: (
    ignoredRunIds?: readonly string[]
  ) => Promise<boolean>;
  readonly refContainsCommit: (
    repository: ReleaseBusV2Repository,
    ref: string,
    sha: string
  ) => Promise<boolean>;
  readonly getWorkflowRunIdentity: (
    repository: ReleaseBusV2Repository,
    workflowRunId: string
  ) => Promise<ReleaseBusWorkflowRunIdentity>;
};

export class ReleaseBusV2BaselineAdoptionError extends Error {
  public constructor(
    public readonly code: 'BAD_REQUEST' | 'CONFLICT' | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ReleaseBusV2BaselineAdoptionError';
  }
}

export function isReleaseBusV2BaselineAdoptionError(
  error: unknown
): error is ReleaseBusV2BaselineAdoptionError {
  if (error instanceof ReleaseBusV2BaselineAdoptionError) return true;
  return (
    error instanceof Error &&
    error.name === 'ReleaseBusV2BaselineAdoptionError' &&
    ['BAD_REQUEST', 'CONFLICT', 'UNAVAILABLE'].includes(
      String((error as { code?: unknown }).code)
    )
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)])
    );
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseStoredJson<T>(value: unknown): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function exactSha(value: unknown, description: string): string {
  const normalized = String(value).toLowerCase();
  if (!SHA_PATTERN.test(normalized))
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      `${description} must be an exact commit SHA`
    );
  return normalized;
}

function operationKey(intentId: string): string {
  return `rb2:${intentId}:baseline-adoption-e2e:staging`;
}

function legacyOperationKey(intentId: string): string {
  return `${operationKey(intentId)}:a1`;
}

function failureEventId(intentId: string): string {
  return deterministicUuid(`baseline-adoption:${intentId}:failed`);
}

function frozenEventId(intentId: string): string {
  return deterministicUuid(`baseline-adoption:${intentId}:frozen`);
}

function undispatchedOperationCancelledEventId(intentId: string): string {
  return deterministicUuid(
    `baseline-adoption:${intentId}:undispatched-operation-cancelled`
  );
}

function frontendEvidenceEventId(intentId: string): string {
  return deterministicUuid(`baseline-adoption:${intentId}:frontend`);
}

function backendEvidenceEventId(intentId: string, service: string): string {
  return deterministicUuid(`baseline-adoption:${intentId}:backend:${service}`);
}

function deferredEventId(intentId: string): string {
  return deterministicUuid(`baseline-adoption:${intentId}:deferred`);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok)
    throw new Error(`Runtime identity endpoint returned ${response.status}`);
  return response.json();
}

async function defaultFrontendRuntimeSha(): Promise<string> {
  const body = (await fetchJson('https://staging.6529.io/api/version')) as {
    readonly stale?: unknown;
    readonly version?: unknown;
  };
  if (body.stale !== false || !SHA_PATTERN.test(String(body.version ?? '')))
    throw new Error('Frontend staging runtime identity is malformed or stale');
  return String(body.version);
}

async function defaultBackendRuntimeSha(): Promise<string> {
  const body = (await fetchJson('https://api.staging.6529.io/health')) as {
    readonly status?: unknown;
    readonly version?: { readonly commit?: unknown };
  };
  if (
    body.status !== 'ok' ||
    !SHA_PATTERN.test(String(body.version?.commit ?? ''))
  )
    throw new Error('Backend staging runtime identity is malformed');
  return String(body.version?.commit);
}

const dependencies: BaselineAdoptionDependencies = {
  getMode: getReleaseBusV2Mode,
  now: Date.now,
  resolveStagingRefs: async () => {
    const [frontend, backend] = await Promise.all([
      releaseBusGitHubApp.resolveRef('frontend', '1a-staging'),
      releaseBusGitHubApp.resolveRef('backend', '1a-staging')
    ]);
    return { frontend, backend };
  },
  readRuntimeShas: async () => {
    const [frontend, backend] = await Promise.all([
      defaultFrontendRuntimeSha(),
      defaultBackendRuntimeSha()
    ]);
    return { frontend, backend };
  },
  readFrontendRuntimeSha: defaultFrontendRuntimeSha,
  readBackendRuntimeSha: defaultBackendRuntimeSha,
  waitForBackendRuntimeRetry: (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  hasActiveStagingWorkflow: async (ignoredRunIds) => {
    const active = await Promise.all([
      releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun(
        'frontend',
        ignoredRunIds
      ),
      releaseBusGitHubApp.hasActiveStagingMutationOrE2ERun(
        'backend',
        ignoredRunIds
      )
    ]);
    return active.some(Boolean);
  },
  refContainsCommit: (repository, ref, sha) =>
    releaseBusGitHubApp.refContainsCommit(repository, ref, sha),
  getWorkflowRunIdentity: (repository, workflowRunId) =>
    releaseBusGitHubApp.getWorkflowRunIdentity(repository, workflowRunId)
};

function normalizedCandidateInput(
  candidatesInput: readonly ReleaseBusV2BaselineAdoptionCandidate[]
): ReleaseBusV2BaselineAdoptionCandidate[] {
  if (
    !Array.isArray(candidatesInput) ||
    candidatesInput.length > MAX_CANDIDATES
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      `Baseline adoption accepts at most ${MAX_CANDIDATES} candidates`
    );
  const candidates = candidatesInput
    .map((candidate) => ({
      candidate_id: candidate.candidate_id,
      repository: candidate.repository,
      pr_number: candidate.pr_number,
      head_sha: exactSha(candidate.head_sha, 'Candidate head'),
      row_version: candidate.row_version
    }))
    .sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
  if (
    candidates.some(
      (candidate) =>
        !UUID_V4_PATTERN.test(candidate.candidate_id) ||
        !['frontend', 'backend'].includes(candidate.repository) ||
        !Number.isSafeInteger(candidate.pr_number) ||
        candidate.pr_number < 1 ||
        !Number.isSafeInteger(candidate.row_version) ||
        candidate.row_version < 1
    ) ||
    new Set(candidates.map(({ candidate_id }) => candidate_id)).size !==
      candidates.length ||
    new Set(
      candidates.map(
        ({ repository, pr_number, head_sha }) =>
          `${repository}:${pr_number}:${head_sha}`
      )
    ).size !== candidates.length
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption candidate membership is malformed or ambiguous'
    );
  return candidates;
}

function normalizedInput(
  input: ReleaseBusV2BaselineAdoptionInput,
  now: number,
  allowExpired = false
): ReleaseBusV2BaselineAdoptionInput {
  const reason = input.reason.trim();
  const requiredBackendUnits = Array.from(input.required_backend_units ?? [])
    .map((unit) => ({
      service: String(unit.service),
      expected_sha: exactSha(
        unit.expected_sha,
        `Backend unit ${String(unit.service)} SHA`
      )
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
  if (!UUID_V4_PATTERN.test(input.idempotency_key))
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption idempotency key must be a UUID v4'
    );
  if (reason.length < 3 || reason.length > 1000)
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption reason must be between 3 and 1000 characters'
    );
  if (
    !Number.isSafeInteger(input.expires_at) ||
    (!allowExpired && input.expires_at < now + INTENT_MIN_TTL_MS) ||
    input.expires_at > now + INTENT_MAX_TTL_MS
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption expiry must be 5 minutes to 2 hours in the future'
    );
  if (
    !Number.isSafeInteger(input.expected_staging_state_row_version) ||
    input.expected_staging_state_row_version < 1
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Expected staging state row version must be a positive integer'
    );
  if (
    input.expected_frontend_ref !== '1a-staging' ||
    input.expected_backend_ref !== '1a-staging'
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption supports only exact 1a-staging refs'
    );
  if (
    requiredBackendUnits.length !== 1 ||
    requiredBackendUnits[0]?.service !== 'api'
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Baseline adoption requires exactly the runtime-verifiable API backend unit'
    );
  const frontendSha = exactSha(
    input.expected_frontend_sha,
    'Expected frontend staging ref'
  );
  const backendSha = exactSha(
    input.expected_backend_sha,
    'Expected backend staging ref'
  );
  const frontendRuntimeSha = exactSha(
    input.expected_frontend_runtime_sha,
    'Expected frontend runtime'
  );
  const backendRuntimeSha = exactSha(
    input.expected_backend_runtime_sha,
    'Expected backend runtime'
  );
  if (
    frontendSha !== frontendRuntimeSha ||
    backendSha !== backendRuntimeSha ||
    requiredBackendUnits.some(({ expected_sha }) => expected_sha !== backendSha)
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Every runtime and required backend unit must target its exact staging ref SHA'
    );
  return {
    ...input,
    reason,
    expected_frontend_sha: frontendSha,
    expected_frontend_runtime_sha: frontendRuntimeSha,
    expected_backend_sha: backendSha,
    expected_backend_runtime_sha: backendRuntimeSha,
    required_backend_units: requiredBackendUnits,
    candidates: normalizedCandidateInput(input.candidates)
  };
}

function normalizedAutomaticInput(
  input: ReleaseBusV2BaselineAutomaticE2EDecisionInput
): ReleaseBusV2BaselineAutomaticE2EDecisionInput {
  if (
    !RUN_ID_PATTERN.test(input.e2e_workflow_run_id) ||
    !RUN_ID_PATTERN.test(input.deploy_workflow_run_id) ||
    input.deployed_ref !== '1a-staging'
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Automatic E2E deployment identity is malformed'
    );
  return {
    ...input,
    deployed_sha: exactSha(input.deployed_sha, 'Deployed frontend SHA')
  };
}

function normalizedBackendEvent(
  input: ReleaseBusV2BaselineBackendDeploymentEventInput
): ReleaseBusV2BaselineBackendDeploymentEventInput {
  if (
    input.environment !== 'staging' ||
    input.source_ref !== '1a-staging' ||
    !UNIT_PATTERN.test(input.service) ||
    !RUN_ID_PATTERN.test(input.workflow_run_id) ||
    !Number.isSafeInteger(input.workflow_run_attempt) ||
    input.workflow_run_attempt < 1 ||
    !['SUCCEEDED', 'FAILED'].includes(input.status)
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'BAD_REQUEST',
      'Backend deployment callback identity is malformed'
    );
  return {
    ...input,
    source_sha: exactSha(input.source_sha, 'Backend deployment source')
  };
}

function controlsAreSafe(
  mode: ReturnType<typeof getReleaseBusV2Mode>,
  controls: readonly ReleaseBusV2ControlRecord[]
): boolean {
  const all = controls.filter(({ scope }) => scope === 'ALL');
  const lanes = deriveReleaseBusV2LaneStates(mode, controls);
  return (
    controls.length === 3 &&
    all.length === 1 &&
    all[0]?.paused === false &&
    lanes.length === 2 &&
    lanes.every(
      ({ status, changeable }) => status === 'OFF' && changeable === true
    )
  );
}

function lockIsWhollyFree(lock: ReleaseBusV2LockRecord | undefined): boolean {
  return Boolean(
    lock &&
      lock.owner_train_id === null &&
      lock.lease_owner === null &&
      lock.lease_token === null &&
      lock.heartbeat_at === null &&
      lock.expires_at === null
  );
}

function stateIdentity(state: ReleaseBusV2StagingStateRecord) {
  return {
    status: state.status,
    row_version: state.row_version,
    current_manifest_id: state.current_manifest_id,
    last_validated_manifest_id: state.last_validated_manifest_id,
    frontend_sha: state.frontend_sha,
    backend_sha: state.backend_sha,
    frontend_staging_ref_sha: state.frontend_staging_ref_sha,
    backend_staging_ref_sha: state.backend_staging_ref_sha,
    clean_main: Boolean(state.clean_main),
    last_transition_train_id: state.last_transition_train_id
  };
}

function exactCandidateIdentity(
  candidate: ReleaseBusV2CandidateRecord
): ReleaseBusV2BaselineAdoptionCandidate {
  return {
    candidate_id: candidate.id,
    repository: candidate.repository,
    pr_number: candidate.pr_number,
    head_sha: candidate.head_sha,
    row_version: candidate.row_version
  };
}

function sameCandidate(
  candidate: ReleaseBusV2CandidateRecord,
  expected: ReleaseBusV2BaselineAdoptionCandidate
): boolean {
  return (
    candidate.id === expected.candidate_id &&
    candidate.repository === expected.repository &&
    candidate.pr_number === expected.pr_number &&
    candidate.head_sha === expected.head_sha &&
    candidate.row_version === expected.row_version
  );
}

function exactPreparedIntent(
  event: ReleaseBusV2EventRecord
): PreparedIntent | null {
  try {
    const payload = parseStoredJson<PreparedIntent>(event.payload_json);
    if (
      event.event_type !== PREPARED_EVENT ||
      event.id !== payload?.intent_id ||
      !payload ||
      payload.contract !== 'release-bus-v2-baseline-adoption-intent-v1' ||
      !UUID_V4_PATTERN.test(payload.intent_id) ||
      ![
        operationKey(payload.intent_id),
        legacyOperationKey(payload.intent_id)
      ].includes(payload.operation_key) ||
      !SHA256_PATTERN.test(payload.intent_identity_sha256)
    )
      return null;
    const { intent_identity_sha256, ...core } = payload;
    return intent_identity_sha256 === sha256(core) ? payload : null;
  } catch {
    return null;
  }
}

function assertFrontendWorkflowIdentities(
  input: ReleaseBusV2BaselineAutomaticE2EDecisionInput,
  e2e: ReleaseBusWorkflowRunIdentity,
  deploy: ReleaseBusWorkflowRunIdentity
): void {
  if (
    e2e.status !== 'in_progress' ||
    e2e.conclusion !== null ||
    e2e.event !== 'workflow_run' ||
    e2e.path !== '.github/workflows/staging-e2e.yml' ||
    !isTrustedStagingE2EWorkflowName(e2e.name) ||
    deploy.status !== 'completed' ||
    deploy.conclusion !== 'success' ||
    !['push', 'workflow_dispatch'].includes(deploy.event) ||
    deploy.path !== '.github/workflows/deploy-staging.yml' ||
    deploy.name !== 'Web Deploy - STAGING' ||
    deploy.headBranch !== input.deployed_ref ||
    deploy.headSha !== input.deployed_sha
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'CONFLICT',
      'Automatic E2E does not bind the exact successful staging deployment'
    );
}

function isTrustedStagingE2EWorkflowName(value: string): boolean {
  const match = /^Staging E2E \[([A-Za-z0-9:._-]+)\]$/.exec(value);
  const identity = match?.[1] ?? '';
  const segments = identity.split(':');
  return (
    identity === 'automatic' ||
    (identity.length <= 180 &&
      RELEASE_BUS_OPERATION_ATTEMPT_PATTERN.test(identity) &&
      !OPERATION_ATTEMPT_SUFFIX_PATTERN.test(segments.at(-2) ?? ''))
  );
}

function assertBackendWorkflowIdentity(
  input: ReleaseBusV2BaselineBackendDeploymentEventInput,
  identity: ReleaseBusWorkflowRunIdentity
): void {
  const title = `Deploy ${input.service} to staging [manual]`;
  if (
    identity.attempt !== input.workflow_run_attempt ||
    identity.status !== 'in_progress' ||
    identity.conclusion !== null ||
    identity.event !== 'workflow_dispatch' ||
    identity.path !== '.github/workflows/deploy.yml' ||
    !['Deploy a service', title].includes(identity.name) ||
    identity.displayTitle !== title ||
    identity.headBranch !== input.source_ref ||
    identity.headSha !== input.source_sha
  )
    throw new ReleaseBusV2BaselineAdoptionError(
      'CONFLICT',
      'Backend deployment callback does not bind the exact manual staging run'
    );
}

export class ReleaseBusV2BaselineAdoptionService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository,
    private readonly deps: BaselineAdoptionDependencies = dependencies,
    private readonly operations: Pick<
      typeof releaseBusV2Operations,
      'reconcileWorkflow'
    > = releaseBusV2Operations
  ) {}

  public async execute(
    rawInput: ReleaseBusV2BaselineAdoptionInput,
    actor: string
  ): Promise<ReleaseBusV2BaselineAdoptionResult> {
    return this.failClosed(async () => {
      const existingById = UUID_V4_PATTERN.test(rawInput.idempotency_key)
        ? await this.repository.findEvent(
            rawInput.idempotency_key,
            {},
            false,
            true
          )
        : null;
      const input = normalizedInput(
        rawInput,
        this.deps.now(),
        Boolean(existingById)
      );
      const core: IntentCore = {
        contract: 'release-bus-v2-baseline-adoption-intent-v1',
        intent_id: input.idempotency_key,
        requested_by: actor,
        operation_key: operationKey(input.idempotency_key),
        reason: input.reason,
        expires_at: input.expires_at,
        expected_staging_state_row_version:
          input.expected_staging_state_row_version,
        expected_frontend_ref: input.expected_frontend_ref,
        expected_frontend_sha: input.expected_frontend_sha,
        expected_frontend_runtime_sha: input.expected_frontend_runtime_sha,
        expected_backend_ref: input.expected_backend_ref,
        expected_backend_sha: input.expected_backend_sha,
        expected_backend_runtime_sha: input.expected_backend_runtime_sha,
        required_backend_units: input.required_backend_units,
        candidates: input.candidates
      };
      const prepared: PreparedIntent = {
        ...core,
        intent_identity_sha256: sha256(core)
      };
      const existing = existingById;
      if (existing) {
        const exact = exactPreparedIntent(existing);
        if (!exact || !isDeepStrictEqual(exact, prepared))
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Baseline adoption idempotency key has a different immutable intent'
          );
        const failed = await this.repository.findEvent(
          failureEventId(exact.intent_id),
          {},
          false,
          true
        );
        if (failed) await this.recoverFailedUndispatchedOperation(exact, actor);
        else if (
          exact.expires_at <= this.deps.now() &&
          !(await this.repository.findEvent(
            frozenEventId(exact.intent_id),
            {},
            false,
            true
          )) &&
          !(await this.repository.findEvent(
            failureEventId(exact.intent_id),
            {},
            false,
            true
          ))
        )
          await this.failIntent(
            exact,
            'Baseline-adoption intent expired before deployment evidence completed'
          );
        return this.result(exact, true);
      }
      await this.expireStaleIntents();
      const active = await this.activeIntents();
      if (active.length > 0)
        throw new ReleaseBusV2BaselineAdoptionError(
          'CONFLICT',
          'Another exact baseline-adoption intent is already pending'
        );
      const snapshot = await this.readPreparationSnapshot(prepared);
      await this.repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const controls = await this.repository.listControls(ctx, true);
          const state = await this.repository.getStagingState(ctx, true);
          const candidates = await this.readExactCandidates(
            prepared.candidates,
            ctx,
            true
          );
          const live = await this.repository.listLiveStagingCandidates(
            ctx,
            true
          );
          if (
            !controlsAreSafe(this.deps.getMode(), controls) ||
            state.row_version !== snapshot.state.row_version ||
            live.some(
              ({ id }) => !candidates.some((candidate) => candidate.id === id)
            )
          )
            throw new ReleaseBusV2BaselineAdoptionError(
              'CONFLICT',
              'Baseline adoption controls, state, or candidate membership changed during preparation'
            );
          await this.repository.appendEvent(
            {
              eventId: prepared.intent_id,
              eventType: PREPARED_EVENT,
              actor,
              payload: prepared
            },
            ctx
          );
          const inserted = await this.repository.findEvent(
            prepared.intent_id,
            ctx,
            true
          );
          if (
            !inserted ||
            !isDeepStrictEqual(exactPreparedIntent(inserted), prepared)
          )
            throw new ReleaseBusV2BaselineAdoptionError(
              'CONFLICT',
              'Baseline adoption intent identity changed concurrently'
            );
        }
      );
      return this.result(prepared, false);
    });
  }

  public async decideAutomaticE2E(
    rawInput: ReleaseBusV2BaselineAutomaticE2EDecisionInput
  ): Promise<ReleaseBusV2BaselineAutomaticE2EDecision> {
    return this.failClosed(async () => {
      const input = normalizedAutomaticInput(rawInput);
      await this.expireStaleIntents();
      const lifecycles = await this.intentLifecycles();
      const exact = lifecycles.filter(
        ({ prepared }) =>
          prepared.expected_frontend_ref === input.deployed_ref &&
          prepared.expected_frontend_sha === input.deployed_sha
      );
      const active = lifecycles.filter(
        ({ failed, frozen }) => !failed && !frozen
      );
      const activeExact = active.filter(
        ({ prepared }) =>
          prepared.expected_frontend_ref === input.deployed_ref &&
          prepared.expected_frontend_sha === input.deployed_sha
      );
      const frozenExact = exact.filter(({ frozen }) => Boolean(frozen));
      const failedExact = exact.filter(({ failed }) => Boolean(failed));
      if (active.length === 0) {
        if (failedExact.length > 0)
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'The exact baseline-adoption intent already failed closed'
          );
        if (frozenExact.length === 1) {
          const prepared = frozenExact[0].prepared;
          await this.ensureBoundE2EDispatched(prepared);
          return {
            decision: 'DEFERRED',
            adoption_id: prepared.intent_id,
            operation_key: prepared.operation_key,
            expires_at: prepared.expires_at,
            manifest_ready: true
          };
        }
        if (frozenExact.length > 1)
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Automatic E2E evidence is ambiguous across frozen adoption intents'
          );
        return {
          decision: 'LEGACY',
          adoption_id: null,
          operation_key: null,
          expires_at: null
        };
      }
      if (active.length !== 1 || activeExact.length !== 1) {
        await this.failMany(
          active.map(({ prepared }) => prepared),
          'Automatic E2E did not have one unique exact pending adoption intent'
        );
        throw new ReleaseBusV2BaselineAdoptionError(
          'CONFLICT',
          'Automatic E2E intent lookup was stale, moved, or ambiguous'
        );
      }
      const intent = activeExact[0].prepared;
      this.assertUnexpired(intent);
      const [e2eIdentity, deployIdentity, currentRef, runtimeSha] =
        await Promise.all([
          this.deps.getWorkflowRunIdentity(
            'frontend',
            input.e2e_workflow_run_id
          ),
          this.deps.getWorkflowRunIdentity(
            'frontend',
            input.deploy_workflow_run_id
          ),
          this.deps.resolveStagingRefs().then(({ frontend }) => frontend),
          this.deps.readFrontendRuntimeSha()
        ]);
      try {
        assertFrontendWorkflowIdentities(input, e2eIdentity, deployIdentity);
        if (
          currentRef !== intent.expected_frontend_sha ||
          runtimeSha !== intent.expected_frontend_runtime_sha
        )
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Frontend staging ref or runtime moved from the pending intent'
          );
        const evidence: FrontendEvidence = {
          contract: 'release-bus-v2-baseline-frontend-evidence-v1',
          intent_id: intent.intent_id,
          intent_identity_sha256: intent.intent_identity_sha256,
          deploy_workflow_run_id: input.deploy_workflow_run_id,
          deploy_workflow_run_attempt: deployIdentity.attempt,
          e2e_workflow_run_id: input.e2e_workflow_run_id,
          e2e_workflow_run_attempt: e2eIdentity.attempt,
          ref: input.deployed_ref,
          sha: input.deployed_sha,
          runtime_sha: runtimeSha
        };
        await this.recordExactEvent(
          frontendEvidenceEventId(intent.intent_id),
          FRONTEND_VERIFIED_EVENT,
          deployIdentity.actor,
          evidence
        );
        const deferred: DeferredEvidence = {
          contract: 'release-bus-v2-baseline-automatic-e2e-deferred-v1',
          intent_id: intent.intent_id,
          intent_identity_sha256: intent.intent_identity_sha256,
          deploy_workflow_run_id: input.deploy_workflow_run_id,
          e2e_workflow_run_id: input.e2e_workflow_run_id,
          expensive_suite_executed: false
        };
        await this.recordExactEvent(
          deferredEventId(intent.intent_id),
          DEFERRED_EVENT,
          e2eIdentity.actor,
          deferred
        );
        const frozen = await this.maybeFreezeAndDispatch(intent, [
          input.e2e_workflow_run_id
        ]);
        return {
          decision: 'DEFERRED',
          adoption_id: intent.intent_id,
          operation_key: intent.operation_key,
          expires_at: intent.expires_at,
          manifest_ready: frozen
        };
      } catch (error) {
        await this.failIntent(
          intent,
          error instanceof Error ? error.message : 'Frontend evidence failed'
        );
        throw error;
      }
    });
  }

  public async recordBackendDeployment(
    rawInput: ReleaseBusV2BaselineBackendDeploymentEventInput
  ): Promise<ReleaseBusV2BaselineBackendDeploymentEventResult> {
    return this.failClosed(async () => {
      const input = normalizedBackendEvent(rawInput);
      await this.expireStaleIntents();
      const lifecycles = await this.intentLifecycles();
      const active = lifecycles.filter(
        ({ failed, frozen }) => !failed && !frozen
      );
      const exact = active.filter(
        ({ prepared }) =>
          prepared.expected_backend_ref === input.source_ref &&
          prepared.expected_backend_sha === input.source_sha &&
          prepared.required_backend_units.some(
            ({ service }) => service === input.service
          )
      );
      const terminalExact = lifecycles.filter(
        ({ prepared }) =>
          prepared.expected_backend_ref === input.source_ref &&
          prepared.expected_backend_sha === input.source_sha &&
          prepared.required_backend_units.some(
            ({ service }) => service === input.service
          )
      );
      if (active.length === 0) {
        if (terminalExact.some(({ failed }) => Boolean(failed)))
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'The exact baseline-adoption intent already failed closed'
          );
        const frozen = terminalExact.filter(({ frozen }) => Boolean(frozen));
        if (frozen.length === 1) {
          await this.ensureBoundE2EDispatched(frozen[0].prepared);
          return {
            outcome: 'E2E_DISPATCHED',
            adoption_id: frozen[0].prepared.intent_id,
            operation_key: frozen[0].prepared.operation_key
          };
        }
        if (frozen.length > 1)
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Backend deployment callback is ambiguous across frozen intents'
          );
        return {
          outcome: 'NO_MATCH',
          adoption_id: null,
          operation_key: null
        };
      }
      if (active.length !== 1 || exact.length !== 1) {
        await this.failMany(
          active.map(({ prepared }) => prepared),
          'Backend deployment did not match one unique pending adoption intent'
        );
        throw new ReleaseBusV2BaselineAdoptionError(
          'CONFLICT',
          'Backend deployment intent lookup was stale, moved, or ambiguous'
        );
      }
      const intent = exact[0].prepared;
      this.assertUnexpired(intent);
      try {
        const [identity, currentRef] = await Promise.all([
          this.deps.getWorkflowRunIdentity('backend', input.workflow_run_id),
          this.deps.resolveStagingRefs().then(({ backend }) => backend)
        ]);
        assertBackendWorkflowIdentity(input, identity);
        if (currentRef !== intent.expected_backend_sha)
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Backend staging ref moved from the pending adoption intent'
          );
        if (input.status !== 'SUCCEEDED')
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            `Required backend deployment ${input.service} failed`
          );
        const runtimeSha =
          input.service === 'api'
            ? await this.readConvergedBackendRuntimeSha(
                intent.expected_backend_runtime_sha
              )
            : null;
        const evidence: BackendEvidence = {
          contract: 'release-bus-v2-baseline-backend-evidence-v1',
          intent_id: intent.intent_id,
          intent_identity_sha256: intent.intent_identity_sha256,
          service: input.service,
          workflow_run_id: input.workflow_run_id,
          workflow_run_attempt: input.workflow_run_attempt,
          ref: input.source_ref,
          sha: input.source_sha,
          runtime_sha: runtimeSha
        };
        await this.recordExactEvent(
          backendEvidenceEventId(intent.intent_id, input.service),
          BACKEND_VERIFIED_EVENT,
          identity.actor,
          evidence
        );
        const frozen = await this.maybeFreezeAndDispatch(intent, [
          input.workflow_run_id
        ]);
        return {
          outcome: frozen ? 'E2E_DISPATCHED' : 'RECORDED',
          adoption_id: intent.intent_id,
          operation_key: intent.operation_key
        };
      } catch (error) {
        await this.failIntent(
          intent,
          error instanceof Error ? error.message : 'Backend evidence failed'
        );
        throw error;
      }
    });
  }

  public async handleE2EProgress(trainId: string): Promise<void> {
    return this.failClosed(async () => {
      const train = await this.repository.findTrain(trainId, {}, false, true);
      if (!train || train.staging_policy !== ADOPTION_POLICY) return;
      if (['STAGING_VALIDATED', 'FAILED', 'CANCELLED'].includes(train.status))
        return;
      const manifest = train.manifest_id
        ? await this.repository.findManifest(train.manifest_id, {}, true)
        : null;
      const operations = await this.repository.listOperations(
        train.id,
        {},
        false,
        true
      );
      const e2e = operations.filter(
        ({ operation_type }) => operation_type === 'E2E_STAGING'
      );
      if (!manifest || e2e.length !== 1) {
        const intent = await this.preparedIntent(train.id);
        if (intent)
          await this.failIntent(
            intent,
            'Bound E2E callback identity is incomplete or ambiguous'
          );
        return;
      }
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(e2e[0].status)) return;
      const intent = await this.preparedIntent(train.id);
      if (!intent) return;
      if (e2e[0].status !== 'SUCCEEDED' || !e2e[0].external_id) {
        await this.failIntent(
          intent,
          `Manifest-bound E2E did not succeed: ${
            e2e[0].failure_message ?? e2e[0].status
          }`
        );
        return;
      }
      try {
        await this.finalize(intent, train, manifest, e2e[0]);
      } catch (error) {
        await this.failIntent(
          intent,
          `Final adoption CAS failed closed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
      }
    });
  }

  private async readConvergedBackendRuntimeSha(
    expectedSha: string
  ): Promise<string> {
    let runtimeSha = await this.deps.readBackendRuntimeSha();
    for (const delayMs of BACKEND_RUNTIME_RETRY_DELAYS_MS) {
      if (runtimeSha === expectedSha) return runtimeSha;
      await this.deps.waitForBackendRuntimeRetry(delayMs);
      runtimeSha = await this.deps.readBackendRuntimeSha();
    }
    if (runtimeSha !== expectedSha)
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Backend API runtime moved from the pending adoption intent'
      );
    return runtimeSha;
  }

  private async readPreparationSnapshot(intent: PreparedIntent): Promise<{
    readonly state: ReleaseBusV2StagingStateRecord;
  }> {
    const [controls, locks, trains, operations, state, activeWorkflow] =
      await Promise.all([
        this.repository.listControls({}),
        this.repository.listLocks({}),
        this.repository.listActiveTrains({}),
        this.repository.listNonterminalOperationsForLanes(
          ['STAGING', 'PRODUCTION_QUALIFICATION'],
          {}
        ),
        this.repository.getStagingState({}),
        this.deps.hasActiveStagingWorkflow()
      ]);
    if (
      !controlsAreSafe(this.deps.getMode(), controls) ||
      !lockIsWhollyFree(
        locks.find(({ name }) => name === 'staging-environment')
      ) ||
      trains.some(({ lane }) =>
        ['STAGING', 'PRODUCTION_QUALIFICATION'].includes(lane)
      ) ||
      operations.length > 0 ||
      activeWorkflow
    )
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Intent preparation requires OFF controls and a fully drained, unlocked staging environment'
      );
    if (state.row_version !== intent.expected_staging_state_row_version)
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Intent preparation staging state is stale'
      );
    const candidates = await this.readExactCandidates(intent.candidates);
    await this.assertCandidateMembership(candidates, false);
    return { state };
  }

  private async readExactCandidates(
    expected: readonly ReleaseBusV2BaselineAdoptionCandidate[],
    ctx: Parameters<ReleaseBusV2RepositoryClass['findCandidateById']>[1] = {},
    forUpdate = false
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const candidates: ReleaseBusV2CandidateRecord[] = [];
    for (const identity of expected) {
      const candidate = await this.repository.findCandidateById(
        identity.candidate_id,
        ctx,
        forUpdate
      );
      if (
        !candidate ||
        !sameCandidate(candidate, identity) ||
        candidate.current_train_id !== null ||
        ['CANCELLED', 'DEREGISTERED'].includes(candidate.status)
      )
        throw new ReleaseBusV2BaselineAdoptionError(
          'CONFLICT',
          `Candidate ${identity.candidate_id} is stale or unavailable`
        );
      candidates.push(candidate);
    }
    return candidates;
  }

  private async assertCandidateMembership(
    candidates: readonly ReleaseBusV2CandidateRecord[],
    verifyStagingContainment = true
  ): Promise<void> {
    const live = await this.repository.listLiveStagingCandidates({});
    const included = new Set(candidates.map(({ id }) => id));
    if (live.some(({ id }) => !included.has(id)))
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Intent cannot silently remove an authoritative live candidate'
      );
    if (!verifyStagingContainment) return;
    const contained = await Promise.all(
      candidates.map((candidate) =>
        this.deps.refContainsCommit(
          candidate.repository,
          '1a-staging',
          candidate.head_sha
        )
      )
    );
    if (contained.some((value) => !value))
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'A declared candidate is not contained in its exact staging ref'
      );
  }

  private async intentLifecycles(): Promise<IntentLifecycle[]> {
    const events = await this.repository.listEventsByTypes(
      INTENT_EVENT_TYPES,
      2000,
      {},
      false,
      this.deps.now() - INTENT_MAX_TTL_MS,
      true
    );
    if (events.length >= 2000)
      throw new ReleaseBusV2BaselineAdoptionError(
        'UNAVAILABLE',
        'Baseline-adoption lifecycle activity exceeded its fail-closed two-hour scan bound'
      );
    const prepared = events
      .filter(({ event_type }) => event_type === PREPARED_EVENT)
      .map(exactPreparedIntent);
    if (prepared.some((intent) => !intent))
      throw new ReleaseBusV2BaselineAdoptionError(
        'UNAVAILABLE',
        'A stored baseline-adoption intent is malformed'
      );
    return prepared.map((intent) => ({
      prepared: intent!,
      failed:
        events.find(
          (event) =>
            event.id === failureEventId(intent!.intent_id) &&
            event.event_type === FAILED_EVENT
        ) ?? null,
      frozen:
        events.find(
          (event) =>
            event.id === frozenEventId(intent!.intent_id) &&
            event.event_type === FROZEN_EVENT
        ) ?? null
    }));
  }

  private async activeIntents(): Promise<PreparedIntent[]> {
    return (await this.intentLifecycles())
      .filter(({ failed, frozen }) => !failed && !frozen)
      .map(({ prepared }) => prepared);
  }

  private async preparedIntent(
    intentId: string
  ): Promise<PreparedIntent | null> {
    const event = await this.repository.findEvent(intentId, {}, false, true);
    return event ? exactPreparedIntent(event) : null;
  }

  private async expireStaleIntents(): Promise<void> {
    const active = await this.activeIntents();
    for (const intent of active)
      if (intent.expires_at <= this.deps.now())
        await this.failIntent(intent, 'Baseline-adoption intent expired');
  }

  private assertUnexpired(intent: PreparedIntent): void {
    if (intent.expires_at <= this.deps.now())
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Baseline-adoption intent expired'
      );
  }

  private async recordExactEvent(
    id: string,
    eventType: string,
    actor: string,
    payload: unknown
  ): Promise<void> {
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        await this.repository.appendEvent(
          { eventId: id, eventType, actor, payload },
          ctx
        );
        const event = await this.repository.findEvent(id, ctx, true);
        if (
          !event ||
          event.event_type !== eventType ||
          !isDeepStrictEqual(parseStoredJson(event.payload_json), payload)
        )
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'A different callback already owns this immutable evidence identity'
          );
      }
    );
  }

  private async evidenceForIntent(intent: PreparedIntent): Promise<{
    readonly frontend: FrontendEvidence | null;
    readonly deferred: DeferredEvidence | null;
    readonly backend: readonly BackendEvidence[];
  }> {
    const [frontendEvent, deferredEvent] = await Promise.all([
      this.repository.findEvent(
        frontendEvidenceEventId(intent.intent_id),
        {},
        false,
        true
      ),
      this.repository.findEvent(
        deferredEventId(intent.intent_id),
        {},
        false,
        true
      )
    ]);
    const frontend = frontendEvent
      ? parseStoredJson<FrontendEvidence>(frontendEvent.payload_json)
      : null;
    if (
      frontendEvent &&
      (frontendEvent.event_type !== FRONTEND_VERIFIED_EVENT ||
        frontend?.contract !== 'release-bus-v2-baseline-frontend-evidence-v1' ||
        frontend.intent_id !== intent.intent_id ||
        frontend.intent_identity_sha256 !== intent.intent_identity_sha256 ||
        !RUN_ID_PATTERN.test(frontend.deploy_workflow_run_id) ||
        !Number.isSafeInteger(frontend.deploy_workflow_run_attempt) ||
        frontend.deploy_workflow_run_attempt < 1 ||
        !RUN_ID_PATTERN.test(frontend.e2e_workflow_run_id) ||
        !Number.isSafeInteger(frontend.e2e_workflow_run_attempt) ||
        frontend.e2e_workflow_run_attempt < 1 ||
        frontend.ref !== intent.expected_frontend_ref ||
        frontend.sha !== intent.expected_frontend_sha ||
        frontend.runtime_sha !== intent.expected_frontend_runtime_sha)
    )
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Frontend deployment evidence is malformed'
      );
    const deferred = deferredEvent
      ? parseStoredJson<DeferredEvidence>(deferredEvent.payload_json)
      : null;
    if (
      deferredEvent &&
      (deferredEvent.event_type !== DEFERRED_EVENT ||
        deferred?.contract !==
          'release-bus-v2-baseline-automatic-e2e-deferred-v1' ||
        deferred.intent_id !== intent.intent_id ||
        deferred.intent_identity_sha256 !== intent.intent_identity_sha256 ||
        deferred.expensive_suite_executed !== false ||
        !frontend ||
        deferred.deploy_workflow_run_id !== frontend.deploy_workflow_run_id ||
        deferred.e2e_workflow_run_id !== frontend.e2e_workflow_run_id)
    )
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Automatic E2E defer evidence is malformed'
      );
    const backend: BackendEvidence[] = [];
    for (const unit of intent.required_backend_units) {
      const event = await this.repository.findEvent(
        backendEvidenceEventId(intent.intent_id, unit.service),
        {},
        false,
        true
      );
      if (!event) continue;
      const payload = parseStoredJson<BackendEvidence>(event.payload_json);
      if (
        event.event_type !== BACKEND_VERIFIED_EVENT ||
        payload?.contract !== 'release-bus-v2-baseline-backend-evidence-v1' ||
        payload.intent_id !== intent.intent_id ||
        payload.intent_identity_sha256 !== intent.intent_identity_sha256 ||
        payload.service !== unit.service ||
        payload.ref !== intent.expected_backend_ref ||
        payload.sha !== unit.expected_sha ||
        !RUN_ID_PATTERN.test(payload.workflow_run_id) ||
        !Number.isSafeInteger(payload.workflow_run_attempt) ||
        payload.workflow_run_attempt < 1 ||
        payload.runtime_sha !==
          (unit.service === 'api' ? intent.expected_backend_runtime_sha : null)
      )
        throw new ReleaseBusV2BaselineAdoptionError(
          'CONFLICT',
          `Backend deployment evidence for ${unit.service} is malformed`
        );
      backend.push(payload);
    }
    return { frontend, deferred, backend };
  }

  private async maybeFreezeAndDispatch(
    intent: PreparedIntent,
    ignoredRunIds: readonly string[]
  ): Promise<boolean> {
    this.assertUnexpired(intent);
    const existingFrozen = await this.repository.findEvent(
      frozenEventId(intent.intent_id),
      {},
      false,
      true
    );
    if (existingFrozen) {
      await this.ensureBoundE2EDispatched(intent);
      return true;
    }
    const evidence = await this.evidenceForIntent(intent);
    if (
      !evidence.frontend ||
      !evidence.deferred ||
      evidence.backend.length !== intent.required_backend_units.length
    )
      return false;
    const snapshot = await this.readFreezeSnapshot(intent, ignoredRunIds);
    try {
      await this.freezeManifest(
        intent,
        evidence.frontend,
        evidence.deferred,
        evidence.backend,
        snapshot
      );
    } catch (error) {
      const raced = await this.repository.findEvent(
        frozenEventId(intent.intent_id),
        {},
        false,
        true
      );
      if (!raced) throw error;
    }
    await this.ensureBoundE2EDispatched(intent);
    return true;
  }

  private async readFreezeSnapshot(
    intent: PreparedIntent,
    ignoredRunIds: readonly string[]
  ): Promise<{
    readonly state: ReleaseBusV2StagingStateRecord;
    readonly refs: StagingRefs;
    readonly runtimes: RuntimeShas;
    readonly candidates: readonly ReleaseBusV2CandidateRecord[];
  }> {
    const [
      controls,
      locks,
      trains,
      operations,
      state,
      refs,
      runtimes,
      activeWorkflow
    ] = await Promise.all([
      this.repository.listControls({}),
      this.repository.listLocks({}),
      this.repository.listActiveTrains({}),
      this.repository.listNonterminalOperationsForLanes(
        ['STAGING', 'PRODUCTION_QUALIFICATION'],
        {}
      ),
      this.repository.getStagingState({}),
      this.deps.resolveStagingRefs(),
      this.deps.readRuntimeShas(),
      this.deps.hasActiveStagingWorkflow(ignoredRunIds)
    ]);
    if (
      !controlsAreSafe(this.deps.getMode(), controls) ||
      !lockIsWhollyFree(
        locks.find(({ name }) => name === 'staging-environment')
      ) ||
      trains.some(({ lane }) =>
        ['STAGING', 'PRODUCTION_QUALIFICATION'].includes(lane)
      ) ||
      operations.length > 0 ||
      activeWorkflow ||
      state.row_version !== intent.expected_staging_state_row_version ||
      refs.frontend !== intent.expected_frontend_sha ||
      refs.backend !== intent.expected_backend_sha ||
      runtimes.frontend !== intent.expected_frontend_runtime_sha ||
      runtimes.backend !== intent.expected_backend_runtime_sha
    )
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'The final deployment event could not prove exact drained refs, runtimes, state, controls, and lock'
      );
    const candidates = await this.readExactCandidates(intent.candidates);
    await this.assertCandidateMembership(candidates);
    return { state, refs, runtimes, candidates };
  }

  private async freezeManifest(
    intent: PreparedIntent,
    frontend: FrontendEvidence,
    deferred: DeferredEvidence,
    backend: readonly BackendEvidence[],
    snapshot: {
      readonly state: ReleaseBusV2StagingStateRecord;
      readonly refs: StagingRefs;
      readonly runtimes: RuntimeShas;
      readonly candidates: readonly ReleaseBusV2CandidateRecord[];
    }
  ): Promise<void> {
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        if (
          await this.repository.findEvent(
            frozenEventId(intent.intent_id),
            ctx,
            true
          )
        )
          return;
        if (
          await this.repository.findEvent(
            failureEventId(intent.intent_id),
            ctx,
            true
          )
        )
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Baseline-adoption intent failed before manifest freeze'
          );
        const controls = await this.repository.listControls(ctx, true);
        const state = await this.repository.getStagingState(ctx, true);
        const activeTrains = await this.repository.listActiveTrains(ctx, true);
        const activeOperations =
          await this.repository.listNonterminalOperationsForLanes(
            ['STAGING', 'PRODUCTION_QUALIFICATION'],
            ctx,
            true
          );
        const candidates = await this.readExactCandidates(
          intent.candidates,
          ctx,
          true
        );
        const live = await this.repository.listLiveStagingCandidates(ctx, true);
        if (
          intent.expires_at <= this.deps.now() ||
          !controlsAreSafe(this.deps.getMode(), controls) ||
          state.row_version !== snapshot.state.row_version ||
          activeTrains.some(({ lane }) =>
            ['STAGING', 'PRODUCTION_QUALIFICATION'].includes(lane)
          ) ||
          activeOperations.length > 0 ||
          live.some(
            ({ id }) => !candidates.some((candidate) => candidate.id === id)
          )
        )
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Baseline-adoption freeze CAS fence changed'
          );
        const train = await this.repository.createTrain(
          {
            trainId: intent.intent_id,
            lane: 'STAGING',
            frontendBaseSha: intent.expected_frontend_sha,
            backendBaseSha: intent.expected_backend_sha,
            candidateIds: candidates.map(({ id }) => id),
            stagingPolicy: ADOPTION_POLICY,
            stagingBaselineManifestId: state.current_manifest_id,
            stagingTransition: {
              actor: intent.requested_by,
              reason: intent.reason,
              baseline_adoption_idempotency_key: intent.intent_id,
              baseline_adoption_intent_identity_sha256:
                intent.intent_identity_sha256,
              baseline_adoption_expires_at: intent.expires_at,
              baseline_adoption_required_backend_units:
                intent.required_backend_units.map(({ service }) => service),
              requested_at: this.deps.now(),
              baseline_state_version: state.row_version,
              baseline_manifest_id: state.current_manifest_id,
              baseline_frontend_sha: state.frontend_sha,
              baseline_backend_sha: state.backend_sha,
              observed_frontend_staging_sha: snapshot.refs.frontend,
              observed_backend_staging_sha: snapshot.refs.backend,
              carried_candidate_ids: candidates.map(({ id }) => id)
            },
            candidateRoles: Object.fromEntries(
              candidates.map(({ id }) => [id, 'ADOPTED_BASELINE'])
            ),
            initialStatus: 'E2E_RUNNING'
          },
          ctx
        );
        const lease = await this.repository.acquireLock(
          'staging-environment',
          train.id,
          `baseline-adoption:${intent.intent_id}`,
          ADOPTION_STAGING_LOCK_TTL_MS,
          ctx
        );
        if (!lease?.lease_token)
          throw new ReleaseBusV2BaselineAdoptionError(
            'CONFLICT',
            'Baseline-adoption freeze lost the staging environment lock'
          );
        const body: BaselineManifestBody = {
          contract: 'release-bus-v2-exact-deployed-baseline-adoption-v2',
          intent,
          staging_state_before: stateIdentity(state),
          exact_staging_refs: snapshot.refs,
          exact_deployed_runtimes: snapshot.runtimes,
          frontend_deployment: frontend,
          automatic_e2e_defer: deferred,
          backend_deployments: [...backend].sort((left, right) =>
            left.service.localeCompare(right.service)
          ),
          candidates: candidates.map(exactCandidateIdentity),
          mutation_contract: {
            ref_mutation: false,
            deployment: false,
            authoritative_state_activation:
              'AFTER_EXACT_MANIFEST_BOUND_E2E_AND_FINAL_CAS',
            production_lane_ownership: false
          }
        };
        const identity = sha256({ train_id: train.id, ...body });
        const manifest = await this.repository.createManifest(
          {
            train_id: train.id,
            lane: 'STAGING',
            identity_sha256: identity,
            status: 'STAGING_DEPLOYED',
            frontend_sha: snapshot.refs.frontend,
            backend_sha: snapshot.refs.backend,
            frontend_artifact_digest: null,
            backend_artifact_digest: null,
            e2e_run_id: null,
            manifest_json: body,
            deployed_at: this.deps.now(),
            validated_at: null
          },
          ctx
        );
        if (
          !(await this.repository.updateTrain(
            train.id,
            train.row_version,
            {
              status: 'E2E_RUNNING',
              frontendComposedSha: snapshot.refs.frontend,
              backendComposedSha: snapshot.refs.backend,
              manifestId: manifest.id
            },
            ctx
          ))
        )
          throw new Error('Baseline-adoption train changed during freeze');
        const updated = await this.repository.findTrain(train.id, ctx, true);
        if (!updated)
          throw new Error('Frozen baseline-adoption train is unavailable');
        const spec = this.workflowSpec(updated, manifest, intent.operation_key);
        await this.repository.getOrCreateOperation(
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
              workflow_control_sha: snapshot.refs.frontend,
              inputs: spec.inputs,
              beta_infrastructure_failure_injection: null
            },
            maxAttempts: 1
          },
          ctx
        );
        const frozenPayload: FrozenEventPayload = {
          contract: 'release-bus-v2-baseline-manifest-frozen-v1',
          intent_id: intent.intent_id,
          intent_identity_sha256: intent.intent_identity_sha256,
          manifest_id: manifest.id,
          manifest_identity_sha256: identity,
          operation_key: intent.operation_key
        };
        await this.repository.appendEvent(
          {
            eventId: frozenEventId(intent.intent_id),
            trainId: train.id,
            eventType: FROZEN_EVENT,
            actor: 'release-bus-v2',
            payload: frozenPayload
          },
          ctx
        );
      }
    );
  }

  private workflowSpec(
    train: ReleaseBusV2TrainRecord,
    manifest: ReleaseBusV2ManifestRecord,
    idempotencyKey: string
  ): ReleaseBusV2WorkflowSpec {
    const frontendSha = train.frontend_composed_sha;
    const backendSha = train.backend_composed_sha;
    if (
      train.staging_policy !== ADOPTION_POLICY ||
      !frontendSha ||
      !backendSha ||
      !SHA_PATTERN.test(frontendSha) ||
      !SHA_PATTERN.test(backendSha) ||
      !SHA256_PATTERN.test(manifest.identity_sha256) ||
      ![operationKey(train.id), legacyOperationKey(train.id)].includes(
        idempotencyKey
      )
    )
      throw new Error('Baseline-adoption E2E identity is incomplete');
    return {
      idempotencyKey,
      trainId: train.id,
      operationType: 'E2E_STAGING',
      repository: 'frontend',
      workflow: 'staging-e2e.yml',
      ref: '1a-staging',
      environment: 'staging',
      service: null,
      expectedSha: frontendSha,
      artifactDigest: manifest.identity_sha256,
      inputs: {
        pack: 'all',
        release_train_id: train.id,
        release_train_revision: '1',
        operation_key: 'replaced-by-reconciler',
        source_ref: '1a-staging',
        expected_sha: frontendSha,
        release_manifest_id: manifest.id,
        release_manifest_identity_sha256: manifest.identity_sha256,
        frontend_sha: frontendSha,
        backend_sha: backendSha,
        frontend_artifact_digest: '',
        backend_artifact_digest: ''
      },
      maxAttempts: 1
    };
  }

  private isExactBoundOperation(
    train: ReleaseBusV2TrainRecord,
    manifest: ReleaseBusV2ManifestRecord,
    operation: ReleaseBusV2OperationRecord,
    idempotencyKey: string
  ): boolean {
    try {
      const spec = this.workflowSpec(train, manifest, idempotencyKey);
      const request = parseStoredJson<unknown>(operation.request_json);
      return (
        operation.idempotency_key === spec.idempotencyKey &&
        operation.train_id === spec.trainId &&
        operation.operation_type === spec.operationType &&
        operation.repository === spec.repository &&
        operation.service === spec.service &&
        operation.environment === spec.environment &&
        operation.expected_sha === spec.expectedSha &&
        operation.artifact_digest === spec.artifactDigest &&
        operation.attempt === 1 &&
        operation.max_attempts === 1 &&
        isDeepStrictEqual(request, {
          workflow: spec.workflow,
          ref: spec.ref,
          workflow_control_sha: spec.expectedSha,
          inputs: spec.inputs,
          beta_infrastructure_failure_injection: null
        })
      );
    } catch {
      return false;
    }
  }

  private async ensureBoundE2EDispatched(
    intent: PreparedIntent
  ): Promise<void> {
    const train = await this.repository.findTrain(
      intent.intent_id,
      {},
      false,
      true
    );
    const manifest = train?.manifest_id
      ? await this.repository.findManifest(train.manifest_id, {}, true)
      : null;
    if (!train || !manifest)
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'Frozen baseline-adoption manifest is unavailable'
      );
    const reconciled = await this.operations.reconcileWorkflow(
      this.workflowSpec(train, manifest, intent.operation_key)
    );
    if (['FAILED', 'CANCELLED'].includes(reconciled.status)) {
      await this.failIntent(
        intent,
        `Bound E2E dispatch failed: ${
          reconciled.failure_message ?? reconciled.status
        }`
      );
      throw new ReleaseBusV2BaselineAdoptionError(
        'CONFLICT',
        'The sole manifest-bound E2E operation failed to dispatch'
      );
    }
    if (!['DISPATCHED', 'RUNNING', 'SUCCEEDED'].includes(reconciled.status))
      throw new ReleaseBusV2BaselineAdoptionError(
        'UNAVAILABLE',
        'The sole bound E2E dispatch is not yet durably reserved; retry the exact deployment event'
      );
  }

  private exactManifestBody(
    intent: PreparedIntent,
    train: ReleaseBusV2TrainRecord,
    manifest: ReleaseBusV2ManifestRecord
  ): BaselineManifestBody | null {
    try {
      const body = parseStoredJson<BaselineManifestBody>(
        manifest.manifest_json
      );
      if (!body) return null;
      const frontend = body.frontend_deployment;
      const deferred = body.automatic_e2e_defer;
      const exactBackend =
        body.backend_deployments.length ===
          intent.required_backend_units.length &&
        intent.required_backend_units.every((unit) => {
          const matches = body.backend_deployments.filter(
            ({ service }) => service === unit.service
          );
          return (
            matches.length === 1 &&
            matches[0].ref === intent.expected_backend_ref &&
            matches[0].sha === unit.expected_sha &&
            matches[0].runtime_sha ===
              (unit.service === 'api'
                ? intent.expected_backend_runtime_sha
                : null)
          );
        });
      if (
        body.contract !==
          'release-bus-v2-exact-deployed-baseline-adoption-v2' ||
        !isDeepStrictEqual(body.intent, intent) ||
        manifest.train_id !== train.id ||
        manifest.lane !== 'STAGING' ||
        manifest.frontend_sha !== intent.expected_frontend_sha ||
        manifest.backend_sha !== intent.expected_backend_sha ||
        train.frontend_composed_sha !== intent.expected_frontend_sha ||
        train.backend_composed_sha !== intent.expected_backend_sha ||
        body.exact_staging_refs.frontend !== intent.expected_frontend_sha ||
        body.exact_staging_refs.backend !== intent.expected_backend_sha ||
        body.exact_deployed_runtimes.frontend !==
          intent.expected_frontend_runtime_sha ||
        body.exact_deployed_runtimes.backend !==
          intent.expected_backend_runtime_sha ||
        frontend.intent_id !== intent.intent_id ||
        frontend.intent_identity_sha256 !== intent.intent_identity_sha256 ||
        frontend.ref !== intent.expected_frontend_ref ||
        frontend.sha !== intent.expected_frontend_sha ||
        frontend.runtime_sha !== intent.expected_frontend_runtime_sha ||
        deferred.intent_id !== intent.intent_id ||
        deferred.intent_identity_sha256 !== intent.intent_identity_sha256 ||
        deferred.deploy_workflow_run_id !== frontend.deploy_workflow_run_id ||
        deferred.e2e_workflow_run_id !== frontend.e2e_workflow_run_id ||
        deferred.expensive_suite_executed !== false ||
        !exactBackend ||
        body.mutation_contract.ref_mutation !== false ||
        body.mutation_contract.deployment !== false ||
        body.mutation_contract.authoritative_state_activation !==
          'AFTER_EXACT_MANIFEST_BOUND_E2E_AND_FINAL_CAS' ||
        body.mutation_contract.production_lane_ownership !== false ||
        manifest.identity_sha256 !== sha256({ train_id: train.id, ...body })
      )
        return null;
      return body;
    } catch {
      return null;
    }
  }

  private async finalize(
    intent: PreparedIntent,
    train: ReleaseBusV2TrainRecord,
    manifest: ReleaseBusV2ManifestRecord,
    operation: ReleaseBusV2OperationRecord
  ): Promise<void> {
    const body = this.exactManifestBody(intent, train, manifest);
    if (!body)
      throw new Error('Immutable baseline-adoption manifest is malformed');
    if (
      !this.isExactBoundOperation(
        train,
        manifest,
        operation,
        intent.operation_key
      )
    )
      throw new Error('Manifest-bound E2E operation identity is malformed');
    const [refs, runtimes, controls, otherActive, nonterminal, activeWorkflow] =
      await Promise.all([
        this.deps.resolveStagingRefs(),
        this.deps.readRuntimeShas(),
        this.repository.listControls({}),
        this.repository.listActiveTrains({}),
        this.repository.listNonterminalOperationsForLanes(
          ['STAGING', 'PRODUCTION_QUALIFICATION'],
          {}
        ),
        this.deps.hasActiveStagingWorkflow([operation.external_id!])
      ]);
    const state = await this.repository.getStagingState({});
    const lock = (await this.repository.listLocks({})).find(
      ({ name }) => name === 'staging-environment'
    );
    const candidates = await this.readExactCandidates(body.candidates);
    await this.assertCandidateMembership(candidates);
    if (
      refs.frontend !== intent.expected_frontend_sha ||
      refs.backend !== intent.expected_backend_sha ||
      runtimes.frontend !== intent.expected_frontend_runtime_sha ||
      runtimes.backend !== intent.expected_backend_runtime_sha ||
      !controlsAreSafe(this.deps.getMode(), controls) ||
      state.row_version !== body.staging_state_before.row_version ||
      otherActive.some(
        ({ id, lane }) =>
          id !== train.id &&
          ['STAGING', 'PRODUCTION_QUALIFICATION'].includes(lane)
      ) ||
      nonterminal.some(({ train_id }) => train_id !== train.id) ||
      lock?.owner_train_id !== train.id ||
      !lock.lease_token ||
      Number(lock.expires_at) <= this.deps.now() ||
      activeWorkflow
    )
      throw new Error(
        'Final refs, runtimes, controls, state, lock, or workflow fence changed'
      );
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const lockedTrain = await this.repository.findTrain(
          train.id,
          ctx,
          true
        );
        const lockedState = await this.repository.getStagingState(ctx, true);
        const lockedControls = await this.repository.listControls(ctx, true);
        const lockedOperations = await this.repository.listOperations(
          train.id,
          ctx,
          true
        );
        const lockedLock = (await this.repository.listLocks(ctx, true)).find(
          ({ name }) => name === 'staging-environment'
        );
        const failed = await this.repository.findEvent(
          failureEventId(intent.intent_id),
          ctx,
          true
        );
        const lockedCandidates = await this.readExactCandidates(
          body.candidates,
          ctx,
          true
        );
        const live = await this.repository.listLiveStagingCandidates(ctx, true);
        const exactE2e = lockedOperations.filter(
          (item) =>
            item.id === operation.id &&
            this.isExactBoundOperation(
              lockedTrain ?? train,
              manifest,
              item,
              intent.operation_key
            ) &&
            item.status === 'SUCCEEDED' &&
            item.external_id === operation.external_id &&
            item.artifact_digest === manifest.identity_sha256
        );
        if (
          !lockedTrain ||
          failed ||
          lockedTrain.row_version !== train.row_version ||
          lockedTrain.status !== 'E2E_RUNNING' ||
          lockedState.row_version !== body.staging_state_before.row_version ||
          !controlsAreSafe(this.deps.getMode(), lockedControls) ||
          lockedLock?.owner_train_id !== train.id ||
          !lockedLock.lease_token ||
          Number(lockedLock.expires_at) <= this.deps.now() ||
          lockedOperations.length !== 1 ||
          exactE2e.length !== 1 ||
          live.some(
            ({ id }) =>
              !lockedCandidates.some((candidate) => candidate.id === id)
          )
        )
          throw new Error('Final baseline-adoption CAS fence changed');
        if (
          !(await this.repository.updateStagingState(
            lockedState.row_version,
            {
              status: 'LIVE',
              currentManifestId: manifest.id,
              lastValidatedManifestId: manifest.id,
              frontendSha: intent.expected_frontend_sha,
              backendSha: intent.expected_backend_sha,
              frontendStagingRefSha: intent.expected_frontend_sha,
              backendStagingRefSha: intent.expected_backend_sha,
              cleanMain: false,
              lastTransitionTrainId: train.id
            },
            ctx
          ))
        )
          throw new Error('Authoritative staging state CAS failed');
        for (const candidate of lockedCandidates) {
          if (
            !(await this.repository.updateCandidate(
              candidate.id,
              candidate.row_version,
              {
                status: candidate.status,
                stagingValidatedTrainId: train.id,
                stagingValidatedManifestId: manifest.id,
                stagingLiveState: 'LIVE',
                stagingLiveManifestId: manifest.id,
                stagingAdmittedAt:
                  candidate.staging_admitted_at ?? this.deps.now(),
                stagingLiveUpdatedAt: this.deps.now()
              },
              ctx
            ))
          )
            throw new Error('Candidate staging evidence CAS failed');
        }
        await this.repository.updateManifestStatus(
          manifest.id,
          'STAGING_VALIDATED',
          operation.external_id,
          ctx
        );
        if (
          !(await this.repository.updateTrain(
            lockedTrain.id,
            lockedTrain.row_version,
            {
              status: 'STAGING_VALIDATED',
              completedAt: this.deps.now(),
              recoveryMessage:
                'Exact deployed staging baseline adopted after the sole bound E2E'
            },
            ctx
          ))
        )
          throw new Error('Baseline-adoption train CAS failed');
        await this.repository.appendEvent(
          {
            eventId: deterministicUuid(
              `baseline-adoption:${intent.intent_id}:adopted`
            ),
            trainId: train.id,
            eventType: ADOPTED_EVENT,
            actor: 'release-bus-v2',
            payload: {
              intent_id: intent.intent_id,
              intent_identity_sha256: intent.intent_identity_sha256,
              manifest_id: manifest.id,
              manifest_identity_sha256: manifest.identity_sha256,
              e2e_run_id: operation.external_id,
              candidate_ids: lockedCandidates.map(({ id }) => id),
              authoritative_state_cas: true,
              refs_mutated: false,
              deployment_performed: false,
              production_lane_mutated: false
            }
          },
          ctx
        );
      }
    );
    await this.releaseOwnedStagingLock(train.id);
  }

  private async failMany(
    intents: readonly PreparedIntent[],
    message: string
  ): Promise<void> {
    for (const intent of intents) await this.failIntent(intent, message);
  }

  private async failIntent(
    intent: PreparedIntent,
    message: string
  ): Promise<void> {
    const failedTrainId =
      await this.repository.executeNativeQueriesInTransaction<string | null>(
        async (connection) => {
          const ctx = { connection };
          const current = await this.repository.findTrain(
            intent.intent_id,
            ctx,
            true
          );
          if (current?.status === 'STAGING_VALIDATED') return null;
          if (current && current.status !== 'FAILED') {
            if (current.manifest_id)
              await this.repository.updateManifestStatus(
                current.manifest_id,
                'FAILED',
                null,
                ctx
              );
            if (
              !(await this.repository.updateTrain(
                current.id,
                current.row_version,
                {
                  status: 'FAILED',
                  failureClass: 'CONTROL_PLANE',
                  failureMessage: message,
                  recoveryMessage:
                    'Authoritative staging state and developer intent were left unchanged',
                  completedAt: this.deps.now()
                },
                ctx
              ))
            )
              throw new Error('Baseline-adoption failure CAS changed');
          }
          await this.repository.appendEvent(
            {
              eventId: failureEventId(intent.intent_id),
              trainId: current?.id ?? null,
              eventType: FAILED_EVENT,
              actor: 'release-bus-v2',
              payload: {
                intent_id: intent.intent_id,
                intent_identity_sha256: intent.intent_identity_sha256,
                failure_message: message,
                authoritative_staging_state_mutated: false,
                candidate_intent_mutated: false,
                refs_mutated: false,
                deployment_performed: false
              }
            },
            ctx
          );
          if (current)
            await this.cancelExactUndispatchedOperation(
              intent,
              current,
              message,
              'release-bus-v2',
              ctx
            );
          return current?.id ?? null;
        }
      );
    if (failedTrainId) await this.releaseOwnedStagingLock(failedTrainId);
  }

  private async cancelExactUndispatchedOperation(
    intent: PreparedIntent,
    train: ReleaseBusV2TrainRecord,
    message: string,
    actor: string,
    ctx: RequestContext
  ): Promise<void> {
    const operation = await this.repository.findOperation(
      intent.operation_key,
      ctx,
      true
    );
    if (operation?.status !== 'PENDING' || operation.external_id !== null)
      return;
    const manifest = train.manifest_id
      ? await this.repository.findManifest(train.manifest_id, ctx, true)
      : null;
    if (
      !manifest ||
      !this.isExactBoundOperation(
        train,
        manifest,
        operation,
        intent.operation_key
      )
    )
      throw new Error(
        'Failed baseline-adoption operation identity is ambiguous'
      );
    const completedAt = this.deps.now();
    if (
      !(await this.repository.updateOperation(
        operation.id,
        operation.row_version,
        {
          status: 'CANCELLED',
          failureClass: 'CONTROL_PLANE',
          failureMessage: message,
          completedAt
        },
        ctx
      ))
    )
      throw new Error(
        'Failed baseline-adoption operation changed concurrently'
      );
    await this.repository.appendEvent(
      {
        eventId: undispatchedOperationCancelledEventId(intent.intent_id),
        trainId: train.id,
        operationId: operation.id,
        eventType: UNDISPATCHED_OPERATION_CANCELLED_EVENT,
        actor,
        payload: {
          intent_id: intent.intent_id,
          intent_identity_sha256: intent.intent_identity_sha256,
          operation_id: operation.id,
          operation_key: operation.idempotency_key,
          previous_status: 'PENDING',
          operation_status: 'CANCELLED',
          dispatch_reservation_observed: false,
          external_workflow_run_observed: false,
          failure_message: message
        }
      },
      ctx
    );
  }

  private async recoverFailedUndispatchedOperation(
    intent: PreparedIntent,
    actor: string
  ): Promise<void> {
    await this.repository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        const failed = await this.repository.findEvent(
          failureEventId(intent.intent_id),
          ctx,
          true
        );
        const train = await this.repository.findTrain(
          intent.intent_id,
          ctx,
          true
        );
        if (!failed || train?.status !== 'FAILED') return;
        await this.cancelExactUndispatchedOperation(
          intent,
          train,
          'Cancelled an exact undispatched E2E operation after its baseline-adoption train failed closed',
          actor,
          ctx
        );
      }
    );
  }

  private async releaseOwnedStagingLock(trainId: string): Promise<void> {
    const lock = (await this.repository.listLocks({}, false, true)).find(
      ({ name }) => name === 'staging-environment'
    );
    if (lock?.owner_train_id === trainId && lock.lease_token)
      await this.repository.releaseLock(
        'staging-environment',
        lock.lease_token,
        {}
      );
  }

  private async result(
    intent: PreparedIntent,
    reused: boolean
  ): Promise<ReleaseBusV2BaselineAdoptionResult> {
    const failed = await this.repository.findEvent(
      failureEventId(intent.intent_id),
      {},
      false,
      true
    );
    const train = await this.repository.findTrain(
      intent.intent_id,
      {},
      false,
      true
    );
    const manifest = train?.manifest_id
      ? await this.repository.findManifest(train.manifest_id, {}, true)
      : null;
    const operation = train
      ? await this.repository.findOperation(intent.operation_key, {}, true)
      : null;
    return {
      adoption_id: intent.intent_id,
      intent_identity_sha256: intent.intent_identity_sha256,
      operation_key: intent.operation_key,
      expires_at: intent.expires_at,
      manifest_id: manifest?.id ?? null,
      manifest_identity_sha256: manifest?.identity_sha256 ?? null,
      operation_id: operation?.id ?? null,
      workflow_run_id: operation?.external_id ?? null,
      status: failed
        ? 'FAILED'
        : train?.status === 'STAGING_VALIDATED'
          ? 'STAGING_VALIDATED'
          : train
            ? 'E2E_RUNNING'
            : 'WAITING_FOR_DEPLOYMENTS',
      reused
    };
  }

  private async failClosed<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isReleaseBusV2BaselineAdoptionError(error)) throw error;
      this.logger.error('[BASELINE_ADOPTION] unexpected fail-closed error', {
        error_fingerprint_sha256: sha256(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { type: typeof error }
        )
      });
      throw new ReleaseBusV2BaselineAdoptionError(
        'UNAVAILABLE',
        'Baseline-adoption safety could not be proven; authoritative staging state is unchanged'
      );
    }
  }
}

export const releaseBusV2BaselineAdoptionService =
  new ReleaseBusV2BaselineAdoptionService();
