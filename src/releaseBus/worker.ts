import { topologicallySort } from '@/releaseBus/release-bus.dag';
import deployConfig from '@/config/deploy-services.json';
import { buildReleaseOperationKey } from '@/releaseBus/release-bus.idempotency';
import {
  getBaseCanaryEvidenceConfig,
  getBackendDeployConcurrency,
  getReleaseBusMode,
  RELEASE_BUS_LANE_TTL_MS
} from '@/releaseBus/release-bus.config';
import {
  BASE_EVIDENCE_CONTRACT_MARKER,
  buildLegacyFrontendGateContract,
  buildPromotedBaseEvidence,
  buildFrontendGateContract,
  evaluateBaseCanaryEvidence,
  FRONTEND_GATE_BASE_FILES,
  FRONTEND_BASE_IDENTITY_WORKFLOW,
  FRONTEND_GATE_TOOLING_FILES,
  FRONTEND_GATE_WORKFLOW,
  FRONTEND_PREFLIGHT_WORKFLOW,
  FRONTEND_STAGING_DEPLOY_WORKFLOW,
  FRONTEND_STAGING_E2E_WORKFLOW,
  LEGACY_FRONTEND_GATE_TOOLING_FILES,
  type AnyFrontendGateContract,
  type BaseEvidenceOperationProof,
  type FrontendGateMode
} from '@/releaseBus/release-bus.base-canary-evidence';
import {
  releaseBusGitHubApp,
  type GitHubRun,
  type GitHubWorkflowJob,
  type GitHubWorkflowStep
} from '@/releaseBus/release-bus.github-app';
import {
  leaseWaitReason,
  selectCurrentOperation,
  toOperationView,
  type ReleaseOperationView,
  type ReleaseWaitReason
} from '@/releaseBus/release-bus.observability';
import {
  releaseBusRepository,
  type ReleaseBusControlRecord,
  type ReleaseOperationRecord
} from '@/releaseBus/release-bus.repository';
import type {
  ReleaseCandidateRecord,
  ReleaseDeployPlan,
  ReleaseRepository,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';
import { publishReleaseBusMetrics } from '@/releaseBus/release-bus.metrics';

export type WorkerDecision = 'WAIT' | 'CONTINUE' | 'COMPLETE' | 'FAILED';
export type WorkerResult = {
  readonly decision: WorkerDecision;
  readonly train_id: string;
  readonly status: string;
  readonly message?: string;
  readonly wait_reason?: ReleaseWaitReason;
  readonly current_operation?: ReleaseOperationView | null;
};

class TerminalReleaseTrainError extends Error {
  public readonly releaseBusTerminalError = true;

  public constructor(message: string) {
    super(message);
    this.name = 'TerminalReleaseTrainError';
    Object.setPrototypeOf(this, TerminalReleaseTrainError.prototype);
  }
}

function isTerminalReleaseTrainError(
  error: unknown
): error is TerminalReleaseTrainError {
  return (
    error instanceof TerminalReleaseTrainError ||
    (error !== null &&
      typeof error === 'object' &&
      'releaseBusTerminalError' in error &&
      error.releaseBusTerminalError === true)
  );
}

class ConcurrentReleaseTrainPhaseError extends Error {
  public constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ConcurrentReleaseTrainPhaseError.prototype);
  }
}

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

async function loadTrain(trainId: string) {
  const train = await releaseBusRepository.findTrain(trainId, {});
  if (!train) throw new Error(`Release train ${trainId} not found`);
  const items = await releaseBusRepository.listTrainItems(trainId, {});
  // Promise.all preserves the train-item sequence. Filtering that array by
  // repository later therefore produces the exact candidate_shas order sent
  // to each compose workflow.
  const candidates = (
    await Promise.all(
      items.map((item) =>
        releaseBusRepository.findCandidateById(item.candidate_id, {})
      )
    )
  ).filter(
    (candidate): candidate is ReleaseCandidateRecord => candidate !== null
  );
  return { train, candidates };
}

function repositories(
  candidates: readonly ReleaseCandidateRecord[]
): ReleaseRepository[] {
  return (['backend', 'frontend'] as const).filter((repository) =>
    candidates.some((candidate) => candidate.repository === repository)
  );
}

function trainBranch(train: ReleaseTrainRecord): string {
  return `release-bus/${train.target_lane.toLowerCase()}-train-${train.id}-r${train.revision}`;
}

function workflowResult(
  operation: ReleaseOperationRecord
): 'PASS' | 'WAIT' | 'FAIL' {
  if (operation.status === 'SUCCEEDED') return 'PASS';
  if (['FAILED', 'CANCELLED'].includes(operation.status)) return 'FAIL';
  return 'WAIT';
}

const FAILURE_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'startup_failure',
  'timed_out'
]);

function boundedWorkflowLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized ? sanitized.slice(0, 500) : null;
}

function latestTimestamp(values: readonly (string | null | undefined)[]) {
  const now = Date.now();
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value <= now);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function workflowProgress(run: GitHubRun): Record<string, unknown> {
  const jobs = run.jobs ?? [];
  const activeJob = jobs.find((job) => job.status === 'in_progress') ?? null;
  const activeStep =
    activeJob?.steps?.find((step) => step.status === 'in_progress') ?? null;
  const failedJob =
    jobs.find((job) => FAILURE_CONCLUSIONS.has(job.conclusion ?? '')) ?? null;
  const failedStep =
    failedJob?.steps?.find((step) =>
      FAILURE_CONCLUSIONS.has(step.conclusion ?? '')
    ) ?? null;
  const jobTimestamps = jobs.flatMap((job: GitHubWorkflowJob) => [
    job.started_at,
    job.completed_at,
    ...(job.steps ?? []).flatMap((step: GitHubWorkflowStep) => [
      step.started_at,
      step.completed_at
    ])
  ]);
  return {
    url: run.html_url,
    workflow_status: run.status,
    workflow_conclusion: run.conclusion,
    active_job: boundedWorkflowLabel(activeJob?.name),
    active_step: boundedWorkflowLabel(activeStep?.name),
    failed_job: boundedWorkflowLabel(failedJob?.name),
    failed_step: boundedWorkflowLabel(failedStep?.name),
    last_progress_at: latestTimestamp([
      run.created_at,
      run.updated_at,
      ...jobTimestamps
    ])
  };
}

function validProgressTimestamp(value: unknown, now: number): number | null {
  let timestamp = Number.NaN;
  if (typeof value === 'number') timestamp = value;
  else if (typeof value === 'string') timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now
    ? timestamp
    : null;
}

export function mergeWorkflowProgress(
  previousResult: Record<string, unknown>,
  run: GitHubRun
): Record<string, unknown> {
  const currentProgress = workflowProgress(run);
  const now = Date.now();
  const timestamps = [
    validProgressTimestamp(previousResult.last_progress_at, now),
    validProgressTimestamp(currentProgress.last_progress_at, now)
  ].filter((value): value is number => value !== null);
  return {
    ...previousResult,
    ...currentProgress,
    last_progress_at: timestamps.length > 0 ? Math.max(...timestamps) : null
  };
}

function meaningfulWorkflowProgressChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  return [
    'workflow_status',
    'workflow_conclusion',
    'active_job',
    'active_step',
    'failed_job',
    'failed_step'
  ].some((key) => before[key] !== after[key]);
}

function githubActionsRunUrl(operation: ReleaseOperationRecord): string | null {
  const result = metadata(operation.result_metadata_json);
  const url = result.url;
  if (
    typeof url === 'string' &&
    /^https:\/\/github\.com\/6529-Collections\/6529seize-(?:frontend|backend)\/actions\/runs\/[0-9]+$/.test(
      url
    )
  )
    return url;
  return null;
}

export function operationFailureReason(
  reason: string,
  operation: ReleaseOperationRecord
): string {
  const evidenceUrl = githubActionsRunUrl(operation);
  return evidenceUrl ? `${reason} Evidence: ${evidenceUrl}` : reason;
}

// The array index is the completed attempt number; index zero is unused.
const BASE_CANARY_INFRASTRUCTURE_BACKOFF_MS = [
  0,
  0,
  0,
  5 * 60_000,
  10 * 60_000
];
const INFRASTRUCTURE_MAX_WORKFLOW_ATTEMPTS = 5;

export function baseCanaryInfrastructureRetryDelayMs(attempt: number): number {
  return BASE_CANARY_INFRASTRUCTURE_BACKOFF_MS[attempt] ?? 10 * 60_000;
}

function retryableInfrastructureFailure(
  operation: ReleaseOperationRecord
): boolean {
  const result = metadata(operation.result_metadata_json);
  const gateReport = metadata(result.gate_report);
  return (
    gateReport.failure_class === 'INFRASTRUCTURE_TRANSIENT' &&
    gateReport.retryable === true
  );
}

const E2E_INFRASTRUCTURE_SETUP_STEPS = new Set([
  'Install Socket Firewall',
  'Install and verify frozen dependencies',
  'Install dependencies',
  'Install Playwright browser'
]);

function retryableE2eInfrastructureFailure(
  operation: ReleaseOperationRecord
): boolean {
  if (retryableInfrastructureFailure(operation)) return true;
  if (!operation.operation_type.startsWith('e2e-')) return false;
  const result = metadata(operation.result_metadata_json);
  return (
    result.workflow_conclusion === 'failure' &&
    typeof result.failed_step === 'string' &&
    E2E_INFRASTRUCTURE_SETUP_STEPS.has(result.failed_step)
  );
}

function stringRecord(value: unknown): Record<string, string> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new TerminalReleaseTrainError(
        'Infrastructure retry inputs are not valid JSON'
      );
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TerminalReleaseTrainError(
      'Infrastructure retry inputs must be an object'
    );
  const entries = Object.entries(parsed);
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string'))
    throw new TerminalReleaseTrainError(
      'Infrastructure retry inputs must contain only strings'
    );
  return Object.fromEntries(entries) as Record<string, string>;
}

function latestOperationAttempts(
  operations: readonly ReleaseOperationRecord[]
): ReleaseOperationRecord[] {
  const latest = new Map<string, ReleaseOperationRecord>();
  const attempts = new Set<string>();
  for (const operation of operations) {
    const key = [
      operation.operation_type,
      operation.repository,
      operation.environment ?? '',
      operation.service ?? '',
      operation.expected_sha ?? ''
    ].join(':');
    const attemptKey = `${key}:${operation.attempt}`;
    if (attempts.has(attemptKey))
      throw new TerminalReleaseTrainError(
        `Release train ${operation.train_id} has duplicate ${operation.operation_type} attempt ${operation.attempt} for ${operation.expected_sha ?? 'an unknown SHA'}`
      );
    attempts.add(attemptKey);
    const previous = latest.get(key);
    if (!previous || operation.attempt > previous.attempt) {
      latest.set(key, operation);
    }
  }
  return Array.from(latest.values());
}

async function retryInfrastructureOperationIfDue(
  train: ReleaseTrainRecord,
  operation: ReleaseOperationRecord
): Promise<'DISPATCHED' | 'BACKOFF' | 'EXHAUSTED'> {
  if (operation.attempt >= INFRASTRUCTURE_MAX_WORKFLOW_ATTEMPTS)
    return 'EXHAUSTED';
  const delayMs = baseCanaryInfrastructureRetryDelayMs(operation.attempt);
  const completedAt = Number(operation.completed_at ?? Date.now());
  const retryAt =
    Number.isFinite(completedAt) && completedAt > 0
      ? completedAt + delayMs
      : Date.now() + delayMs;
  if (Date.now() < retryAt) return 'BACKOFF';

  const request = metadata(operation.request_metadata_json);
  const environment = ['orchestration', 'staging', 'prod'].includes(
    operation.environment ?? ''
  )
    ? (operation.environment as 'orchestration' | 'staging' | 'prod')
    : null;
  if (!operation.expected_sha)
    throw new TerminalReleaseTrainError(
      `Infrastructure retry operation ${operation.operation_key} is missing its expected SHA`
    );
  await dispatchWorkflow({
    train,
    repository: operation.repository as ReleaseRepository,
    operationType: operation.operation_type,
    workflow:
      typeof request.workflow === 'string'
        ? request.workflow
        : 'release-bus-base-canary.yml',
    ref: typeof request.ref === 'string' ? request.ref : 'main',
    expectedSha: operation.expected_sha,
    environment,
    service: operation.service,
    inputs: stringRecord(request.inputs),
    requestMetadata: {
      ...(request.gate_contract && typeof request.gate_contract === 'object'
        ? { gate_contract: request.gate_contract }
        : {}),
      ...(request.backend_deploy_graph &&
      typeof request.backend_deploy_graph === 'object'
        ? { backend_deploy_graph: request.backend_deploy_graph }
        : {}),
      infrastructure_retry_of: operation.operation_key,
      infrastructure_retry_at: Date.now()
    },
    attempt: operation.attempt + 1
  });
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DISPATCHED',
      payload: {
        operation_type: operation.operation_type,
        failed_operation_key: operation.operation_key,
        failed_attempt: operation.attempt,
        next_attempt: operation.attempt + 1,
        expected_sha: operation.expected_sha,
        delay_ms: delayMs,
        lane_paused: false
      }
    },
    {}
  );
  return 'DISPATCHED';
}

async function dispatchWorkflow(params: {
  readonly train: ReleaseTrainRecord;
  readonly repository: ReleaseRepository;
  readonly operationType: string;
  readonly workflow: string;
  readonly ref: string;
  readonly expectedSha: string;
  readonly environment?: 'orchestration' | 'staging' | 'prod' | null;
  readonly service?: string | null;
  readonly inputs: Record<string, string>;
  readonly requestMetadata?: Record<string, unknown>;
  readonly attempt?: number;
}): Promise<ReleaseOperationRecord> {
  const operationKey = buildReleaseOperationKey({
    trainId: params.train.id,
    revision: params.train.revision,
    operation: params.operationType,
    repository: params.repository,
    environment: params.environment ?? undefined,
    service: params.service ?? undefined,
    expectedSha: params.expectedSha,
    attempt: params.attempt
  });
  let operation = await releaseBusRepository.getOrCreateOperation(
    {
      operation_key: operationKey,
      train_id: params.train.id,
      revision: params.train.revision,
      operation_type: params.operationType,
      repository: params.repository,
      environment: params.environment ?? null,
      service: params.service ?? null,
      expected_sha: params.expectedSha,
      artifact_digest: null,
      attempt: params.attempt ?? 1,
      status: 'PENDING',
      external_id: null,
      request_metadata_json: {
        workflow: params.workflow,
        ref: params.ref,
        inputs: params.inputs,
        ...params.requestMetadata
      },
      result_metadata_json: null,
      started_at: null,
      completed_at: null
    },
    {}
  );
  if (operation.status === 'PENDING') {
    const existingRun = await releaseBusGitHubApp.findWorkflowRun(
      params.repository,
      params.workflow,
      operationKey
    );
    if (existingRun) {
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'DISPATCHED', externalId: String(existingRun.id) },
        {}
      );
    } else {
      try {
        await releaseBusGitHubApp.dispatchWorkflow(
          params.repository,
          params.workflow,
          params.ref,
          {
            ...params.inputs,
            operation_key: operationKey,
            release_train_id: params.train.id,
            release_train_revision: String(params.train.revision),
            expected_sha: params.expectedSha
          }
        );
        await releaseBusRepository.updateOperation(
          operationKey,
          { status: 'DISPATCHED' },
          {}
        );
      } catch (error) {
        await releaseBusRepository.updateOperation(
          operationKey,
          {
            status: 'AMBIGUOUS',
            resultMetadata: {
              message:
                error instanceof Error ? error.message : 'dispatch failed'
            }
          },
          {}
        );
      }
    }
    operation = (await releaseBusRepository.findOperation(
      operationKey,
      {}
    )) as ReleaseOperationRecord;
  }
  return operation;
}

export async function reconcile(
  operation: ReleaseOperationRecord,
  remainingWriteAttempts = 2
): Promise<ReleaseOperationRecord> {
  if (!['DISPATCHED', 'RUNNING', 'AMBIGUOUS'].includes(operation.status))
    return operation;
  const request = metadata(operation.request_metadata_json);
  const repository = operation.repository as ReleaseRepository;
  const run = await releaseBusGitHubApp.findWorkflowRun(
    repository,
    String(request.workflow),
    operation.operation_key,
    operation.external_id
  );
  if (!run) return operation;
  const previousResult = metadata(operation.result_metadata_json);
  const progress = mergeWorkflowProgress(previousResult, run);
  let nextStatus: ReleaseOperationRecord['status'];
  if (run.status !== 'completed') {
    nextStatus = 'RUNNING';
  } else if (run.conclusion === 'success') {
    nextStatus = 'SUCCEEDED';
    progress.head_sha = run.head_sha;
  } else {
    nextStatus = 'FAILED';
  }
  const updated = await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const operationUpdated =
        await releaseBusRepository.updateOperationIfVersion(
          operation.operation_key,
          operation.row_version,
          {
            status: nextStatus,
            externalId: String(run.id),
            resultMetadata: progress,
            completedAt: run.status === 'completed' ? Date.now() : undefined
          },
          context
        );
      if (!operationUpdated) return false;
      if (
        operation.status !== nextStatus ||
        meaningfulWorkflowProgressChanged(previousResult, progress)
      ) {
        await releaseBusRepository.appendEvent(
          {
            trainId: operation.train_id,
            eventType: 'OPERATION_PROGRESS',
            payload: {
              operation_key: operation.operation_key,
              operation_type: operation.operation_type,
              status: nextStatus,
              workflow_url: run.html_url,
              active_job: progress.active_job,
              active_step: progress.active_step,
              failed_job: progress.failed_job,
              failed_step: progress.failed_step
            }
          },
          context
        );
      }
      return true;
    }
  );
  if (!updated) {
    const refreshed = await releaseBusRepository.findOperation(
      operation.operation_key,
      {}
    );
    if (!refreshed || remainingWriteAttempts === 0)
      return refreshed ?? operation;
    return reconcile(refreshed, remainingWriteAttempts - 1);
  }
  return (await releaseBusRepository.findOperation(
    operation.operation_key,
    {}
  )) as ReleaseOperationRecord;
}

async function phaseOperations(
  trainId: string,
  prefix: string
): Promise<ReleaseOperationRecord[]> {
  return (await releaseBusRepository.listTrainOperations(trainId, {})).filter(
    (operation) => operation.operation_type.startsWith(prefix)
  );
}

function operationWaitReason(
  operation: ReleaseOperationView | null
): ReleaseWaitReason {
  if (!operation) {
    return {
      code: 'OPERATION_RECONCILING',
      summary: 'Waiting for the next deterministic Release Bus operation.'
    };
  }
  if (operation.health === 'STALLED') {
    return {
      code: 'OPERATION_STALLED',
      summary: `${operation.operation_type} is stalled: ${operation.stalled_reason}.`
    };
  }
  if (operation.phase === 'BASE_CANARY_RUNNING') {
    return {
      code: 'GITHUB_WORKFLOW_RUNNING',
      summary: `Frontend base canary running for staging SHA ${operation.expected_sha ?? 'unknown'}. Candidates have not been tested yet.`
    };
  }
  const external = operation.workflow_url ? ' GitHub Actions workflow' : '';
  return {
    code: operation.workflow_url
      ? 'GITHUB_WORKFLOW_RUNNING'
      : 'OPERATION_RUNNING',
    summary: `Waiting for ${operation.operation_type}${external} to complete.`
  };
}

async function waitFor(
  train: ReleaseTrainRecord,
  status: string,
  waitReason?: ReleaseWaitReason
): Promise<WorkerResult> {
  const operations = await releaseBusRepository.listTrainOperations(
    train.id,
    {}
  );
  const operation = selectCurrentOperation(operations);
  const currentOperation = operation ? toOperationView(operation) : null;
  const reason = waitReason ?? operationWaitReason(currentOperation);
  const fingerprint = JSON.stringify({
    code: reason.code,
    lease: reason.lease?.name ?? null,
    operation_key: currentOperation?.operation_key ?? null,
    stalled_reason: currentOperation?.stalled_reason ?? null
  });
  const latestEvent = (
    await releaseBusRepository.listTrainEvents(train.id, 1, {})
  )[0];
  const latestPayload = metadata(latestEvent?.payload_json);
  if (
    latestEvent?.event_type !== 'TRAIN_WAITING' ||
    latestPayload.fingerprint !== fingerprint
  ) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'TRAIN_WAITING',
        payload: {
          fingerprint,
          phase: currentOperation?.phase ?? status,
          wait_reason: reason,
          operation_key: currentOperation?.operation_key ?? null
        }
      },
      {}
    );
  }
  return {
    decision: 'WAIT',
    train_id: train.id,
    status,
    message: reason.summary,
    wait_reason: reason,
    current_operation: currentOperation
  };
}

async function updateTrainPhase(
  train: ReleaseTrainRecord,
  status: ReleaseTrainRecord['status']
): Promise<void> {
  await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const advanced = await releaseBusRepository.advanceTrainPhase(
        train.id,
        train.status,
        train.row_version,
        status,
        context
      );
      if (!advanced)
        throw new ConcurrentReleaseTrainPhaseError(
          `Release train ${train.id} changed concurrently from ${train.status}`
        );
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          eventType: 'TRAIN_PHASE_CHANGED',
          payload: { from: train.status, to: status }
        },
        context
      );
    }
  );
}

async function retryInfrastructureFailures(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  failed: readonly ReleaseOperationRecord[],
  prefix: string
): Promise<'INFRASTRUCTURE_WAIT' | 'INFRASTRUCTURE_EXHAUSTED'> {
  const exhausted = failed.find(
    (operation) => operation.attempt >= INFRASTRUCTURE_MAX_WORKFLOW_ATTEMPTS
  );
  if (exhausted) {
    await failInfrastructureTrainWithoutPausing(
      train,
      candidates,
      exhausted,
      prefix.replace(/-$/, '')
    );
    return 'INFRASTRUCTURE_EXHAUSTED';
  }
  const retryResults = await Promise.allSettled(
    failed.map((operation) =>
      retryInfrastructureOperationIfDue(train, operation)
    )
  );
  const rejected = retryResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (isTerminalReleaseTrainError(rejected?.reason)) throw rejected.reason;
  if (rejected) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DEFERRED',
        payload: {
          phase: prefix.replace(/-$/, ''),
          message:
            rejected.reason instanceof Error
              ? rejected.reason.message
              : 'Infrastructure retry dispatch failed',
          lane_paused: false
        }
      },
      {}
    );
  }
  return 'INFRASTRUCTURE_WAIT';
}

async function pollPhase(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  prefix: string,
  isRetryableInfrastructureFailure: (
    operation: ReleaseOperationRecord
  ) => boolean = retryableInfrastructureFailure
): Promise<
  'PASS' | 'WAIT' | 'INFRASTRUCTURE_WAIT' | 'INFRASTRUCTURE_EXHAUSTED' | 'FAIL'
> {
  const operations = latestOperationAttempts(
    await phaseOperations(train.id, prefix)
  );
  if (operations.length === 0) return 'WAIT';
  const reconciled = await Promise.all(
    operations.map((operation) => reconcile(operation))
  );
  const failed = reconciled.filter(
    (operation) => workflowResult(operation) === 'FAIL'
  );
  if (failed.length > 0) {
    if (failed.every(isRetryableInfrastructureFailure)) {
      return retryInfrastructureFailures(train, candidates, failed, prefix);
    }
    return 'FAIL';
  }
  return reconciled.every((operation) => workflowResult(operation) === 'PASS')
    ? 'PASS'
    : 'WAIT';
}

async function infrastructurePhaseResult(
  train: ReleaseTrainRecord,
  result:
    | 'PASS'
    | 'WAIT'
    | 'INFRASTRUCTURE_WAIT'
    | 'INFRASTRUCTURE_EXHAUSTED'
    | 'FAIL',
  phase: string
): Promise<WorkerResult | null> {
  if (result === 'INFRASTRUCTURE_EXHAUSTED')
    return {
      decision: 'FAILED',
      train_id: train.id,
      status: 'FAILED',
      message: `Release ${phase} infrastructure retries were exhausted; candidates were returned to the running lane`
    };
  if (result !== 'INFRASTRUCTURE_WAIT') return null;
  return waitFor(train, train.status, {
    code: 'INFRASTRUCTURE_RETRY_BACKOFF',
    summary: `Release ${phase} hit transient CI infrastructure. The exact failed operation will retry automatically; candidates remain attached and the lane is not paused.`
  });
}

async function beginComposition(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  const branch = trainBranch(train);
  for (const repository of repositories(candidates)) {
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha)
      throw new TerminalReleaseTrainError(`Missing ${repository} base SHA`);
    const shas = candidates
      .filter((candidate) => candidate.repository === repository)
      .map((candidate) => candidate.head_sha);
    await dispatchWorkflow({
      train,
      repository,
      operationType: `compose-${repository}`,
      workflow: 'release-bus-compose.yml',
      ref: 'main',
      expectedSha: baseSha,
      environment: 'orchestration',
      inputs: {
        target_lane: train.target_lane,
        base_sha: baseSha,
        candidate_shas: JSON.stringify(shas),
        release_branch: branch
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'COMPOSING',
      frontendReleaseBranch: candidates.some(
        (candidate) => candidate.repository === 'frontend'
      )
        ? branch
        : null,
      backendReleaseBranch: candidates.some(
        (candidate) => candidate.repository === 'backend'
      )
        ? branch
        : null
    },
    {}
  );
}

function normalizeArtifactDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^sha256:/, '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

type BaseCanaryEvidenceConfig = {
  readonly reuse: boolean;
  readonly shadow: boolean;
  readonly maxAgeHours: number;
};

async function resolveBaseCanaryEvidenceConfig(): Promise<BaseCanaryEvidenceConfig> {
  const deployed = getBaseCanaryEvidenceConfig();
  try {
    const [reuseValue, shadowValue, maxAgeValue] = await Promise.all([
      releaseBusGitHubApp.getActionsVariable(
        'backend',
        'RELEASE_BUS_BASE_EVIDENCE_REUSE'
      ),
      releaseBusGitHubApp.getActionsVariable(
        'backend',
        'RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW'
      ),
      releaseBusGitHubApp.getActionsVariable(
        'backend',
        'RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS'
      )
    ]);
    const toggle = (
      value: string | null,
      fallback: boolean
    ): boolean | null => {
      if (value === null) return fallback;
      const normalized = value.toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
      return null;
    };
    const reuse = toggle(reuseValue, deployed.reuse);
    const shadow = toggle(shadowValue, deployed.shadow);
    const maxAgeHours = Number(maxAgeValue ?? deployed.maxAgeHours);
    if (
      reuse === null ||
      shadow === null ||
      !Number.isInteger(maxAgeHours) ||
      maxAgeHours < 1 ||
      maxAgeHours > 168
    )
      return { reuse: false, shadow: false, maxAgeHours: 24 };
    return { reuse, shadow, maxAgeHours };
  } catch {
    return {
      reuse: false,
      shadow: false,
      maxAgeHours: deployed.maxAgeHours
    };
  }
}

function storedFrontendGateContract(
  operation: ReleaseOperationRecord
): AnyFrontendGateContract | null {
  const value = metadata(operation.request_metadata_json).gate_contract;
  if (!value || typeof value !== 'object') return null;
  const contract = value as Partial<AnyFrontendGateContract> &
    Record<string, unknown>;
  if (
    ![1, 2].includes(contract.schema_version ?? 0) ||
    contract.repository !== 'frontend' ||
    contract.environment !== 'orchestration' ||
    !/^[a-f0-9]{40}$/.test(contract.base_sha ?? '') ||
    !/^[a-f0-9]{64}$/.test(contract.gate_fingerprint ?? '') ||
    !/^[a-f0-9]{40}$/.test(contract.workflow_sha ?? '') ||
    !/^[a-f0-9]{64}$/.test(contract.workflow_digest ?? '') ||
    contract.node_version !== '22' ||
    typeof contract.package_manager !== 'string' ||
    !['legacy', 'shadow', 'sharded'].includes(contract.gate_mode ?? '') ||
    ![1, 2, 4].includes(contract.shard_count ?? 0) ||
    !contract.component_digests ||
    typeof contract.component_digests !== 'object'
  )
    return null;
  if (
    contract.schema_version === 2 &&
    (contract.kind !== 'frontend_base_evidence_contract' ||
      !/^[a-f0-9]{64}$/.test(contract.behavior_digest ?? '') ||
      !/^[a-f0-9]{64}$/.test(contract.build_profile_digest ?? ''))
  )
    return null;
  return contract as AnyFrontendGateContract;
}

async function resolveFrontendGateContract(
  baseSha: string,
  options: {
    readonly workflowSha?: string;
    readonly gateMode?: FrontendGateMode;
    readonly shardCount?: 1 | 2 | 4;
    readonly buildProfileDigest?: string;
  } = {}
): Promise<AnyFrontendGateContract> {
  const workflowSha =
    options.workflowSha ??
    (await releaseBusGitHubApp.resolveRef('frontend', 'main'));
  const gateEvidenceSource = await releaseBusGitHubApp.getFileContent(
    'frontend',
    'scripts/release-bus-gate-evidence.cjs',
    workflowSha
  );
  const supportsCarryForward = gateEvidenceSource.includes(
    BASE_EVIDENCE_CONTRACT_MARKER
  );
  const toolingFiles = supportsCarryForward
    ? FRONTEND_GATE_TOOLING_FILES
    : LEGACY_FRONTEND_GATE_TOOLING_FILES;
  const workflowFiles = supportsCarryForward
    ? [
        FRONTEND_GATE_WORKFLOW,
        FRONTEND_PREFLIGHT_WORKFLOW,
        FRONTEND_BASE_IDENTITY_WORKFLOW,
        FRONTEND_STAGING_DEPLOY_WORKFLOW,
        FRONTEND_STAGING_E2E_WORKFLOW,
        ...toolingFiles
      ]
    : [FRONTEND_GATE_WORKFLOW, ...toolingFiles];
  const [workflowContents, baseContents, modeValue, shardValue] =
    await Promise.all([
      Promise.all(
        workflowFiles.map((file) =>
          releaseBusGitHubApp.getFileContent('frontend', file, workflowSha)
        )
      ),
      Promise.all(
        FRONTEND_GATE_BASE_FILES.map((file) =>
          releaseBusGitHubApp.getFileContent('frontend', file, baseSha)
        )
      ),
      releaseBusGitHubApp.getActionsVariable(
        'frontend',
        'RELEASE_BUS_FRONTEND_GATE_MODE'
      ),
      releaseBusGitHubApp.getActionsVariable(
        'frontend',
        'FRONTEND_GATE_SHARD_COUNT'
      )
    ]);
  const gateMode = (options.gateMode ?? modeValue ?? 'legacy').toLowerCase();
  if (!['legacy', 'shadow', 'sharded'].includes(gateMode))
    throw new Error('Invalid frontend gate mode variable');
  const shardCount = Number(options.shardCount ?? shardValue ?? 1);
  if (![1, 2, 4].includes(shardCount))
    throw new Error('Invalid frontend gate shard count variable');
  const contractInput = {
    baseSha,
    workflowSha,
    workflowFileContents: Object.fromEntries(
      workflowFiles.map((file, index) => [file, workflowContents[index]])
    ),
    baseFileContents: Object.fromEntries(
      FRONTEND_GATE_BASE_FILES.map((file, index) => [file, baseContents[index]])
    ),
    gateMode: gateMode as FrontendGateMode,
    shardCount: shardCount as 1 | 2 | 4
  };
  return supportsCarryForward
    ? buildFrontendGateContract({
        ...contractInput,
        buildProfileDigest: options.buildProfileDigest ?? ''
      })
    : buildLegacyFrontendGateContract(contractInput);
}

async function publishBaseEvidenceLookup(
  train: ReleaseTrainRecord,
  decision: 'HIT' | 'MISS' | 'INVALIDATED' | 'FORCE_FRESH',
  reason: string
): Promise<void> {
  await publishReleaseBusMetrics([
    {
      MetricName: 'BaseCanaryEvidenceLookup',
      Value: 1,
      Dimensions: [
        { Name: 'Lane', Value: train.target_lane },
        { Name: 'Decision', Value: decision },
        { Name: 'Reason', Value: reason.slice(0, 100) }
      ]
    }
  ]);
}

type ReleaseBusMetricDatum = Parameters<
  typeof publishReleaseBusMetrics
>[0][number];

function metricLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function baseCanaryMetrics(
  train: ReleaseTrainRecord,
  operation: ReleaseOperationRecord,
  gateReport: Record<string, unknown>,
  summary: Record<string, unknown> | null
): ReleaseBusMetricDatum[] {
  const phaseDurations = metadata(summary?.phase_durations_ms);
  const operationStartedAt = Number(operation.started_at);
  const operationCompletedAt = Number(operation.completed_at);
  const observedOperationDuration = operationCompletedAt - operationStartedAt;
  const totalDuration =
    Number.isFinite(observedOperationDuration) && observedOperationDuration >= 0
      ? observedOperationDuration
      : Number(phaseDurations.total);
  const metricData: ReleaseBusMetricDatum[] = [];
  if (Number.isFinite(totalDuration) && totalDuration >= 0) {
    metricData.push({
      MetricName: 'BaseCanaryFreshDurationSeconds',
      Unit: 'Seconds',
      Value: totalDuration / 1000,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    });
  }
  const shards = Array.isArray(summary?.shards) ? summary.shards : [];
  const shardDurations: number[] = [];
  for (const value of shards) {
    const shard = metadata(value);
    const duration = Number(shard.duration_ms);
    if (!Number.isFinite(duration) || duration < 0) continue;
    shardDurations.push(duration);
    metricData.push({
      MetricName: 'BaseCanaryShardDurationSeconds',
      Unit: 'Seconds',
      Value: duration / 1000,
      Dimensions: [
        { Name: 'Lane', Value: train.target_lane },
        { Name: 'Shard', Value: metricLabel(shard.coordinate, 'unknown') }
      ]
    });
  }
  if (shardDurations.length > 0) {
    metricData.push({
      MetricName: 'BaseCanaryShardImbalanceSeconds',
      Unit: 'Seconds',
      Value: (Math.max(...shardDurations) - Math.min(...shardDurations)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    });
  }
  const missing = Array.isArray(summary?.missing_files)
    ? summary.missing_files.length
    : 1;
  const duplicate = Array.isArray(summary?.duplicate_files)
    ? summary.duplicate_files.length
    : 1;
  if (missing + duplicate > 0) {
    metricData.push({
      MetricName: 'BaseCanaryCountMismatch',
      Value: missing + duplicate,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    });
  }
  if (operation.status !== 'SUCCEEDED') {
    const stages = Array.isArray(gateReport.stages) ? gateReport.stages : [];
    const failed = stages
      .map(metadata)
      .find((stage) => stage.status === 'FAILED');
    metricData.push({
      MetricName: 'BaseCanaryFailure',
      Value: 1,
      Dimensions: [
        { Name: 'Lane', Value: train.target_lane },
        { Name: 'Phase', Value: metricLabel(failed?.name, 'workflow') }
      ]
    });
  }
  return metricData;
}

async function recordFreshBaseCanaryEvidence(
  train: ReleaseTrainRecord,
  operation: ReleaseOperationRecord,
  maxAgeHours: number
): Promise<void> {
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status)) return;
  const result = metadata(operation.result_metadata_json);
  const gateReport = metadata(result.gate_report);
  const summary =
    gateReport.summary && typeof gateReport.summary === 'object'
      ? (gateReport.summary as Record<string, unknown>)
      : null;
  const storedContract = storedFrontendGateContract(operation);
  const contract =
    storedContract ??
    (summary && operation.expected_sha
      ? await frontendContractFromSummary(operation.expected_sha, summary)
      : null);
  if (!contract) return;
  const createdAt = Number(
    gateReport.reported_at ?? operation.completed_at ?? Date.now()
  );
  const artifactDigest = normalizeArtifactDigest(
    summary?.summary_artifact_digest
  );
  const inserted = await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const evidenceInserted = await releaseBusRepository.addEvidence(
        {
          idempotencyKey: `base-canary-completed:${operation.operation_key}`,
          trainId: train.id,
          revision: train.revision,
          evidenceType: 'BASE_CANARY_COMPLETED',
          status: operation.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          sourceSha: contract.base_sha,
          artifactDigest,
          evidenceUri:
            typeof result.url === 'string' ? result.url.slice(0, 1000) : null,
          metadata: {
            schema_version: contract.schema_version,
            source_kind: 'fresh_base_canary',
            anchored_full_proof: true,
            contract,
            summary,
            gate_stages: gateReport.stages ?? [],
            source_operation_key: operation.operation_key,
            source_run_id: operation.external_id,
            source_train_id: train.id,
            created_at: createdAt,
            expires_at: createdAt + maxAgeHours * 60 * 60 * 1000
          }
        },
        context
      );
      if (!evidenceInserted) return false;
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          eventType: 'BASE_CANARY_EVIDENCE_RECORDED',
          payload: {
            operation_key: operation.operation_key,
            run_id: operation.external_id,
            base_sha: contract.base_sha,
            gate_fingerprint: contract.gate_fingerprint,
            behavior_digest:
              contract.schema_version === 2 ? contract.behavior_digest : null,
            artifact_digest: artifactDigest,
            fresh_or_reused: 'fresh',
            status: operation.status
          }
        },
        context
      );
      return true;
    }
  );
  if (!inserted) return;
  const metricData = baseCanaryMetrics(train, operation, gateReport, summary);
  if (metricData.length > 0) await publishReleaseBusMetrics(metricData);
}

async function frontendContractFromSummary(
  expectedSha: string,
  summary: Record<string, unknown>
): Promise<AnyFrontendGateContract | null> {
  const workflowSha =
    typeof summary.workflow_sha === 'string' ? summary.workflow_sha : '';
  const gateMode = summary.gate_mode;
  const shardCount = Number(summary.shard_count);
  const buildProfileDigest = normalizeArtifactDigest(
    summary.build_profile_digest
  );
  if (
    !/^[a-f0-9]{40}$/.test(workflowSha) ||
    !['legacy', 'shadow', 'sharded'].includes(String(gateMode)) ||
    ![1, 2, 4].includes(shardCount) ||
    !buildProfileDigest
  )
    return null;
  try {
    const contract = await resolveFrontendGateContract(expectedSha, {
      workflowSha,
      gateMode: gateMode as FrontendGateMode,
      shardCount: shardCount as 1 | 2 | 4,
      buildProfileDigest
    });
    return contract.schema_version === 2 &&
      contract.gate_fingerprint === summary.gate_fingerprint &&
      contract.behavior_digest === summary.behavior_digest &&
      contract.workflow_digest === summary.workflow_digest
      ? contract
      : null;
  } catch {
    return null;
  }
}

async function reuseBaseCanaryEvidence(
  train: ReleaseTrainRecord,
  contract: AnyFrontendGateContract,
  evidence: {
    readonly id: string;
    readonly train_id: string;
    readonly revision: number;
    readonly evidence_type: string;
    readonly artifact_digest: string | null;
    readonly evidence_uri: string | null;
    readonly created_at: number | string;
  },
  sourceMetadata: Record<string, unknown>,
  eventType: 'BASE_CANARY_EVIDENCE_REUSED' | 'BASE_CANARY_EVIDENCE_WOULD_REUSE'
): Promise<void> {
  const sourceProof = metadata(sourceMetadata.proof);
  const sourcePreflight = metadata(sourceProof.preflight);
  const sourceDeployment = metadata(sourceProof.deployment);
  const sourceE2e = metadata(sourceProof.e2e);
  const carriedForward = evidence.evidence_type === 'BASE_EVIDENCE_PROMOTED';
  const sourceProofSummary = carriedForward
    ? {
        source_proof_digest: sourceMetadata.proof_digest ?? null,
        source_preflight_run_id: sourcePreflight.run_id ?? null,
        source_preflight_run_url: sourcePreflight.run_url ?? null,
        source_preflight_artifact_digest:
          sourcePreflight.artifact_digest ?? null,
        source_deployment_run_id: sourceDeployment.run_id ?? null,
        source_deployment_run_url: sourceDeployment.run_url ?? null,
        source_deployment_artifact_digest:
          sourceDeployment.artifact_digest ?? null,
        source_e2e_run_id: sourceE2e.run_id ?? null,
        source_e2e_run_url: sourceE2e.run_url ?? null
      }
    : {};
  await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const inserted = await releaseBusRepository.addEvidence(
        {
          idempotencyKey: `${eventType.toLowerCase()}:${train.id}:r${train.revision}:${contract.base_sha}`,
          trainId: train.id,
          revision: train.revision,
          evidenceType: eventType,
          status: 'SUCCEEDED',
          sourceSha: contract.base_sha,
          artifactDigest: evidence.artifact_digest,
          evidenceUri: evidence.evidence_uri,
          metadata: {
            schema_version: 1,
            contract,
            fresh_or_reused: eventType.endsWith('_REUSED') ? 'reused' : 'fresh',
            source_evidence_id: evidence.id,
            source_evidence_type: evidence.evidence_type,
            source_train_id: evidence.train_id,
            source_train_revision: evidence.revision,
            source_run_id: sourceMetadata.source_run_id ?? null,
            source_created_at: Number(evidence.created_at),
            source_expires_at: sourceMetadata.expires_at ?? null,
            ...sourceProofSummary,
            reused_at: Date.now()
          }
        },
        context
      );
      if (!inserted) return;
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          eventType,
          payload: {
            status: eventType.endsWith('_REUSED') ? 'reused' : 'would-reuse',
            base_sha: contract.base_sha,
            gate_fingerprint: contract.gate_fingerprint,
            source_evidence_id: evidence.id,
            source_evidence_type: evidence.evidence_type,
            source_train_id: evidence.train_id,
            source_run_id: sourceMetadata.source_run_id ?? null,
            evidence_uri: evidence.evidence_uri,
            source_artifact_digest: evidence.artifact_digest,
            ...sourceProofSummary,
            reason: carriedForward
              ? 'exact_sha_and_gate_contract_match_carried_forward_proof'
              : 'exact_sha_and_gate_contract_match_fresh_canary_proof'
          }
        },
        context
      );
    }
  );
}

type FrontendBaseCanaryResult =
  | 'PASS'
  | 'WAIT'
  | 'INFRASTRUCTURE_WAIT'
  | 'FAIL';

async function existingFrontendBaseCanaryResult(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  baseSha: string
): Promise<FrontendBaseCanaryResult | null> {
  const existingOperations = await phaseOperations(
    train.id,
    'base-canary-frontend'
  );
  if (
    new Set(existingOperations.map((operation) => operation.attempt)).size !==
    existingOperations.length
  )
    throw new TerminalReleaseTrainError(
      `Release train ${train.id} has duplicate frontend base canary attempts`
    );
  const existing = [...existingOperations].sort(
    (left, right) => right.attempt - left.attempt
  )[0];
  if (!existing) return null;
  const operation = await reconcile(existing);
  const result = workflowResult(operation);
  if (result !== 'WAIT') {
    const evidenceConfig = await resolveBaseCanaryEvidenceConfig();
    await recordFreshBaseCanaryEvidence(
      train,
      operation,
      evidenceConfig.maxAgeHours
    );
  }
  if (result !== 'FAIL') {
    if (train.status === 'FROZEN')
      await updateTrainPhase(train, 'BASE_CANARY_RUNNING');
    return result;
  }
  if (retryableInfrastructureFailure(operation)) {
    if (train.status === 'FROZEN')
      await updateTrainPhase(train, 'BASE_CANARY_RUNNING');
    const retry = await retryInfrastructureOperationIfDue(train, operation);
    if (retry === 'EXHAUSTED') {
      await failInfrastructureTrainWithoutPausing(
        train,
        candidates,
        operation,
        'base-canary-frontend'
      );
      return 'FAIL';
    }
    return 'INFRASTRUCTURE_WAIT';
  }
  await failAndPauseTrain(
    train,
    candidates,
    operationFailureReason(
      `Existing staging base failed the frontend base canary for SHA ${baseSha}. Candidates had not been tested. No candidate was blamed. ${train.target_lane} was paused. Repair and validate the existing base, deploy that isolated repair, then resume ${train.target_lane}.`,
      operation
    ),
    'REQUEUE',
    {
      attribution: 'PRE_EXISTING_BASE',
      recommendedRecovery:
        'Repair and validate the existing staging base, deploy that isolated repair, then resume the paused lane.'
    }
  );
  return 'FAIL';
}

async function resolveFrontendGateContractFailClosed(
  train: ReleaseTrainRecord,
  baseSha: string,
  options?: Parameters<typeof resolveFrontendGateContract>[1]
): Promise<AnyFrontendGateContract | null> {
  try {
    return await resolveFrontendGateContract(baseSha, options);
  } catch {
    await publishBaseEvidenceLookup(
      train,
      'INVALIDATED',
      'contract_unavailable'
    );
    return null;
  }
}

async function recordUnavailableBaseEvidenceContract(
  train: ReleaseTrainRecord,
  baseSha: string
): Promise<void> {
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'BASE_CANARY_EVIDENCE_LOOKUP_INVALIDATED',
      payload: {
        base_sha: baseSha,
        reason: 'contract_unavailable',
        action: 'fresh_validation'
      }
    },
    {}
  );
}

async function prepareFreshFrontendBaseCanary(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  baseSha: string
): Promise<{
  readonly gateContract: AnyFrontendGateContract | null;
  readonly result: 'PASS' | 'WAIT' | null;
}> {
  const evidenceConfig = await resolveBaseCanaryEvidenceConfig();
  const forceFreshCandidateIds = candidates
    .filter(
      (candidate) =>
        candidate.repository === 'frontend' &&
        Boolean(candidate.force_fresh_base_canary)
    )
    .map((candidate) => candidate.id);
  if (forceFreshCandidateIds.length > 0) {
    await publishBaseEvidenceLookup(
      train,
      'FORCE_FRESH',
      'operator_force_fresh'
    );
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'BASE_CANARY_EVIDENCE_FORCE_FRESH',
        payload: {
          base_sha: baseSha,
          candidate_ids: forceFreshCandidateIds
        }
      },
      {}
    );
    return { gateContract: null, result: null };
  }
  if (!evidenceConfig.reuse && !evidenceConfig.shadow)
    return { gateContract: null, result: null };
  const identityOperations = latestOperationAttempts(
    await phaseOperations(train.id, 'base-evidence-identity-frontend')
  );
  let identity = identityOperations[0];
  if (!identity) {
    await dispatchWorkflow({
      train,
      repository: 'frontend',
      operationType: 'base-evidence-identity-frontend',
      workflow: 'release-bus-base-evidence-identity.yml',
      ref: 'main',
      expectedSha: baseSha,
      environment: 'orchestration',
      inputs: { base_sha: baseSha }
    });
    await updateTrainPhase(train, 'BASE_CANARY_RUNNING');
    return { gateContract: null, result: 'WAIT' };
  }
  identity = await reconcile(identity);
  if (workflowResult(identity) === 'WAIT')
    return { gateContract: null, result: 'WAIT' };
  if (workflowResult(identity) === 'FAIL') {
    await publishBaseEvidenceLookup(train, 'INVALIDATED', 'identity_error');
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'BASE_CANARY_EVIDENCE_LOOKUP_INVALIDATED',
        payload: {
          base_sha: baseSha,
          reason: 'identity_error',
          action: 'fresh_validation',
          identity_operation_key: identity.operation_key
        }
      },
      {}
    );
    return { gateContract: null, result: null };
  }
  const identityReport = metadata(
    metadata(identity.result_metadata_json).gate_report
  );
  const buildProfileDigest = normalizeArtifactDigest(
    identityReport.build_profile_digest
  );
  if (!buildProfileDigest) {
    await recordUnavailableBaseEvidenceContract(train, baseSha);
    return { gateContract: null, result: null };
  }
  const gateContract = await resolveFrontendGateContractFailClosed(
    train,
    baseSha,
    { buildProfileDigest }
  );
  if (!gateContract) {
    await recordUnavailableBaseEvidenceContract(train, baseSha);
    return { gateContract, result: null };
  }
  try {
    const rows = await releaseBusRepository.listBaseCanaryEvidenceBySha(
      baseSha,
      {}
    );
    const evidenceDecision = evaluateBaseCanaryEvidence({
      rows,
      contract: gateContract,
      now: Date.now(),
      maxAgeMs: evidenceConfig.maxAgeHours * 60 * 60 * 1000
    });
    await publishBaseEvidenceLookup(
      train,
      evidenceDecision.decision,
      evidenceDecision.reason
    );
    if (evidenceDecision.decision !== 'HIT')
      return { gateContract, result: null };
    await reuseBaseCanaryEvidence(
      train,
      gateContract,
      evidenceDecision.evidence,
      evidenceDecision.metadata,
      evidenceConfig.reuse
        ? 'BASE_CANARY_EVIDENCE_REUSED'
        : 'BASE_CANARY_EVIDENCE_WOULD_REUSE'
    );
    return {
      gateContract,
      result: evidenceConfig.reuse ? 'PASS' : null
    };
  } catch {
    await publishBaseEvidenceLookup(train, 'INVALIDATED', 'lookup_error');
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'BASE_CANARY_EVIDENCE_LOOKUP_INVALIDATED',
        payload: {
          base_sha: baseSha,
          reason: 'lookup_error',
          action: 'fresh_validation'
        }
      },
      {}
    );
    return { gateContract, result: null };
  }
}

async function advanceFrontendBaseCanary(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<FrontendBaseCanaryResult> {
  if (!candidates.some((candidate) => candidate.repository === 'frontend'))
    return 'PASS';
  const baseSha = train.frontend_base_sha;
  if (!baseSha)
    throw new TerminalReleaseTrainError('Missing frontend base SHA');
  const existingResult = await existingFrontendBaseCanaryResult(
    train,
    candidates,
    baseSha
  );
  if (existingResult) return existingResult;
  const prepared = await prepareFreshFrontendBaseCanary(
    train,
    candidates,
    baseSha
  );
  if (prepared.result) return prepared.result;
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: 'base-canary-frontend',
    workflow: 'release-bus-base-canary.yml',
    ref: 'main',
    expectedSha: baseSha,
    environment: 'orchestration',
    inputs: {
      base_sha: baseSha,
      ...(prepared.gateContract
        ? {
            gate_contract: JSON.stringify(prepared.gateContract)
          }
        : {})
    },
    requestMetadata: prepared.gateContract
      ? { gate_contract: prepared.gateContract }
      : undefined
  });
  await updateTrainPhase(train, 'BASE_CANARY_RUNNING');
  return 'WAIT';
}

async function beginPreflight(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  for (const repository of repositories(candidates)) {
    const branch = trainBranch(train);
    const sha = await releaseBusGitHubApp.resolveRef(repository, branch);
    const units = repository === 'backend' ? backendUnits(candidates) : [];
    await dispatchWorkflow({
      train,
      repository,
      operationType: `preflight-${repository}`,
      workflow: 'release-bus-preflight.yml',
      ref: 'main',
      expectedSha: sha,
      environment: 'orchestration',
      inputs: {
        target_lane: train.target_lane,
        release_branch: branch,
        deploy_units: JSON.stringify(units)
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'PREFLIGHTING' },
    {}
  );
}

function parsePlan(
  candidate: ReleaseCandidateRecord
): ReleaseDeployPlan | null {
  const value = candidate.deploy_plan_json;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ReleaseDeployPlan;
    } catch {
      return null;
    }
  }
  return value;
}

function backendUnits(
  candidates: readonly ReleaseCandidateRecord[],
  environment?: 'staging' | 'prod'
): string[] {
  return backendDeployGraph(candidates, environment).order;
}

export function backendDeployGraph(
  candidates: readonly ReleaseCandidateRecord[],
  environment?: 'staging' | 'prod'
) {
  const plans = candidates
    .filter((candidate) => candidate.repository === 'backend')
    .map(parsePlan)
    .filter((plan): plan is ReleaseDeployPlan => Boolean(plan));
  if (
    plans.length !==
    candidates.filter((candidate) => candidate.repository === 'backend').length
  ) {
    throw new TerminalReleaseTrainError(
      'Every backend candidate requires a valid deploy DAG'
    );
  }
  const requestedUnits = Array.from(
    new Set(plans.flatMap((plan) => plan.units))
  );
  const knownServices = new Map(
    deployConfig.services.map((service) => [service.name, service])
  );
  const unknownUnits = requestedUnits.filter(
    (unit) => !knownServices.has(unit)
  );
  if (unknownUnits.length > 0) {
    throw new TerminalReleaseTrainError(
      `Backend deploy DAG references unknown units: ${unknownUnits.sort().join(', ')}`
    );
  }
  const units = environment
    ? requestedUnits.filter((unit) => {
        const service = knownServices.get(unit);
        return service?.allowed_environments.includes(environment) ?? false;
      })
    : requestedUnits;
  const requested = new Set(units);
  const allCandidateEdges = plans.flatMap((plan) => plan.edges);
  const malformedEdges = allCandidateEdges.filter(
    ([before, after]) =>
      !requestedUnits.includes(before) || !requestedUnits.includes(after)
  );
  if (malformedEdges.length > 0) {
    throw new TerminalReleaseTrainError(
      `Backend deploy DAG edge references an unknown selected unit: ${malformedEdges
        .map(([before, after]) => `${before}->${after}`)
        .sort()
        .join(', ')}`
    );
  }
  const candidateEdges = allCandidateEdges.filter(
    ([before, after]) => requested.has(before) && requested.has(after)
  );
  const registryEdges = deployConfig.services.flatMap((service) =>
    service.default_dependencies
      .filter(
        (dependency) => requested.has(dependency) && requested.has(service.name)
      )
      .map((dependency) => [dependency, service.name] as [string, string])
  );
  const edges = Array.from(
    new Map(
      [...registryEdges, ...candidateEdges].map((edge) => [
        `${edge[0]}\0${edge[1]}`,
        edge as readonly [string, string]
      ])
    ).values()
  ).sort(([leftBefore, leftAfter], [rightBefore, rightAfter]) =>
    `${leftBefore}\0${leftAfter}`.localeCompare(`${rightBefore}\0${rightAfter}`)
  );
  try {
    const graph = topologicallySort(units, edges);
    return { ...graph, edges };
  } catch (error) {
    throw new TerminalReleaseTrainError(
      error instanceof Error ? error.message : 'Invalid backend deploy DAG'
    );
  }
}

async function ensureLane(
  name: string,
  train: ReleaseTrainRecord
): Promise<boolean> {
  if (
    await releaseBusRepository.heartbeatLane(
      name,
      train.id,
      RELEASE_BUS_LANE_TTL_MS,
      {}
    )
  )
    return true;
  return Boolean(
    await releaseBusRepository.executeNativeQueriesInTransaction((connection) =>
      releaseBusRepository.acquireLane(
        name,
        train.id,
        `step-functions:${train.id}`,
        RELEASE_BUS_LANE_TTL_MS,
        { connection }
      )
    )
  );
}

async function waitForRequiredLane(
  train: ReleaseTrainRecord,
  laneName: 'global-staging' | 'global-production'
): Promise<WorkerResult | null> {
  if (await ensureLane(laneName, train)) return null;
  return waitFor(
    train,
    train.status,
    leaseWaitReason(laneName, await releaseBusRepository.getLane(laneName, {}))
  );
}

async function continueAtPhase(
  train: ReleaseTrainRecord,
  status: ReleaseTrainRecord['status']
): Promise<WorkerResult> {
  await updateTrainPhase(train, status);
  return { decision: 'CONTINUE', train_id: train.id, status };
}

async function reloadTrain(trainId: string): Promise<ReleaseTrainRecord> {
  return (await releaseBusRepository.findTrain(
    trainId,
    {}
  )) as ReleaseTrainRecord;
}

async function advanceGuardedPhase(params: {
  readonly train: ReleaseTrainRecord;
  readonly lane: 'global-staging' | 'global-production';
  readonly run: () => Promise<'PASS' | 'WAIT' | 'FAIL'>;
  readonly failureMessage: string;
  readonly nextStatus: ReleaseTrainRecord['status'];
}): Promise<WorkerResult> {
  const laneWait = await waitForRequiredLane(params.train, params.lane);
  if (laneWait) return laneWait;
  // The phase write is not a mutex. Every run callback is built from durable
  // operation keys or expected-SHA branch updates, so a duplicate tick first
  // reconciles the same external effect instead of starting a second one.
  const result = await params.run();
  if (result === 'FAIL')
    throw new TerminalReleaseTrainError(params.failureMessage);
  if (result === 'WAIT') return waitFor(params.train, params.train.status);
  return continueAtPhase(params.train, params.nextStatus);
}

async function externalDeploymentLaneBusy(
  environment: 'staging' | 'prod'
): Promise<ReleaseRepository | null> {
  for (const repository of ['frontend', 'backend'] as const) {
    if (
      await releaseBusGitHubApp.hasActiveDeploymentRun(repository, environment)
    )
      return repository;
  }
  return null;
}

export async function advanceBackendDeploy(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  environment: 'staging' | 'prod'
): Promise<
  'PASS' | 'WAIT' | 'FAIL' | 'INFRASTRUCTURE_WAIT' | 'INFRASTRUCTURE_EXHAUSTED'
> {
  const graph = backendDeployGraph(candidates, environment);
  const units = graph.order;
  if (environment === 'prod' && units.length > 0 && !train.backend_pr_number) {
    throw new TerminalReleaseTrainError(
      `Missing backend release PR for production train ${train.id}`
    );
  }
  if (units.length === 0) return 'PASS';

  const prefix = `deploy-backend-${environment}-`;
  const existing = latestOperationAttempts(
    await phaseOperations(train.id, prefix)
  );
  const unknownOperations = existing.filter(
    (operation) => !operation.service || !units.includes(operation.service)
  );
  if (unknownOperations.length > 0) {
    throw new TerminalReleaseTrainError(
      `Backend deploy operation does not belong to the effective DAG: ${unknownOperations
        .map((operation) => operation.service ?? operation.operation_key)
        .join(', ')}`
    );
  }
  const settled = await Promise.allSettled(
    existing.map((operation) => reconcile(operation))
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (rejected) throw rejected.reason;
  const operations = settled.map(
    (result) => (result as PromiseFulfilledResult<ReleaseOperationRecord>).value
  );
  const byService = new Map(
    operations.map((operation) => [operation.service as string, operation])
  );
  const concurrency = getBackendDeployConcurrency();
  const activeCount = operations.filter((operation) =>
    ['PENDING', 'DISPATCHED', 'RUNNING', 'AMBIGUOUS'].includes(operation.status)
  ).length;

  for (let layerIndex = 0; layerIndex < graph.layers.length; layerIndex += 1) {
    const layer = graph.layers[layerIndex];
    const layerOperations = layer.flatMap((unit) => {
      const operation = byService.get(unit);
      return operation ? [operation] : [];
    });
    if (
      layer.every((unit) => {
        const operation = byService.get(unit);
        return operation ? workflowResult(operation) === 'PASS' : false;
      })
    ) {
      continue;
    }

    const failed = layerOperations.filter(
      (operation) => workflowResult(operation) === 'FAIL'
    );
    const active = layerOperations.filter(
      (operation) => workflowResult(operation) === 'WAIT'
    );
    const missing = layer.filter((unit) => !byService.has(unit));

    // A failed sibling never unlocks dependants. Already-running siblings are
    // allowed to settle so their immutable success evidence survives retries.
    if (failed.length > 0) {
      if (active.length > 0) return 'WAIT';
      if (failed.every(retryableInfrastructureFailure)) {
        return retryInfrastructureFailures(train, candidates, failed, prefix);
      }
      return 'FAIL';
    }

    const available = Math.max(0, concurrency - activeCount);
    const frontier = missing.slice(0, available);
    if (frontier.length > 0) {
      const ref = environment === 'staging' ? trainBranch(train) : 'main';
      const sha = await releaseBusGitHubApp.resolveRef('backend', ref);
      const artifactRunId = await preflightRunId(train.id, 'backend');
      const releaseGroupServices = units.join(',');
      const dispatches = await Promise.allSettled(
        frontier.map((unit) =>
          dispatchWorkflow({
            train,
            repository: 'backend',
            operationType: `${prefix}${unit}`,
            workflow: 'deploy.yml',
            ref: 'main',
            expectedSha: sha,
            environment,
            service: unit,
            inputs: {
              environment,
              service: unit,
              artifact_run_id: artifactRunId,
              ...(environment === 'prod'
                ? {
                    release_pull_request: String(train.backend_pr_number),
                    release_note_publish: 'true',
                    release_group_services: releaseGroupServices
                  }
                : {})
            },
            requestMetadata: {
              backend_deploy_graph: {
                edges: graph.edges,
                layers: graph.layers,
                active_layer: layerIndex,
                frontier,
                concurrency
              }
            }
          })
        )
      );
      const rejectedDispatch = dispatches.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
      if (rejectedDispatch) throw rejectedDispatch.reason;
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          eventType: 'BACKEND_DEPLOY_FRONTIER_DISPATCHED',
          payload: {
            environment,
            layer: layerIndex,
            frontier,
            concurrency,
            edges: graph.edges,
            layers: graph.layers
          }
        },
        {}
      );
    }
    return 'WAIT';
  }
  return 'PASS';
}

async function advanceBackendDeploymentPhase(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  environment: 'staging' | 'prod',
  nextStatus: ReleaseTrainRecord['status']
): Promise<WorkerResult> {
  const lane =
    environment === 'staging' ? 'global-staging' : 'global-production';
  const laneWait = await waitForRequiredLane(train, lane);
  if (laneWait) return laneWait;
  const result = await advanceBackendDeploy(train, candidates, environment);
  const infrastructureResult = await infrastructurePhaseResult(
    train,
    result,
    `backend ${environment} deployment`
  );
  if (infrastructureResult) return infrastructureResult;
  if (result === 'FAIL') {
    throw new TerminalReleaseTrainError(
      `Backend ${environment} deployment failed`
    );
  }
  if (result === 'WAIT') return waitFor(train, train.status);
  return continueAtPhase(train, nextStatus);
}

async function advanceFrontendDeploy(
  train: ReleaseTrainRecord,
  environment: 'staging' | 'prod'
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  if (!train.frontend_release_branch) return 'PASS';
  const type = `deploy-frontend-${environment}`;
  const existing = (await phaseOperations(train.id, type))[0];
  if (existing) return workflowResult(await reconcile(existing));
  const ref = environment === 'staging' ? trainBranch(train) : 'main';
  const sha = await releaseBusGitHubApp.resolveRef('frontend', ref);
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: type,
    workflow:
      environment === 'staging'
        ? 'release-bus-deploy-staging.yml'
        : 'release-bus-deploy-production.yml',
    ref: 'main',
    expectedSha: sha,
    environment,
    inputs: {
      source_ref: ref,
      artifact_run_id: await preflightRunId(train.id, 'frontend')
    }
  });
  return 'WAIT';
}

async function preflightRunId(
  trainId: string,
  repository: ReleaseRepository
): Promise<string> {
  const operation = (
    await releaseBusRepository.listTrainOperations(trainId, {})
  ).find(
    (candidate) =>
      candidate.operation_type === `preflight-${repository}` &&
      candidate.status === 'SUCCEEDED'
  );
  if (!operation?.external_id) {
    throw new TerminalReleaseTrainError(
      `Missing ${repository} preflight run for train ${trainId}`
    );
  }
  return operation.external_id;
}

async function beginFailureIsolation(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string
): Promise<void> {
  const dependencies = await releaseBusRepository.listDependencies(
    candidates.map((candidate) => candidate.id),
    {}
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const dependenciesByCandidate = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (!candidateIds.has(dependency.depends_on_candidate_id)) continue;
    const existing = dependenciesByCandidate.get(dependency.candidate_id) ?? [];
    existing.push(dependency.depends_on_candidate_id);
    dependenciesByCandidate.set(dependency.candidate_id, existing);
  }
  const dependencyClosure = (candidateId: string): Set<string> => {
    const closure = new Set<string>();
    const visit = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      for (const dependency of dependenciesByCandidate.get(id) ?? [])
        visit(dependency);
    };
    visit(candidateId);
    return closure;
  };

  for (const repository of repositories(candidates)) {
    const baseSha =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) continue;
    const repositoryCandidates = candidates.filter(
      (candidate) => candidate.repository === repository
    );
    for (const variant of ['baseline', 'combined-retry'] as const) {
      const subset = variant === 'baseline' ? [] : repositoryCandidates;
      await dispatchWorkflow({
        train,
        repository,
        operationType: `isolate-${variant}-${repository}`,
        workflow: 'release-bus-isolate-candidate.yml',
        ref: 'main',
        expectedSha: baseSha,
        environment: 'orchestration',
        inputs: {
          base_sha: baseSha,
          candidate_id: `${variant}-${repository}`,
          candidate_shas: JSON.stringify(
            subset.map((candidate) => candidate.head_sha)
          ),
          deploy_units: JSON.stringify(
            backendUnits(variant === 'baseline' ? candidates : subset)
          ),
          failure_reason: reason.slice(0, 500)
        }
      });
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const closure = dependencyClosure(candidate.id);
    const subset = candidates.filter((item) => closure.has(item.id));
    const baseSha =
      candidate.repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!baseSha) continue;
    await dispatchWorkflow({
      train,
      repository: candidate.repository,
      operationType: `isolate-candidate-${`000${index + 1}`.slice(-3)}-${candidate.id}`,
      workflow: 'release-bus-isolate-candidate.yml',
      ref: 'main',
      expectedSha: candidate.head_sha,
      environment: 'orchestration',
      inputs: {
        base_sha: baseSha,
        candidate_id: candidate.id,
        candidate_shas: JSON.stringify(
          subset
            .filter((item) => item.repository === candidate.repository)
            .map((item) => item.head_sha)
        ),
        deploy_units: JSON.stringify(backendUnits(subset)),
        failure_reason: reason.slice(0, 500)
      }
    });
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'ISOLATING_FAILURE', failureReason: reason },
    {}
  );
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_FAILURE_ISOLATION_STARTED',
      payload: { reason, candidate_ids: candidates.map((item) => item.id) }
    },
    {}
  );
}

async function releaseTrainLanes(train: ReleaseTrainRecord): Promise<void> {
  for (const laneName of [
    'global-production',
    'global-staging',
    'global-orchestration'
  ]) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token)
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
  }
}

async function publishCandidateStatus(
  train: ReleaseTrainRecord,
  candidate: ReleaseCandidateRecord,
  state: 'error' | 'failure' | 'pending' | 'success',
  description: string
): Promise<void> {
  try {
    await releaseBusGitHubApp.ensureCommitStatus(
      candidate.repository,
      candidate.head_sha,
      state,
      description
    );
  } catch (error) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        candidateId: candidate.id,
        eventType: 'CANDIDATE_COMMIT_STATUS_FAILED',
        payload: {
          state,
          message: error instanceof Error ? error.message : 'status failed'
        }
      },
      {}
    );
  }
}

const CANDIDATE_PHASE_LABELS: Partial<
  Record<ReleaseTrainRecord['status'], string>
> = {
  FROZEN: 'candidate set frozen',
  BASE_CANARY_RUNNING: 'checking the unchanged staging base',
  COMPOSING: 'composing the immutable candidate',
  PREFLIGHTING: 'running exact-SHA preflight',
  ISOLATING_FAILURE: 'isolating a deterministic failure',
  DEPLOYING_BACKEND: 'deploying the staging backend frontier',
  DEPLOYING_FRONTEND: 'deploying the immutable staging frontend artifact',
  E2E_RUNNING: 'running staging E2E',
  VALIDATING_STAGING: 'finalizing staging evidence',
  MERGING_PRODUCTION: 'advancing backend production main',
  DEPLOYING_BACKEND_PRODUCTION: 'deploying the production backend frontier',
  MERGING_FRONTEND_PRODUCTION: 'advancing frontend production main',
  DEPLOYING_FRONTEND_PRODUCTION:
    'deploying the immutable production frontend artifact',
  PRODUCTION_E2E_RUNNING: 'running production-safe E2E',
  VALIDATING_PRODUCTION: 'finalizing production evidence',
  SYNCING_STAGING: 'synchronizing production back to staging'
};

export function candidatePhaseDescription(
  train: ReleaseTrainRecord
): string | null {
  const label = CANDIDATE_PHASE_LABELS[train.status];
  return label
    ? `Release Bus: ${label} (train ${train.id.slice(0, 8)})`
    : null;
}

async function publishCandidatePhaseStatuses(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  const description = candidatePhaseDescription(train);
  if (!description) return;
  await Promise.all(
    candidates.map((candidate) =>
      publishCandidateStatus(train, candidate, 'pending', description)
    )
  );
}

async function failInfrastructureTrainWithoutPausing(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  operation: ReleaseOperationRecord,
  phase: string
): Promise<void> {
  const reason = operationFailureReason(
    `${phase} exhausted ${INFRASTRUCTURE_MAX_WORKFLOW_ATTEMPTS} automatic workflow attempts after repeated transient infrastructure failures. Candidates were returned to the queue and ${train.target_lane} remains running.`,
    operation
  );
  const returnedCandidates: string[] = [];
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      !current ||
      ![
        'STAGING_CLAIMED',
        'STAGING_VALIDATING',
        'PRODUCTION_CLAIMED',
        'PRODUCTION_VALIDATING'
      ].includes(current.status)
    )
      continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: `INFRASTRUCTURE_RETRY_EXHAUSTED:${phase}`.slice(0, 500)
      },
      {}
    );
    returnedCandidates.push(current.id);
    await publishCandidateStatus(
      train,
      candidate,
      'error',
      `CI infrastructure retries exhausted; automatically requeued (${train.id})`
    );
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'FAILED', failureReason: reason, completedAt: Date.now() },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_INFRASTRUCTURE_RETRIES_EXHAUSTED',
      payload: {
        reason,
        phase,
        operation_key: operation.operation_key,
        attempt: operation.attempt,
        max_attempts: INFRASTRUCTURE_MAX_WORKFLOW_ATTEMPTS,
        returned_candidates: returnedCandidates,
        lane_paused: false,
        automatic_recovery:
          'The running lane may form a fresh train from the returned immutable candidates.'
      }
    },
    {}
  );
  await publishReleaseBusMetrics([
    {
      MetricName: 'InfrastructureRetryExhausted',
      Value: 1,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    },
    {
      MetricName: 'TrainFailure',
      Value: 1,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    }
  ]);
}

export async function finishIncompleteComposition(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<ReleaseCandidateRecord | null> {
  const branch = trainBranch(train);
  let offender: ReleaseCandidateRecord | null = null;
  // Compose stops at the first conflict in the same train-item order used
  // here. Later missing candidates were not attempted: requeueing them cannot
  // repeat this conflict because the first offender is quarantined.
  for (const candidate of candidates) {
    if (
      !(await releaseBusGitHubApp.refContainsCommit(
        candidate.repository,
        branch,
        candidate.head_sha
      ))
    ) {
      offender = candidate;
      break;
    }
  }
  if (!offender) return null;

  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      !current ||
      !['STAGING_CLAIMED', 'PRODUCTION_CLAIMED'].includes(current.status)
    )
      continue;
    const isOffender = candidate.id === offender.id;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: isOffender ? 'QUARANTINED' : readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: isOffender ? 'MERGE_CONFLICT_REQUIRES_DEVELOPER' : null
      },
      {}
    );
  }

  await publishCandidateStatus(
    train,
    offender,
    'failure',
    `Merge conflict requires developer action (${train.id})`
  );
  if (offender.pr_number) {
    try {
      await releaseBusGitHubApp.commentOnPullRequest(
        offender.repository,
        offender.pr_number,
        [
          `Release Bus quarantined immutable candidate \`${offender.head_sha}\` after it conflicted with the fresh target and earlier candidates in train \`${train.id}\`.`,
          '',
          'Codex conflict resolution was unavailable or did not produce a complete composition. Other candidates were returned to the queue.',
          '',
          'Rebase or resolve the conflict, push the fix (which creates a new SHA), and mark that new SHA ready again.'
        ].join('\n')
      );
    } catch (error) {
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          candidateId: offender.id,
          eventType: 'CANDIDATE_COMPOSITION_COMMENT_FAILED',
          payload: {
            message: error instanceof Error ? error.message : 'comment failed'
          }
        },
        {}
      );
      await publishReleaseBusMetrics([
        {
          MetricName: 'CandidateNotificationFailure',
          Value: 1,
          Dimensions: [
            { Name: 'Lane', Value: train.target_lane },
            { Name: 'Channel', Value: 'PullRequestComment' }
          ]
        }
      ]);
    }
  }

  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'CANCELLED',
      failureReason: `Candidate ${offender.id} was not present in the composed release branch`,
      completedAt: Date.now()
    },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      candidateId: offender.id,
      eventType: 'CANDIDATE_QUARANTINED_BY_COMPOSITION',
      payload: {
        repository: offender.repository,
        head_sha: offender.head_sha,
        release_branch: branch
      }
    },
    {}
  );
  return offender;
}

type FailureDisposition = 'QUARANTINE' | 'REQUEUE';

function failureLifecycle(
  train: ReleaseTrainRecord,
  reason: string,
  disposition: FailureDisposition,
  attribution: 'PRE_EXISTING_BASE' | 'CANDIDATE' | 'TRAIN' | undefined
) {
  if (disposition === 'QUARANTINE') {
    return {
      status: 'QUARANTINED' as const,
      currentTrainId: null,
      holdReason: reason.slice(0, 500)
    };
  }
  return {
    status: readyStatusForTrain(train),
    currentTrainId: null,
    holdReason:
      attribution === 'PRE_EXISTING_BASE'
        ? 'BASE_FAILURE_NO_CANDIDATE_BLAMED'
        : 'TRAIN_PAUSED_UNATTRIBUTED_FAILURE'
  };
}

async function releaseCandidateAfterTrainFailure(
  train: ReleaseTrainRecord,
  candidate: ReleaseCandidateRecord,
  reason: string,
  disposition: FailureDisposition,
  attribution: 'PRE_EXISTING_BASE' | 'CANDIDATE' | 'TRAIN' | undefined
): Promise<FailureDisposition | null> {
  const current = await releaseBusRepository.findCandidateById(
    candidate.id,
    {}
  );
  if (
    !current ||
    ['QUARANTINED', 'CANCELLED', 'SUPERSEDED'].includes(current.status) ||
    ![
      'STAGING_CLAIMED',
      'STAGING_VALIDATING',
      'PRODUCTION_CLAIMED',
      'PRODUCTION_VALIDATING'
    ].includes(current.status)
  )
    return null;
  await releaseBusRepository.updateCandidateLifecycle(
    current.id,
    current.row_version,
    failureLifecycle(train, reason, disposition, attribution),
    {}
  );
  await publishCandidateStatus(
    train,
    candidate,
    disposition === 'QUARANTINE' ? 'failure' : 'error',
    disposition === 'QUARANTINE'
      ? `Quarantined by release train ${train.id}`
      : `Release lane paused; candidate preserved (${train.id})`
  );
  return disposition;
}

async function failAndPauseTrain(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string,
  candidateDisposition: FailureDisposition = 'QUARANTINE',
  details: {
    readonly attribution?: 'PRE_EXISTING_BASE' | 'CANDIDATE' | 'TRAIN';
    readonly recommendedRecovery?: string;
  } = {}
): Promise<void> {
  const returnedCandidates: string[] = [];
  const quarantinedCandidates: string[] = [];
  for (const candidate of candidates) {
    const disposition = await releaseCandidateAfterTrainFailure(
      train,
      candidate,
      reason,
      candidateDisposition,
      details.attribution
    );
    if (disposition === 'QUARANTINE') quarantinedCandidates.push(candidate.id);
    if (disposition === 'REQUEUE') returnedCandidates.push(candidate.id);
  }
  await releaseBusRepository.setControl(
    train.target_lane,
    true,
    reason.slice(0, 1000),
    'release-bus-worker',
    {}
  );
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'FAILED', failureReason: reason, completedAt: Date.now() },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_FAILED_AND_LANE_PAUSED',
      payload: {
        reason,
        candidate_disposition: candidateDisposition,
        attribution: details.attribution ?? 'TRAIN',
        returned_candidates: returnedCandidates,
        quarantined_candidates: quarantinedCandidates,
        recommended_recovery:
          details.recommendedRecovery ??
          'Inspect deterministic workflow evidence, repair the attributed failure, then resume the lane explicitly.'
      }
    },
    {}
  );
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainFailure',
      Value: 1,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    },
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: train.target_lane }]
    }
  ]);
}

async function finishFailureIsolation(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<'WAIT' | 'FAILED' | 'RETRY'> {
  const operations = (await phaseOperations(train.id, 'isolate-')).sort(
    (a, b) => a.operation_type.localeCompare(b.operation_type)
  );
  const repositoryCount = repositories(candidates).length;
  if (operations.length !== candidates.length + repositoryCount * 2)
    return 'WAIT';
  const reconciled: ReleaseOperationRecord[] = [];
  for (const operation of operations)
    reconciled.push(await reconcile(operation));
  if (reconciled.some((operation) => workflowResult(operation) === 'WAIT'))
    return 'WAIT';
  const baselineFailure = reconciled.find(
    (operation) =>
      operation.operation_type.startsWith('isolate-baseline-') &&
      workflowResult(operation) === 'FAIL'
  );
  if (baselineFailure) {
    await failAndPauseTrain(
      train,
      candidates,
      operationFailureReason(
        `Existing ${baselineFailure.repository} base failed the isolation gate for SHA ${baselineFailure.expected_sha}. Candidates had not been tested in isolation. No candidate was blamed. ${train.target_lane} was paused. Repair and validate the existing base, deploy that isolated repair, then resume ${train.target_lane}.`,
        baselineFailure
      ),
      'REQUEUE',
      {
        attribution: 'PRE_EXISTING_BASE',
        recommendedRecovery:
          'Repair and validate the existing base, deploy that isolated repair, then resume the paused lane.'
      }
    );
    return 'FAILED';
  }
  const candidateOperations = reconciled.filter((operation) =>
    operation.operation_type.startsWith('isolate-candidate-')
  );
  const firstFailedIndex = candidateOperations.findIndex(
    (operation) => workflowResult(operation) === 'FAIL'
  );
  if (firstFailedIndex < 0) {
    const combinedFailure = reconciled.find(
      (operation) =>
        operation.operation_type.startsWith('isolate-combined-retry-') &&
        workflowResult(operation) === 'FAIL'
    );
    if (combinedFailure) {
      await failAndPauseTrain(
        train,
        candidates,
        'Each dependency-closed candidate subset passed, but the combined train failed again. No single candidate can be safely ejected.',
        'REQUEUE'
      );
      return 'FAILED';
    }
    for (const candidate of candidates) {
      const current = await releaseBusRepository.findCandidateById(
        candidate.id,
        {}
      );
      if (!current) continue;
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        {
          status: readyStatusForTrain(train),
          currentTrainId: null,
          holdReason: 'RETRY_AFTER_TRANSIENT_GATE_FAILURE'
        },
        {}
      );
    }
    await releaseBusRepository.updateTrain(
      train.id,
      {
        status: 'CANCELLED',
        failureReason:
          'The combined gate passed on its bounded retry; candidates were returned for a fresh train.',
        completedAt: Date.now()
      },
      {}
    );
    await releaseTrainLanes(train);
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        eventType: 'TRAIN_REQUEUED_AFTER_TRANSIENT_FAILURE',
        payload: { candidate_ids: candidates.map((candidate) => candidate.id) }
      },
      {}
    );
    return 'RETRY';
  }
  const offender = candidates[firstFailedIndex];
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    const isOffender = candidate.id === offender.id;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: isOffender ? 'QUARANTINED' : readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: isOffender ? 'FAILED_DEPENDENCY_CLOSED_ISOLATION' : null
      },
      {}
    );
  }
  const operation = candidateOperations[firstFailedIndex];
  const result = metadata(operation.result_metadata_json);
  await publishCandidateStatus(
    train,
    offender,
    'failure',
    `Failed dependency-closed isolation (${train.id})`
  );
  if (offender.pr_number) {
    try {
      await releaseBusGitHubApp.commentOnPullRequest(
        offender.repository,
        offender.pr_number,
        [
          `Release Bus quarantined this immutable candidate \`${offender.head_sha}\`.`,
          '',
          `It was the first failing dependency-closed subset while isolating train \`${train.id}\`. Other candidates were returned to the queue.`,
          result.url ? `Diagnostic run: ${String(result.url)}` : '',
          '',
          'Push a fix (which creates a new SHA) and mark that new SHA ready again.'
        ]
          .filter(Boolean)
          .join('\n')
      );
    } catch (error) {
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          candidateId: offender.id,
          eventType: 'CANDIDATE_QUARANTINE_COMMENT_FAILED',
          payload: {
            message: error instanceof Error ? error.message : 'comment failed'
          }
        },
        {}
      );
    }
  }
  await releaseBusRepository.updateTrain(
    train.id,
    {
      status: 'FAILED',
      failureReason: `Candidate ${offender.id} failed deterministic dependency-closed isolation`,
      completedAt: Date.now()
    },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      candidateId: offender.id,
      eventType: 'CANDIDATE_QUARANTINED_BY_ISOLATION',
      payload: {
        operation_key: operation.operation_key,
        diagnostic_url: result.url ?? null
      }
    },
    {}
  );
  return 'FAILED';
}

function readyStatusForTrain(
  train: ReleaseTrainRecord
): 'READY_FOR_STAGING' | 'READY_FOR_PRODUCTION' {
  return train.target_lane === 'STAGING'
    ? 'READY_FOR_STAGING'
    : 'READY_FOR_PRODUCTION';
}

async function pausedControlForTrain(
  train: ReleaseTrainRecord
): Promise<ReleaseBusControlRecord | null> {
  const controls = await releaseBusRepository.listControls({});
  return (
    controls.find(
      (control) =>
        Boolean(control.paused) &&
        (control.scope === 'ALL' || control.scope === train.target_lane)
    ) ?? null
  );
}

async function heartbeatOwnedTrainLanes(
  train: ReleaseTrainRecord
): Promise<void> {
  for (const laneName of [
    'global-orchestration',
    'global-staging',
    'global-production'
  ]) {
    await releaseBusRepository.heartbeatLane(
      laneName,
      train.id,
      RELEASE_BUS_LANE_TTL_MS,
      {}
    );
  }
}

async function advanceE2e(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  environment: 'staging' | 'prod'
): Promise<
  'PASS' | 'WAIT' | 'INFRASTRUCTURE_WAIT' | 'INFRASTRUCTURE_EXHAUSTED' | 'FAIL'
> {
  const type = `e2e-${environment}`;
  const existing = await phaseOperations(train.id, type);
  if (existing.length > 0)
    return pollPhase(
      train,
      candidates,
      type,
      retryableE2eInfrastructureFailure
    );
  const ref = e2eSourceRef(
    train.frontend_release_branch,
    environment,
    trainBranch(train)
  );
  const sha = await releaseBusGitHubApp.resolveRef('frontend', ref);
  await dispatchWorkflow({
    train,
    repository: 'frontend',
    operationType: type,
    workflow:
      environment === 'staging' ? 'staging-e2e.yml' : 'production-e2e.yml',
    ref: 'main',
    expectedSha: sha,
    environment,
    inputs:
      environment === 'staging'
        ? { pack: 'all', source_ref: ref }
        : { source_ref: ref }
  });
  return 'WAIT';
}

export function e2eSourceRef(
  frontendReleaseBranch: string | null,
  environment: 'staging' | 'prod',
  trainBranchRef: string
): string {
  if (environment === 'prod') return 'main';
  return frontendReleaseBranch ? trainBranchRef : '1a-staging';
}

async function recordSuccessfulOperationEvidence(
  train: ReleaseTrainRecord,
  prefixes: readonly string[]
): Promise<void> {
  const operations = await releaseBusRepository.listTrainOperations(
    train.id,
    {}
  );
  for (const operation of operations) {
    if (
      operation.status !== 'SUCCEEDED' ||
      !prefixes.some((prefix) => operation.operation_type.startsWith(prefix))
    )
      continue;
    const result = metadata(operation.result_metadata_json);
    await releaseBusRepository.addEvidence(
      {
        idempotencyKey: `operation:${operation.operation_key}`,
        trainId: train.id,
        revision: train.revision,
        evidenceType: 'OPERATION_SUCCEEDED',
        status: 'SUCCEEDED',
        sourceSha: operation.expected_sha,
        artifactDigest: operation.artifact_digest,
        evidenceUri: result.url ? String(result.url) : null,
        metadata: {
          operation_key: operation.operation_key,
          operation_type: operation.operation_type,
          repository: operation.repository,
          environment: operation.environment,
          service: operation.service
        }
      },
      {}
    );
  }
}

function operationProof(
  operation: ReleaseOperationRecord,
  artifactDigest: string | null = normalizeArtifactDigest(
    operation.artifact_digest
  )
): BaseEvidenceOperationProof {
  const result = metadata(operation.result_metadata_json);
  return {
    operation_key: operation.operation_key,
    operation_type: operation.operation_type,
    status: operation.status,
    expected_sha: operation.expected_sha ?? '',
    environment:
      operation.environment === 'staging' ? 'staging' : 'orchestration',
    run_id: operation.external_id ?? '',
    run_url: typeof result.url === 'string' ? result.url : '',
    artifact_digest: artifactDigest
  };
}

async function recordBaseEvidencePromotionDecision(
  train: ReleaseTrainRecord,
  finalSha: string,
  decision:
    | {
        readonly promoted: true;
        readonly artifactDigest: string;
        readonly evidenceUri: string;
        readonly metadata: Record<string, unknown>;
      }
    | { readonly promoted: false; readonly reason: string }
): Promise<void> {
  await releaseBusRepository.executeNativeQueriesInTransaction(
    async (connection) => {
      const context = { connection };
      const evidenceType = decision.promoted
        ? 'BASE_EVIDENCE_PROMOTED'
        : 'BASE_EVIDENCE_PROMOTION_REJECTED';
      const decisionKey = decision.promoted
        ? 'promoted'
        : `rejected:${decision.reason}`;
      const inserted = await releaseBusRepository.addEvidence(
        {
          idempotencyKey: `base-evidence-promotion:${train.id}:r${train.revision}:${finalSha}:${decisionKey}`,
          trainId: train.id,
          revision: train.revision,
          evidenceType,
          status: decision.promoted ? 'SUCCEEDED' : 'FAILED',
          sourceSha: finalSha,
          artifactDigest: decision.promoted ? decision.artifactDigest : null,
          evidenceUri: decision.promoted ? decision.evidenceUri : null,
          metadata: decision.promoted
            ? decision.metadata
            : {
                schema_version: 1,
                source_kind: 'staging_train_promotion_rejection',
                source_train_id: train.id,
                source_train_revision: train.revision,
                final_sha: finalSha,
                reason: decision.reason,
                created_at: Date.now()
              }
        },
        context
      );
      if (!inserted) return;
      const proof = decision.promoted ? metadata(decision.metadata.proof) : {};
      await releaseBusRepository.appendEvent(
        {
          trainId: train.id,
          eventType: decision.promoted
            ? 'BASE_EVIDENCE_PROMOTED'
            : 'BASE_EVIDENCE_PROMOTION_REJECTED',
          payload: decision.promoted
            ? {
                status: 'promoted',
                reason: 'fresh_preflight_deploy_e2e_gate_equivalent',
                source_train_id: train.id,
                source_train_revision: train.revision,
                final_sha: finalSha,
                proof_digest: decision.artifactDigest,
                preflight_run_id: metadata(proof.preflight).run_id ?? null,
                preflight_run_url: metadata(proof.preflight).run_url ?? null,
                preflight_artifact_digest:
                  metadata(proof.preflight).artifact_digest ?? null,
                deployment_run_id: metadata(proof.deployment).run_id ?? null,
                deployment_run_url: metadata(proof.deployment).run_url ?? null,
                deployment_artifact_digest:
                  metadata(proof.deployment).artifact_digest ?? null,
                e2e_run_id: metadata(proof.e2e).run_id ?? null,
                e2e_run_url: metadata(proof.e2e).run_url ?? null
              }
            : {
                status: 'rejected',
                reason: decision.reason,
                source_train_id: train.id,
                source_train_revision: train.revision,
                final_sha: finalSha,
                action: 'fresh_validation_next_train'
              }
        },
        context
      );
    }
  );
}

export async function promoteSuccessfulStagingBaseEvidence(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  if (
    train.target_lane !== 'STAGING' ||
    !candidates.some((candidate) => candidate.repository === 'frontend')
  )
    return;
  const operations = await releaseBusRepository.listTrainOperations(
    train.id,
    {}
  );
  const preflight = operations.find(
    (operation) => operation.operation_type === 'preflight-frontend'
  );
  const deployment = operations.find(
    (operation) => operation.operation_type === 'deploy-frontend-staging'
  );
  const e2e = operations.find(
    (operation) => operation.operation_type === 'e2e-staging'
  );
  const finalSha = preflight?.expected_sha ?? train.frontend_base_sha ?? '';
  let decision:
    | ReturnType<typeof buildPromotedBaseEvidence>
    | { readonly promoted: false; readonly reason: string };
  if (!preflight || !deployment || !e2e) {
    decision = { promoted: false, reason: 'missing_required_operation' };
  } else {
    const gateReport = metadata(
      metadata(preflight.result_metadata_json).gate_report
    );
    const summary = metadata(gateReport.summary);
    const contract =
      storedFrontendGateContract(preflight) ??
      (await frontendContractFromSummary(finalSha, summary));
    const summaryDigest = normalizeArtifactDigest(
      summary.summary_artifact_digest
    );
    let stagingRefSha: string | null = null;
    try {
      stagingRefSha = await releaseBusGitHubApp.resolveRef(
        'frontend',
        '1a-staging'
      );
    } catch {
      stagingRefSha = null;
    }
    if (!contract || !summaryDigest) {
      decision = { promoted: false, reason: 'missing_preflight_contract' };
    } else if (!stagingRefSha) {
      decision = { promoted: false, reason: 'staging_ref_lookup_error' };
    } else {
      const evidenceConfig = await resolveBaseCanaryEvidenceConfig();
      decision = buildPromotedBaseEvidence({
        sourceTrainId: train.id,
        sourceTrainRevision: train.revision,
        finalSha,
        stagingRefSha,
        contract,
        summary,
        stages: gateReport.stages,
        preflight: operationProof(preflight, summaryDigest),
        deployment: operationProof(deployment),
        e2e: operationProof(e2e),
        now: Date.now(),
        maxAgeMs: evidenceConfig.maxAgeHours * 60 * 60 * 1000
      });
    }
  }
  await recordBaseEvidencePromotionDecision(train, finalSha, decision);
}

async function validateStaging(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  await recordSuccessfulOperationEvidence(train, [
    'preflight-',
    'deploy-backend-staging-',
    'deploy-frontend-staging',
    'e2e-staging'
  ]);
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    const validating =
      train.target_lane === 'STAGING' ? 'STAGING_VALIDATING' : current.status;
    if (current.status === 'STAGING_CLAIMED') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        { status: validating },
        {}
      );
    }
    const latest = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      train.target_lane === 'STAGING' &&
      latest?.status === 'STAGING_VALIDATING'
    ) {
      await releaseBusRepository.updateCandidateLifecycle(
        latest.id,
        latest.row_version,
        { status: 'STAGING_VALIDATED', currentTrainId: null },
        {}
      );
    }
    const validated = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (
      train.target_lane === 'STAGING' &&
      validated?.status === 'STAGING_VALIDATED'
    ) {
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'CANDIDATE_STAGING_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
      await publishCandidateStatus(
        train,
        candidate,
        'success',
        `Staging validated by release train ${train.id}`
      );
    } else if (train.target_lane === 'PRODUCTION') {
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'PRODUCTION_TRAIN_STAGING_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
    }
  }
  await promoteSuccessfulStagingBaseEvidence(train, candidates);
}

async function notifyReleasedSourcePullRequest(
  train: ReleaseTrainRecord,
  candidate: ReleaseCandidateRecord
): Promise<void> {
  if (!candidate.pr_number) return;
  if (
    await releaseBusRepository.hasCandidateEvidence(
      candidate.id,
      'SOURCE_PR_RELEASE_NOTIFIED',
      {}
    )
  )
    return;
  try {
    const currentHead = await releaseBusGitHubApp.resolveRef(
      candidate.repository,
      candidate.branch_name
    );
    const unchanged = currentHead === candidate.head_sha;
    await releaseBusGitHubApp.commentOnPullRequest(
      candidate.repository,
      candidate.pr_number,
      unchanged
        ? `Release Bus deployed immutable SHA \`${candidate.head_sha}\` in production as train \`${train.id}\`. This source PR is now closed as released.`
        : `Release Bus deployed recorded SHA \`${candidate.head_sha}\` in production as train \`${train.id}\`. The branch has since moved to \`${currentHead}\`, so this PR remains open.`
    );
    if (unchanged)
      await releaseBusGitHubApp.closePullRequest(
        candidate.repository,
        candidate.pr_number
      );
    await releaseBusRepository.addEvidence(
      {
        trainId: train.id,
        revision: train.revision,
        candidateId: candidate.id,
        evidenceType: 'SOURCE_PR_RELEASE_NOTIFIED',
        status: 'SUCCEEDED',
        sourceSha: candidate.head_sha,
        metadata: { pull_number: candidate.pr_number, closed: unchanged }
      },
      {}
    );
  } catch (error) {
    await releaseBusRepository.appendEvent(
      {
        trainId: train.id,
        candidateId: candidate.id,
        eventType: 'SOURCE_PR_RELEASE_NOTIFICATION_FAILED',
        payload: {
          message:
            error instanceof Error ? error.message : 'notification failed'
        }
      },
      {}
    );
  }
}

function releasePullRequestBody(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  repository: ReleaseRepository
): string {
  const included = candidates
    .filter((candidate) => candidate.repository === repository)
    .map(
      (candidate) =>
        `- \`${candidate.branch_name}\` at \`${candidate.head_sha}\`${candidate.pr_number ? ` (source PR #${candidate.pr_number})` : ''}`
    )
    .join('\n');
  return [
    `Release train: \`${train.id}\``,
    `Revision: \`${train.revision}\``,
    `Target lane: \`${train.target_lane}\``,
    '',
    'Included immutable candidates:',
    included,
    '',
    'This PR is owned by the Release Bus. Its configured checks and exact-train staging evidence must pass before the GitHub App merges it.'
  ].join('\n');
}

async function createReleasePullRequests(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  const updates: {
    frontendPrNumber?: number | null;
    backendPrNumber?: number | null;
  } = {};
  for (const repository of repositories(candidates)) {
    const pull = await releaseBusGitHubApp.createReleasePullRequest(
      repository,
      trainBranch(train),
      `Release train ${train.id} revision ${train.revision}`,
      releasePullRequestBody(train, candidates, repository)
    );
    if (repository === 'frontend') updates.frontendPrNumber = pull.number;
    else updates.backendPrNumber = pull.number;
    await releaseBusRepository.addEvidence(
      {
        trainId: train.id,
        revision: train.revision,
        evidenceType: `RELEASE_PR_${repository.toUpperCase()}`,
        status: 'SUCCEEDED',
        evidenceUri: pull.html_url,
        metadata: { pull_number: pull.number }
      },
      {}
    );
  }
  await releaseBusRepository.updateTrain(train.id, updates, {});
}

async function mergeReleasePullRequest(
  train: ReleaseTrainRecord,
  repository: ReleaseRepository
): Promise<'PASS' | 'WAIT' | 'STALE' | 'FAIL'> {
  const pullNumber =
    repository === 'frontend'
      ? train.frontend_pr_number
      : train.backend_pr_number;
  const releaseBranch =
    repository === 'frontend'
      ? train.frontend_release_branch
      : train.backend_release_branch;
  if (!pullNumber || !releaseBranch) return 'PASS';
  const expectedHead = await releaseBusGitHubApp.resolveRef(
    repository,
    releaseBranch
  );
  const expectedBase =
    repository === 'frontend'
      ? train.frontend_base_sha
      : train.backend_base_sha;
  if (!expectedBase) return 'FAIL';
  const operationKey = buildReleaseOperationKey({
    trainId: train.id,
    revision: train.revision,
    operation: `merge-${repository}`,
    repository,
    expectedSha: expectedHead
  });
  const operation = await releaseBusRepository.getOrCreateOperation(
    {
      operation_key: operationKey,
      train_id: train.id,
      revision: train.revision,
      operation_type: `merge-${repository}`,
      repository,
      environment: 'prod',
      service: null,
      expected_sha: expectedHead,
      artifact_digest: null,
      attempt: 1,
      status: 'PENDING',
      external_id: String(pullNumber),
      request_metadata_json: { pull_number: pullNumber },
      result_metadata_json: null,
      started_at: null,
      completed_at: null
    },
    {}
  );
  if (operation.status === 'SUCCEEDED') return 'PASS';
  if (operation.status === 'FAILED') return 'FAIL';
  if (operation.status === 'AMBIGUOUS') {
    const merged = await releaseBusGitHubApp.refContainsCommit(
      repository,
      'main',
      expectedHead
    );
    if (!merged) {
      const currentMain = await releaseBusGitHubApp.resolveRef(
        repository,
        'main'
      );
      if (currentMain !== expectedBase) return 'STALE';
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'PENDING' },
        {}
      );
    } else {
      await releaseBusRepository.updateOperation(
        operationKey,
        { status: 'SUCCEEDED', completedAt: Date.now() },
        {}
      );
      return 'PASS';
    }
  }
  try {
    await releaseBusGitHubApp.updateRef(
      repository,
      'main',
      expectedBase,
      expectedHead
    );
    await releaseBusRepository.updateOperation(
      operationKey,
      {
        status: 'SUCCEEDED',
        resultMetadata: {
          merge_sha: expectedHead,
          strategy: 'strict-fast-forward',
          pull_number: pullNumber
        },
        completedAt: Date.now()
      },
      {}
    );
    return 'PASS';
  } catch (error) {
    await releaseBusRepository.updateOperation(
      operationKey,
      {
        status: 'AMBIGUOUS',
        resultMetadata: {
          message: error instanceof Error ? error.message : 'merge failed'
        }
      },
      {}
    );
    return 'WAIT';
  }
}

async function requeueMovedTarget(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[],
  reason: string
): Promise<void> {
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    if (!['STAGING_CLAIMED', 'PRODUCTION_CLAIMED'].includes(current.status))
      continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status: readyStatusForTrain(train),
        currentTrainId: null,
        holdReason: 'TARGET_MOVED_REQUEUE'
      },
      {}
    );
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'CANCELLED', failureReason: reason, completedAt: Date.now() },
    {}
  );
  await releaseTrainLanes(train);
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'TRAIN_REQUEUED_AFTER_TARGET_MOVED',
      payload: { reason }
    },
    {}
  );
}

async function advanceStagingSync(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<'PASS' | 'WAIT' | 'FAIL'> {
  for (const repository of repositories(candidates)) {
    const type = `sync-staging-${repository}`;
    const existing = (await phaseOperations(train.id, type))[0];
    if (existing) {
      const result = workflowResult(await reconcile(existing));
      if (result !== 'PASS') return result;
      continue;
    }
    const mainSha = await releaseBusGitHubApp.resolveRef(repository, 'main');
    await dispatchWorkflow({
      train,
      repository,
      operationType: type,
      workflow: 'release-bus-sync-staging.yml',
      ref: 'main',
      expectedSha: mainSha,
      environment: 'staging',
      inputs: { main_sha: mainSha }
    });
    return 'WAIT';
  }
  return 'PASS';
}

async function finalizeProduction(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  await recordSuccessfulOperationEvidence(train, [
    'merge-',
    'deploy-backend-prod-',
    'deploy-frontend-prod',
    'e2e-prod',
    'sync-staging-'
  ]);
  for (const candidate of candidates) {
    let current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    if (current.status === 'PRODUCTION_CLAIMED') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        { status: 'PRODUCTION_VALIDATING' },
        {}
      );
      current = await releaseBusRepository.findCandidateById(candidate.id, {});
    }
    if (current?.status === 'PRODUCTION_VALIDATING') {
      await releaseBusRepository.updateCandidateLifecycle(
        current.id,
        current.row_version,
        {
          status: 'PRODUCTION_VALIDATED',
          currentTrainId: null,
          releasedAt: Date.now()
        },
        {}
      );
    }
    current = await releaseBusRepository.findCandidateById(candidate.id, {});
    if (current?.status === 'PRODUCTION_VALIDATED')
      await releaseBusRepository.addEvidence(
        {
          trainId: train.id,
          revision: train.revision,
          candidateId: candidate.id,
          evidenceType: 'CANDIDATE_PRODUCTION_VALIDATED',
          status: 'SUCCEEDED',
          sourceSha: candidate.head_sha
        },
        {}
      );
    if (current?.status === 'PRODUCTION_VALIDATED')
      await publishCandidateStatus(
        train,
        candidate,
        'success',
        `Production deployed by release train ${train.id}`
      );
    await notifyReleasedSourcePullRequest(train, candidate);
  }
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  for (const laneName of [
    'global-production',
    'global-staging',
    'global-orchestration'
  ]) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token) {
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
    }
  }
  await releaseBusRepository.appendEvent(
    {
      trainId: train.id,
      eventType: 'PRODUCTION_TRAIN_COMPLETED',
      payload: { candidate_ids: candidates.map((candidate) => candidate.id) }
    },
    {}
  );
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: 'PRODUCTION' }]
    }
  ]);
}

export async function finishStaging(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  let updatedRepositories = 0;
  for (const repository of repositories(candidates)) {
    const base =
      repository === 'frontend'
        ? train.frontend_base_sha
        : train.backend_base_sha;
    if (!base) continue;
    const finalSha = await releaseBusGitHubApp.resolveRef(
      repository,
      trainBranch(train)
    );
    const currentStagingSha = await releaseBusGitHubApp.resolveRef(
      repository,
      '1a-staging'
    );
    const refUpdateIntentType = `STAGING_REF_UPDATE_INTENT_${repository.toUpperCase()}`;
    if (currentStagingSha === finalSha) {
      const intended = await releaseBusRepository.hasTrainEvidence(
        train.id,
        train.revision,
        refUpdateIntentType,
        finalSha,
        {}
      );
      if (!intended)
        throw new Error(
          `1a-staging moved to train final SHA ${finalSha} without a recorded ${repository} Release Bus update intent`
        );
      updatedRepositories += 1;
      continue;
    }
    if (currentStagingSha !== base) {
      const message = `1a-staging moved from expected ${base} to ${currentStagingSha}`;
      if (updatedRepositories > 0)
        throw new TerminalReleaseTrainError(
          `PARTIAL_STAGING_REF_UPDATE: ${message}`
        );
      throw new Error(message);
    }
    await releaseBusRepository.addEvidence(
      {
        idempotencyKey: `staging-ref-update-intent:${train.id}:r${train.revision}:${repository}:${finalSha}`,
        trainId: train.id,
        revision: train.revision,
        evidenceType: refUpdateIntentType,
        status: 'SUCCEEDED',
        sourceSha: finalSha,
        metadata: {
          repository,
          expected_old_sha: base,
          intended_final_sha: finalSha
        }
      },
      {}
    );
    try {
      await releaseBusGitHubApp.updateRef(
        repository,
        '1a-staging',
        base,
        finalSha
      );
      updatedRepositories += 1;
    } catch (error) {
      const reconciledStagingSha = await releaseBusGitHubApp.resolveRef(
        repository,
        '1a-staging'
      );
      if (reconciledStagingSha === finalSha) {
        updatedRepositories += 1;
        continue;
      }
      if (updatedRepositories > 0)
        throw new TerminalReleaseTrainError(
          `PARTIAL_STAGING_REF_UPDATE: ${error instanceof Error ? error.message : 'target moved'}`
        );
      throw error;
    }
  }
  await validateStaging(train, candidates);
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  for (const laneName of ['global-staging', 'global-orchestration']) {
    const lane = await releaseBusRepository.getLane(laneName, {});
    if (lane?.train_id === train.id && lane.lease_token)
      await releaseBusRepository.releaseLane(laneName, lane.lease_token, {});
  }
  await publishReleaseBusMetrics([
    {
      MetricName: 'TrainDurationSeconds',
      Unit: 'Seconds',
      Value: (Date.now() - Number(train.started_at)) / 1000,
      Dimensions: [{ Name: 'Lane', Value: 'STAGING' }]
    }
  ]);
}

async function shadowComplete(
  train: ReleaseTrainRecord,
  candidates: readonly ReleaseCandidateRecord[]
): Promise<void> {
  for (const candidate of candidates) {
    const current = await releaseBusRepository.findCandidateById(
      candidate.id,
      {}
    );
    if (!current) continue;
    await releaseBusRepository.updateCandidateLifecycle(
      current.id,
      current.row_version,
      {
        status:
          train.target_lane === 'STAGING'
            ? 'READY_FOR_STAGING'
            : 'READY_FOR_PRODUCTION',
        currentTrainId: null
      },
      {}
    );
    await releaseBusRepository.addEvidence(
      {
        idempotencyKey: `shadow:${train.target_lane}:${candidate.id}:v${candidate.metadata_version}`,
        trainId: train.id,
        revision: train.revision,
        candidateId: candidate.id,
        evidenceType: `CANDIDATE_SHADOW_EVALUATED_${train.target_lane}`,
        status: 'SUCCEEDED',
        sourceSha: candidate.head_sha,
        metadata: { metadata_version: candidate.metadata_version }
      },
      {}
    );
  }
  await releaseBusRepository.addEvidence(
    {
      trainId: train.id,
      revision: train.revision,
      evidenceType: 'SHADOW_DECISION',
      status: 'SUCCEEDED',
      metadata: { candidate_ids: candidates.map((candidate) => candidate.id) }
    },
    {}
  );
  await releaseBusRepository.updateTrain(
    train.id,
    { status: 'COMPLETED', completedAt: Date.now() },
    {}
  );
  const lane = await releaseBusRepository.getLane('global-orchestration', {});
  if (lane?.train_id === train.id && lane.lease_token)
    await releaseBusRepository.releaseLane(
      'global-orchestration',
      lane.lease_token,
      {}
    );
}

export async function advanceReleaseTrain(
  trainId: string
): Promise<WorkerResult> {
  const { train, candidates } = await loadTrain(trainId);
  try {
    if (['COMPLETED', 'ROLLED_BACK', 'CANCELLED'].includes(train.status))
      return { decision: 'COMPLETE', train_id: train.id, status: train.status };
    if (train.status === 'FAILED')
      return {
        decision: 'FAILED',
        train_id: train.id,
        status: train.status,
        message: train.failure_reason ?? undefined
      };
    await publishCandidatePhaseStatuses(train, candidates);
    const mode = getReleaseBusMode();
    if (mode === 'OFF')
      return waitFor(train, train.status, {
        code: 'ROLLOUT_MODE_OFF',
        summary: 'Waiting because the Release Bus rollout mode is OFF.'
      });
    if (mode === 'SHADOW' && train.status === 'FROZEN') {
      await shadowComplete(train, candidates);
      return { decision: 'COMPLETE', train_id: train.id, status: 'COMPLETED' };
    }
    if (
      mode === 'SHADOW' ||
      (train.target_lane === 'PRODUCTION' && mode !== 'PRODUCTION')
    )
      return waitFor(train, train.status, {
        code: mode === 'SHADOW' ? 'SHADOW_MODE' : 'PRODUCTION_MODE_DISABLED',
        summary:
          mode === 'SHADOW'
            ? 'Waiting because SHADOW mode records decisions without executing the train.'
            : 'Waiting because production train execution is not enabled.'
      });
    if (!(await ensureLane('global-orchestration', train))) {
      return waitFor(
        train,
        train.status,
        leaseWaitReason(
          'global-orchestration',
          await releaseBusRepository.getLane('global-orchestration', {})
        )
      );
    }
    const pausedControl = await pausedControlForTrain(train);
    if (pausedControl) {
      await heartbeatOwnedTrainLanes(train);
      return waitFor(train, train.status, {
        code: 'CONTROL_PAUSED',
        summary: `${pausedControl.scope} is paused: ${pausedControl.reason ?? 'No reason recorded'}`,
        control: {
          scope: pausedControl.scope,
          reason: pausedControl.reason,
          actor: pausedControl.github_actor,
          updated_at: Number(pausedControl.updated_at)
        }
      });
    }
    if (['FROZEN', 'BASE_CANARY_RUNNING'].includes(train.status)) {
      const baseCanary = await advanceFrontendBaseCanary(train, candidates);
      if (baseCanary === 'FAIL')
        return {
          decision: 'FAILED',
          train_id: train.id,
          status: 'FAILED',
          message:
            'Frontend base canary failed; candidates were returned to the queue'
        };
      if (baseCanary === 'INFRASTRUCTURE_WAIT')
        return waitFor(train, 'BASE_CANARY_RUNNING', {
          code: 'INFRASTRUCTURE_RETRY_BACKOFF',
          summary:
            'Frontend base validation hit transient CI infrastructure. The same immutable canary will retry automatically; candidates remain attached and the lane is not paused.'
        });
      if (baseCanary === 'WAIT')
        return waitFor(train, 'BASE_CANARY_RUNNING', {
          code: 'GITHUB_WORKFLOW_RUNNING',
          summary: `Frontend base canary running for staging SHA ${train.frontend_base_sha ?? 'unknown'}. Candidates have not been tested yet.`
        });
      await beginComposition(train, candidates);
      return waitFor(train, 'COMPOSING');
    }
    if (train.status === 'COMPOSING') {
      const result = await pollPhase(train, candidates, 'compose-');
      const infrastructureResult = await infrastructurePhaseResult(
        train,
        result,
        'composition'
      );
      if (infrastructureResult) return infrastructureResult;
      if (result === 'FAIL') {
        await beginFailureIsolation(
          train,
          candidates,
          'Release branch composition failed after bounded conflict resolution'
        );
        return waitFor(train, 'ISOLATING_FAILURE');
      }
      if (result === 'WAIT') return waitFor(train, train.status);
      // A successful compose workflow may intentionally publish only its
      // conflict-free prefix when Codex is disabled. Never dispatch preflight
      // until every frozen candidate SHA is proven reachable from its branch.
      const offender = await finishIncompleteComposition(train, candidates);
      if (offender)
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED',
          message: `Candidate ${offender.id} requires merge-conflict resolution; other candidates were returned to the queue`
        };
      await beginPreflight(train, candidates);
      return waitFor(train, 'PREFLIGHTING');
    }
    if (train.status === 'PREFLIGHTING') {
      const result = await pollPhase(train, candidates, 'preflight-');
      const infrastructureResult = await infrastructurePhaseResult(
        train,
        result,
        'preflight'
      );
      if (infrastructureResult) return infrastructureResult;
      if (result === 'FAIL') {
        await beginFailureIsolation(
          train,
          candidates,
          'Release preflight failed'
        );
        return waitFor(train, 'ISOLATING_FAILURE');
      }
      if (result === 'WAIT') return waitFor(train, train.status);
      const busyRepository = await externalDeploymentLaneBusy('staging');
      if (busyRepository)
        return waitFor(train, train.status, {
          code: 'EXTERNAL_DEPLOYMENT_ACTIVE',
          summary: `Waiting for an existing ${busyRepository} staging deployment to finish.`,
          external_operation: {
            repository: busyRepository,
            environment: 'staging'
          }
        });
      if (!(await ensureLane('global-staging', train)))
        return waitFor(
          train,
          train.status,
          leaseWaitReason(
            'global-staging',
            await releaseBusRepository.getLane('global-staging', {})
          )
        );
      return continueAtPhase(train, 'DEPLOYING_BACKEND');
    }
    if (train.status === 'ISOLATING_FAILURE') {
      const result = await finishFailureIsolation(train, candidates);
      if (result === 'RETRY')
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED',
          message: 'Transient gate failure; candidates returned to the queue'
        };
      if (result === 'WAIT') return waitFor(train, train.status);
      return {
        decision: 'FAILED',
        train_id: train.id,
        status: 'FAILED',
        message: train.failure_reason ?? undefined
      };
    }
    if (train.status === 'STAGING') {
      return continueAtPhase(train, 'DEPLOYING_BACKEND');
    }
    if (train.status === 'DEPLOYING_BACKEND') {
      return advanceBackendDeploymentPhase(
        train,
        candidates,
        'staging',
        'DEPLOYING_FRONTEND'
      );
    }
    if (train.status === 'DEPLOYING_FRONTEND') {
      return advanceGuardedPhase({
        train,
        lane: 'global-staging',
        run: () => advanceFrontendDeploy(train, 'staging'),
        failureMessage: 'Frontend staging deployment failed',
        nextStatus: 'E2E_RUNNING'
      });
    }
    if (train.status === 'E2E_RUNNING') {
      const laneWait = await waitForRequiredLane(train, 'global-staging');
      if (laneWait) return laneWait;
      const result = await advanceE2e(train, candidates, 'staging');
      const infrastructure = await infrastructurePhaseResult(
        train,
        result,
        'staging E2E'
      );
      if (infrastructure) return infrastructure;
      if (result === 'FAIL')
        throw new TerminalReleaseTrainError('Staging E2E failed');
      if (result === 'WAIT') return waitFor(train, train.status);
      return continueAtPhase(train, 'VALIDATING_STAGING');
    }
    if (train.status === 'VALIDATING_STAGING') {
      const stagingLaneWait = await waitForRequiredLane(
        train,
        'global-staging'
      );
      if (stagingLaneWait) return stagingLaneWait;
      if (train.target_lane === 'STAGING') {
        try {
          await finishStaging(train, candidates);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Staging target moved';
          if (message.startsWith('PARTIAL_STAGING_REF_UPDATE')) throw error;
          if (!message.includes('moved from expected')) throw error;
          await requeueMovedTarget(train, candidates, message);
          return {
            decision: 'COMPLETE',
            train_id: train.id,
            status: 'CANCELLED',
            message
          };
        }
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'COMPLETED'
        };
      }
      await validateStaging(train, candidates);
      await createReleasePullRequests(train, candidates);
      const busyRepository = await externalDeploymentLaneBusy('prod');
      if (busyRepository)
        return waitFor(train, train.status, {
          code: 'EXTERNAL_DEPLOYMENT_ACTIVE',
          summary: `Waiting for an existing ${busyRepository} production deployment to finish.`,
          external_operation: {
            repository: busyRepository,
            environment: 'prod'
          }
        });
      const productionLaneWait = await waitForRequiredLane(
        train,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      return continueAtPhase(train, 'MERGING_PRODUCTION');
    }
    if (train.status === 'MERGING_PRODUCTION') {
      const productionLaneWait = await waitForRequiredLane(
        train,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      const latest = await reloadTrain(train.id);
      const backendMerge = await mergeReleasePullRequest(latest, 'backend');
      if (backendMerge === 'STALE') {
        await requeueMovedTarget(
          train,
          candidates,
          'Backend main moved before the release train could fast-forward it'
        );
        return {
          decision: 'COMPLETE',
          train_id: train.id,
          status: 'CANCELLED'
        };
      }
      if (backendMerge === 'FAIL') {
        throw new TerminalReleaseTrainError(
          'Backend production release PR merge failed'
        );
      }
      if (backendMerge === 'WAIT') return waitFor(train, train.status);
      return continueAtPhase(train, 'DEPLOYING_BACKEND_PRODUCTION');
    }
    if (train.status === 'DEPLOYING_PRODUCTION') {
      return continueAtPhase(train, 'DEPLOYING_BACKEND_PRODUCTION');
    }
    if (train.status === 'DEPLOYING_BACKEND_PRODUCTION') {
      return advanceBackendDeploymentPhase(
        train,
        candidates,
        'prod',
        'MERGING_FRONTEND_PRODUCTION'
      );
    }
    if (train.status === 'MERGING_FRONTEND_PRODUCTION') {
      const productionLaneWait = await waitForRequiredLane(
        train,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      const latest = await reloadTrain(train.id);
      const frontendMerge = await mergeReleasePullRequest(latest, 'frontend');
      if (frontendMerge === 'STALE') {
        if (!latest.backend_release_branch) {
          await requeueMovedTarget(
            train,
            candidates,
            'Frontend main moved before the release train could fast-forward it'
          );
          return {
            decision: 'COMPLETE',
            train_id: train.id,
            status: 'CANCELLED'
          };
        }
        throw new TerminalReleaseTrainError(
          'Frontend main moved after backend production deployment; operator intervention is required'
        );
      }
      if (frontendMerge === 'FAIL') {
        throw new TerminalReleaseTrainError(
          'Frontend production release PR merge failed'
        );
      }
      if (frontendMerge === 'WAIT') return waitFor(train, train.status);
      return continueAtPhase(train, 'DEPLOYING_FRONTEND_PRODUCTION');
    }
    if (train.status === 'DEPLOYING_FRONTEND_PRODUCTION') {
      const latest = await reloadTrain(train.id);
      return advanceGuardedPhase({
        train: latest,
        lane: 'global-production',
        run: () => advanceFrontendDeploy(latest, 'prod'),
        failureMessage: 'Frontend production deployment failed',
        nextStatus: 'PRODUCTION_E2E_RUNNING'
      });
    }
    if (train.status === 'PRODUCTION_E2E_RUNNING') {
      const latest = await reloadTrain(train.id);
      const productionLaneWait = await waitForRequiredLane(
        latest,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      const result = await advanceE2e(latest, candidates, 'prod');
      const infrastructure = await infrastructurePhaseResult(
        latest,
        result,
        'production E2E'
      );
      if (infrastructure) return infrastructure;
      if (result === 'FAIL')
        throw new TerminalReleaseTrainError('Production E2E failed');
      if (result === 'WAIT') return waitFor(latest, latest.status);
      return continueAtPhase(latest, 'VALIDATING_PRODUCTION');
    }
    if (train.status === 'VALIDATING_PRODUCTION') {
      const productionLaneWait = await waitForRequiredLane(
        train,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      return continueAtPhase(train, 'SYNCING_STAGING');
    }
    if (train.status === 'SYNCING_STAGING') {
      const productionLaneWait = await waitForRequiredLane(
        train,
        'global-production'
      );
      if (productionLaneWait) return productionLaneWait;
      const sync = await advanceStagingSync(train, candidates);
      if (sync === 'FAIL')
        throw new TerminalReleaseTrainError(
          'Failed to sync main back into staging'
        );
      if (sync === 'WAIT') return waitFor(train, train.status);
      await finalizeProduction(train, candidates);
      return { decision: 'COMPLETE', train_id: train.id, status: 'COMPLETED' };
    }
    throw new TerminalReleaseTrainError(
      `Unsupported release train status ${train.status}`
    );
  } catch (error) {
    if (error instanceof ConcurrentReleaseTrainPhaseError) {
      const latest = await reloadTrain(train.id);
      if (['COMPLETED', 'ROLLED_BACK', 'CANCELLED'].includes(latest.status))
        return {
          decision: 'COMPLETE',
          train_id: latest.id,
          status: latest.status
        };
      if (latest.status === 'FAILED')
        return {
          decision: 'FAILED',
          train_id: latest.id,
          status: latest.status,
          message: latest.failure_reason ?? undefined
        };
      return waitFor(latest, latest.status, {
        code: 'PHASE_TRANSITION',
        summary: `Train phase changed concurrently to ${latest.status}; waiting for the next guarded worker tick.`
      });
    }
    if (!isTerminalReleaseTrainError(error)) throw error;
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown release-bus worker failure';
    await failAndPauseTrain(train, candidates, message);
    return {
      decision: 'FAILED',
      train_id: train.id,
      status: 'FAILED',
      message
    };
  }
}
