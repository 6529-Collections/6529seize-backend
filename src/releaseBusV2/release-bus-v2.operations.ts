import { isDeepStrictEqual } from 'node:util';
import { isReleaseBusGitHubAppActor } from '@/releaseBusV2/release-bus-v2.constants';
import {
  releaseBusGitHubApp,
  ReleaseBusGitHubInfrastructureError
} from '@/releaseBusV2/release-bus-v2.github-app';
import {
  releaseBusV2Repository,
  type ReleaseBusV2Repository as ReleaseBusV2RepositoryClass
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2FailureClass,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2Repository
} from '@/releaseBusV2/release-bus-v2.types';

export type ReleaseBusV2WorkflowSpec = {
  readonly idempotencyKey: string;
  readonly trainId: string;
  readonly operationType: string;
  readonly repository: ReleaseBusV2Repository;
  readonly workflow: string;
  readonly ref: string;
  readonly environment: string;
  readonly service: string | null;
  readonly expectedSha: string;
  readonly artifactDigest: string | null;
  readonly inputs: Readonly<Record<string, string>>;
  readonly maxAttempts?: number;
  readonly betaInfrastructureFailureInjection?: {
    readonly candidateId: string;
    readonly testId: string;
  };
};

export type ReleaseBusV2Authorization = {
  readonly train_id: string;
  readonly operation_key: string;
  readonly workflow_run_id: string;
  readonly artifact_run_id: string | null;
  readonly repository: ReleaseBusV2Repository;
  readonly environment: string;
  readonly service: string | null;
  readonly expected_sha: string;
  readonly artifact_digest: string | null;
  readonly source_ref?: string | null;
  readonly reuse_artifact_run_id?: string | null;
  readonly reuse_artifact_name?: string | null;
  readonly reuse_artifact_digest?: string | null;
  readonly candidate_evidence_mode:
    | 'legacy-whole-train'
    | 'strict-single'
    | 'strict-aggregate'
    | null;
  readonly aggregate_candidate_evidence_digest: string | null;
};

export type ReleaseBusV2Progress = {
  readonly train_id: string;
  readonly operation_key: string;
  readonly workflow_run_id: string;
  readonly phase: string;
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly failure_class?: string | null;
  readonly failure_phase?: string | null;
  readonly retryable?: boolean;
  readonly summary?: unknown;
  readonly backend_evidence?: unknown;
  readonly stages?: unknown;
  readonly jest?: unknown;
  readonly [key: string]: unknown;
};

type StoredWorkflowRequest = {
  readonly workflow?: unknown;
  readonly ref?: unknown;
  readonly workflow_control_sha?: unknown;
  readonly inputs?: unknown;
  readonly beta_infrastructure_failure_injection?: unknown;
};

type ExactStoredWorkflowRequest = {
  readonly workflow: string;
  readonly ref: string;
  readonly workflow_control_sha?: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly beta_infrastructure_failure_injection?: unknown;
};

function classifyFailure(
  value: string | null | undefined
): ReleaseBusV2FailureClass {
  const normalized = value?.toUpperCase() ?? '';
  if (normalized.includes('INFRASTRUCTURE') || normalized.includes('TRANSIENT'))
    return 'INFRASTRUCTURE';
  if (
    normalized.includes('CONTROL') ||
    normalized.includes('PROTOCOL') ||
    normalized.includes('CONFIG')
  )
    return 'CONTROL_PLANE';
  if (normalized.includes('DEPLOY')) return 'DEPLOYMENT';
  if (normalized.includes('E2E')) return 'E2E';
  if (normalized.includes('CANDIDATE')) return 'CANDIDATE';
  return 'INTERACTION';
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

const DISPATCH_DISCOVERY_GRACE_MS = 30_000;
const LEGACY_WORKFLOW_BLOB_ALLOWLIST_EXPIRES_AT = Date.UTC(
  2026,
  7,
  31,
  23,
  59,
  59
);
const LEGACY_OPERATION_WORKFLOW_BLOBS: Readonly<
  Record<ReleaseBusV2Repository, Readonly<Record<string, readonly string[]>>>
> = {
  backend: {
    'release-bus-v2-compose.yml': ['addb25bb6d8c59a7e61bd996e481c4934902012f'],
    'release-bus-v2-preflight.yml': [
      'f3cbf1ec1f0ca1284dd84289adc6e801b12ef329',
      'e1f3508d917cb20cc5211c7ed7cdceaf87ff2116'
    ],
    'deploy.yml': [
      '93069abfac648a9906fc8bac9ed2c72df6b93f8f',
      '2bc91d47fe41ee61c10ef6b6eb4b63e4f6fe6c6c'
    ]
  },
  frontend: {
    'release-bus-v2-compose.yml': ['e630365d0a7b5305765cdb0683efe55906520373'],
    'release-bus-v2-preflight.yml': [
      'c4d7c0a7a2e9d10ddb82eec7feff7d8523e25b9f',
      'c2f54b2bc7558f48830bc9c3ada7b6725b80ebdb'
    ],
    'release-bus-deploy-staging.yml': [
      'ed7355c9136b9edf12d2479b1ec1a3d9c0c76b21',
      '7313fb46dc997397b4d10d0a9d05b2f123d82772'
    ],
    'staging-e2e.yml': [
      '183912f5daf70a502773bb41cebe73613e2b46e2',
      '7a8960bbbe2369c27cd9e798a1257e01815bd566'
    ],
    'release-bus-deploy-production.yml': [
      'c9ff9ef27ea65c265921294ef4724a54b913e064',
      '52044731c96e9629f56ee1c9c94e481a0607e26f'
    ],
    'production-e2e.yml': [
      'cd95ff1b43692864f1b29e574e37f20fcb46f6b4',
      '9e791c077285b2708df0e985bde753ec02cc9cd0'
    ]
  }
};

function isAllowedLegacyOperationWorkflowBlob(
  repository: ReleaseBusV2Repository,
  workflow: string,
  blobSha: string
): boolean {
  return (
    Date.now() <= LEGACY_WORKFLOW_BLOB_ALLOWLIST_EXPIRES_AT &&
    (LEGACY_OPERATION_WORKFLOW_BLOBS[repository][workflow] ?? []).includes(
      blobSha
    )
  );
}

function isGitHubInfrastructureError(error: unknown): error is Error {
  const infrastructureType: unknown = ReleaseBusGitHubInfrastructureError;
  const candidate = error as {
    readonly code?: unknown;
    readonly headers?: unknown;
    readonly name?: unknown;
    readonly retryAfter?: unknown;
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = Number(candidate?.status ?? candidate?.statusCode ?? 0);
  const headers = candidate?.headers as
    | { readonly get?: (name: string) => string | null }
    | Readonly<Record<string, unknown>>
    | undefined;
  const headerValue = (name: string): unknown => {
    if (typeof headers?.get === 'function') return headers.get(name);
    if (!headers || typeof headers !== 'object') return undefined;
    const record = headers as Readonly<Record<string, unknown>>;
    return (
      record[name] ??
      Object.entries(record).find(
        ([key]) => key.toLowerCase() === name.toLowerCase()
      )?.[1]
    );
  };
  const retrySignaled =
    candidate?.retryAfter !== undefined ||
    headerValue('retry-after') !== undefined ||
    headerValue('x-ratelimit-remaining') === '0';
  return (
    error instanceof Error &&
    ((typeof infrastructureType === 'function' &&
      error instanceof infrastructureType) ||
      error.name === 'ReleaseBusGitHubInfrastructureError' ||
      error.constructor.name === 'ReleaseBusGitHubInfrastructureError' ||
      ['AbortError', 'FetchError', 'TimeoutError'].includes(error.name) ||
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'ETIMEDOUT'
      ].includes(code) ||
      status === 408 ||
      status === 429 ||
      (status === 403 && retrySignaled) ||
      status >= 500)
  );
}

function attemptOperationKey(idempotencyKey: string, attempt: number): string {
  return `${idempotencyKey}:a${attempt}`;
}

function parseAttemptOperationKey(value: string): {
  readonly idempotencyKey: string;
  readonly attempt: number;
} {
  const match = /^(.*):a([1-9]\d{0,8})$/.exec(value);
  if (!match?.[1]) throw new Error('Invalid Release Bus v2 attempt key');
  return { idempotencyKey: match[1], attempt: Number(match[2]) };
}

function parseStoredJson<T>(value: unknown): T | null {
  if (value === null) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
}

function progressArtifactDigest(progress: ReleaseBusV2Progress): string | null {
  if (!progress.summary || typeof progress.summary !== 'object') return null;
  const digest = (progress.summary as { artifact_digest?: unknown })
    .artifact_digest;
  return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
    ? digest
    : null;
}

function exactStringRecord(
  value: unknown
): Readonly<Record<string, string>> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    return null;
  return value as Readonly<Record<string, string>>;
}

function exactStoredWorkflowRequest(
  value: unknown
): ExactStoredWorkflowRequest | null {
  const request = parseStoredJson<StoredWorkflowRequest>(value);
  const inputs =
    request?.inputs === undefined ? {} : exactStringRecord(request.inputs);
  if (
    typeof request?.workflow !== 'string' ||
    typeof request.ref !== 'string' ||
    !inputs
  )
    return null;
  if (
    request.workflow_control_sha !== undefined &&
    (typeof request.workflow_control_sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(request.workflow_control_sha))
  )
    return null;
  return {
    workflow: request.workflow,
    ref: request.ref,
    ...(request.workflow_control_sha
      ? { workflow_control_sha: request.workflow_control_sha }
      : {}),
    inputs,
    ...(Object.prototype.hasOwnProperty.call(
      request,
      'beta_infrastructure_failure_injection'
    )
      ? {
          beta_infrastructure_failure_injection:
            request.beta_infrastructure_failure_injection
        }
      : {})
  };
}

const LEGACY_ADDITIVE_WORKFLOW_INPUTS = new Set([
  'artifact_contract_version',
  'artifact_environment'
]);

const LEGACY_PREFLIGHT_MIGRATED_INPUTS = new Set([
  'aggregate_candidate_evidence_digest',
  'candidate_evidence_mode',
  'deploy_layers',
  'reuse_artifact_digest',
  'reuse_artifact_name',
  'reuse_artifact_run_id',
  'source_ref'
]);

function isCompatibleExistingLegacyRequest(
  request: ExactStoredWorkflowRequest,
  spec: ReleaseBusV2WorkflowSpec
): boolean {
  if (
    request.workflow_control_sha ||
    request.workflow !== spec.workflow ||
    request.ref !== spec.ref ||
    !isDeepStrictEqual(
      request.beta_infrastructure_failure_injection ?? null,
      spec.betaInfrastructureFailureInjection ?? null
    )
  )
    return false;
  const migratedInputs =
    spec.workflow === 'release-bus-v2-preflight.yml'
      ? new Set([
          ...Array.from(LEGACY_ADDITIVE_WORKFLOW_INPUTS),
          ...Array.from(LEGACY_PREFLIGHT_MIGRATED_INPUTS)
        ])
      : LEGACY_ADDITIVE_WORKFLOW_INPUTS;
  for (const [key, value] of Object.entries(request.inputs)) {
    if (
      spec.workflow === 'release-bus-v2-preflight.yml' &&
      key === 'source_ref'
    )
      continue;
    if (spec.inputs[key] !== value) return false;
  }
  for (const key of Object.keys(spec.inputs)) {
    if (!(key in request.inputs) && !migratedInputs.has(key)) return false;
  }
  return true;
}

function isArtifactPreparationOperation(operationType: string): boolean {
  return (
    operationType.includes('PREPARE_ARTIFACT_') ||
    operationType.startsWith('ISOLATE_PREFLIGHT_')
  );
}

function exactStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    return null;
  return value;
}

function exactStringLayers(
  value: unknown
): readonly (readonly string[])[] | null {
  if (!Array.isArray(value)) return null;
  const layers = value.map(exactStringArray);
  return layers.some((layer) => layer === null)
    ? null
    : (layers as readonly (readonly string[])[]);
}

function assertCandidateEvidenceAuthorization(
  requestInputs: Readonly<Record<string, string>>,
  input: ReleaseBusV2Authorization
): void {
  const requestedMode =
    requestInputs.candidate_evidence_mode ?? 'legacy-whole-train';
  const authorizedMode = input.candidate_evidence_mode ?? 'legacy-whole-train';
  if (
    requestedMode !== authorizedMode ||
    (requestInputs.aggregate_candidate_evidence_digest || null) !==
      input.aggregate_candidate_evidence_digest
  )
    throw new Error(
      'Release Bus v2 candidate evidence does not match the dispatched operation'
    );

  const sourceRef = input.source_ref ?? null;
  const reuseIdentity = {
    runId: input.reuse_artifact_run_id ?? null,
    name: input.reuse_artifact_name ?? null,
    digest: input.reuse_artifact_digest ?? null
  };
  if (authorizedMode === 'legacy-whole-train') {
    if (sourceRef || Object.values(reuseIdentity).some(Boolean))
      throw new Error(
        'Legacy Release Bus v2 authorization must retain the old API shape'
      );
    return;
  }
  if (!sourceRef)
    throw new Error(
      'Strict Release Bus v2 authorization requires an exact source ref'
    );
  if (requestInputs.source_ref !== sourceRef)
    throw new Error(
      'Release Bus v2 source ref does not match the dispatched operation'
    );
  if (authorizedMode === 'strict-aggregate') {
    if (Object.values(reuseIdentity).some(Boolean))
      throw new Error(
        'Strict aggregate authorization cannot name singular candidate evidence'
      );
    return;
  }
  if (
    !reuseIdentity.runId ||
    !reuseIdentity.name ||
    !reuseIdentity.digest ||
    reuseIdentity.name !== `release-bus-v2-pr-${input.expected_sha}` ||
    requestInputs.reuse_artifact_run_id !== reuseIdentity.runId ||
    requestInputs.reuse_artifact_name !== reuseIdentity.name ||
    requestInputs.reuse_artifact_digest !== reuseIdentity.digest
  )
    throw new Error(
      'Strict single authorization does not match its exact candidate evidence artifact'
    );
}

function validateEnvironmentBoundArtifactSummary(
  operation: ReleaseBusV2OperationRecord,
  progress: ReleaseBusV2Progress,
  inputs: Readonly<Record<string, string>>
): void {
  if (inputs.artifact_contract_version !== 'environment-bound-v3') return;
  if (!progress.summary || typeof progress.summary !== 'object')
    throw new Error(
      'Environment-bound artifact preparation requires structured terminal evidence'
    );
  const summary = progress.summary as Record<string, unknown>;
  if (
    summary.schema_version !== 3 ||
    summary.artifact_contract !== 'environment-bound-v1' ||
    summary.artifact_contract_version !== 'environment-bound-v3' ||
    summary.repository !== operation.repository ||
    summary.source_sha !== operation.expected_sha ||
    summary.environment !== inputs.artifact_environment ||
    summary.source_evidence_reused !== true ||
    summary.artifact_bytes_reused !== false
  )
    throw new Error(
      'Environment-bound artifact terminal evidence does not match the exact operation'
    );
  const evidence =
    summary.ci_evidence && typeof summary.ci_evidence === 'object'
      ? (summary.ci_evidence as Record<string, unknown>)
      : null;
  const evidenceMode = inputs.candidate_evidence_mode;
  if (
    !evidence ||
    !['strict-single', 'strict-aggregate'].includes(evidenceMode ?? '') ||
    evidence.mode !== evidenceMode ||
    evidence.aggregate_candidate_evidence_digest !==
      (inputs.aggregate_candidate_evidence_digest || null) ||
    evidence.artifact_run_id !== (inputs.reuse_artifact_run_id || null) ||
    evidence.artifact_name !== (inputs.reuse_artifact_name || null) ||
    evidence.artifact_digest !== (inputs.reuse_artifact_digest || null)
  )
    throw new Error(
      'Environment-bound artifact terminal evidence does not bind the exact candidate evidence mode'
    );
  if (operation.repository === 'backend') {
    let expectedUnits: unknown;
    let expectedLayers: unknown;
    try {
      expectedUnits = JSON.parse(inputs.deploy_units ?? 'null');
      expectedLayers = JSON.parse(inputs.deploy_layers ?? 'null');
    } catch {
      expectedUnits = null;
      expectedLayers = null;
    }
    const units = exactStringArray(summary.units);
    const expected = exactStringArray(expectedUnits);
    const layers = exactStringLayers(summary.layers);
    const expectedDAG = exactStringLayers(expectedLayers);
    const packageDigests =
      summary.package_digests && typeof summary.package_digests === 'object'
        ? (summary.package_digests as Record<string, unknown>)
        : null;
    if (
      !units ||
      !expected ||
      !layers ||
      !expectedDAG ||
      !isDeepStrictEqual(layers, expectedDAG) ||
      units.length !== expected.length ||
      units.some((unit, index) => unit !== expected[index]) ||
      !packageDigests ||
      Object.keys(packageDigests).length !== expected.length ||
      expected.some(
        (unit) =>
          typeof packageDigests[unit] !== 'string' ||
          !/^[a-f0-9]{64}$/.test(String(packageDigests[unit]))
      )
    )
      throw new Error(
        'Environment-bound backend artifact evidence does not bind every selected unit digest'
      );
  } else if (
    typeof summary.package_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(summary.package_digest)
  ) {
    throw new Error(
      'Environment-bound frontend artifact evidence requires an exact package digest'
    );
  }
}

function validateEnvironmentBoundDeploySummary(
  operation: ReleaseBusV2OperationRecord,
  progress: ReleaseBusV2Progress,
  inputs: Readonly<Record<string, string>>
): void {
  if (
    inputs.artifact_contract_version !== 'environment-bound-v3' ||
    !(
      operation.operation_type.startsWith('DEPLOY_') ||
      operation.operation_type.startsWith('ROLLBACK_DEPLOY_')
    )
  )
    return;
  if (!progress.summary || typeof progress.summary !== 'object')
    throw new Error(
      'Environment-bound deployment requires structured terminal evidence'
    );
  const summary = progress.summary as Record<string, unknown>;
  if (
    summary.schema_version !== 3 ||
    summary.artifact_contract !== 'environment-bound-v1' ||
    summary.artifact_digest !== operation.artifact_digest ||
    summary.artifact_digest !== inputs.artifact_digest ||
    summary.artifact_contract_version !== 'environment-bound-v3' ||
    summary.environment !== inputs.artifact_environment ||
    summary.repository !== operation.repository ||
    summary.source_sha !== operation.expected_sha ||
    summary.service !== operation.service ||
    summary.artifact_run_id !== inputs.artifact_run_id ||
    summary.artifact_train_id !== inputs.artifact_train_id ||
    summary.consumed_preflight_artifact !== true ||
    summary.rebuilt !== false ||
    !/^[a-f0-9]{64}$/.test(String(summary.package_digest ?? ''))
  )
    throw new Error(
      'Environment-bound deployment evidence does not match the exact operation'
    );
}

function validateLegacyDeploySummary(
  operation: ReleaseBusV2OperationRecord,
  progress: ReleaseBusV2Progress,
  inputs: Readonly<Record<string, string>>
): void {
  if (
    inputs.artifact_contract_version !== 'legacy-v2' ||
    !(
      operation.operation_type.startsWith('DEPLOY_') ||
      operation.operation_type.startsWith('ROLLBACK_DEPLOY_')
    )
  )
    return;
  if (!progress.summary || typeof progress.summary !== 'object')
    throw new Error(
      'Legacy deployment requires structured terminal consumption evidence'
    );
  const summary = progress.summary as Record<string, unknown>;
  if (
    summary.schema_version !== 2 ||
    summary.artifact_contract !== 'legacy-v2' ||
    summary.artifact_contract_version !== 'legacy-v2' ||
    summary.repository !== operation.repository ||
    summary.source_sha !== operation.expected_sha ||
    summary.environment !== 'portable' ||
    summary.deployment_environment !== operation.environment ||
    summary.service !== operation.service ||
    summary.artifact_run_id !== inputs.artifact_run_id ||
    summary.artifact_train_id !==
      (inputs.artifact_train_id || operation.train_id) ||
    summary.artifact_digest !== operation.artifact_digest ||
    summary.artifact_digest !== inputs.artifact_digest ||
    summary.consumed_preflight_artifact !== true ||
    summary.rebuilt !== false ||
    !/^[a-f0-9]{64}$/.test(String(summary.package_digest ?? ''))
  )
    throw new Error(
      'Legacy deployment evidence does not match the exact same-train artifact operation'
    );
}

function transportRetryState(result: unknown): {
  readonly retry_same_attempt: true;
  readonly transport_failures: number;
} | null {
  const parsed = parseStoredJson<{
    retry_same_attempt?: unknown;
    transport_failures?: unknown;
  }>(result);
  return parsed?.retry_same_attempt === true &&
    Number.isSafeInteger(parsed.transport_failures) &&
    Number(parsed.transport_failures) > 0
    ? {
        retry_same_attempt: true,
        transport_failures: Number(parsed.transport_failures)
      }
    : null;
}

function unreportedWorkflowFailureClass(
  operationType: string,
  conclusion: string | null
): ReleaseBusV2FailureClass {
  if (
    ['cancelled', 'timed_out', 'stale', 'startup_failure'].includes(
      conclusion ?? ''
    )
  )
    return 'INFRASTRUCTURE';
  if (isArtifactPreparationOperation(operationType) && conclusion === 'failure')
    // Artifact preparation cannot mutate shared staging or production state.
    // Its run also concludes failure when otherwise-successful artifact work
    // cannot deliver the terminal callback (for example during an intentional
    // fast-off). A bounded retry is safe and recovers the missing evidence.
    return 'INFRASTRUCTURE';
  // Every v2 workflow that reaches its trusted authorization boundary emits a
  // structured terminal report. A completed run without one is therefore a
  // protocol/control-plane failure, not evidence against a candidate.
  return 'CONTROL_PLANE';
}

export class ReleaseBusV2Operations {
  public constructor(
    private readonly repository: ReleaseBusV2RepositoryClass = releaseBusV2Repository
  ) {}

  public async reconcileWorkflow(
    spec: ReleaseBusV2WorkflowSpec
  ): Promise<ReleaseBusV2OperationRecord> {
    try {
      return await this.reconcileWorkflowOnce(spec);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Release Bus v2 operation changed concurrently'
      ) {
        const current = await this.repository.findOperation(
          spec.idempotencyKey,
          {},
          true
        );
        if (current) return current;
      }
      throw error;
    }
  }

  private async reconcileWorkflowOnce(
    spec: ReleaseBusV2WorkflowSpec
  ): Promise<ReleaseBusV2OperationRecord> {
    const existing = await this.repository.findOperation(
      spec.idempotencyKey,
      {},
      true
    );
    const existingRequest = existing
      ? exactStoredWorkflowRequest(existing.request_json)
      : null;
    const preservedLegacyRequest =
      existingRequest &&
      isCompatibleExistingLegacyRequest(existingRequest, spec)
        ? existingRequest
        : null;
    const workflowControlSha =
      preservedLegacyRequest || existingRequest?.workflow_control_sha
        ? existingRequest?.workflow_control_sha
        : await releaseBusGitHubApp.resolveRef(spec.repository, spec.ref);
    if (
      !preservedLegacyRequest &&
      !/^[a-f0-9]{40}$/.test(workflowControlSha ?? '')
    )
      throw new Error(
        'Release Bus v2 workflow control ref did not resolve to an exact SHA'
      );
    const immutableRequest =
      preservedLegacyRequest ??
      ({
        workflow: spec.workflow,
        ref: spec.ref,
        workflow_control_sha: workflowControlSha,
        inputs: spec.inputs,
        beta_infrastructure_failure_injection:
          spec.betaInfrastructureFailureInjection ?? null
      } satisfies ExactStoredWorkflowRequest);
    let operation = await this.repository.getOrCreateOperation(
      {
        idempotencyKey: spec.idempotencyKey,
        trainId: spec.trainId,
        operationType: spec.operationType,
        repository: spec.repository,
        service: spec.service,
        environment: spec.environment,
        expectedSha: spec.expectedSha,
        artifactDigest: spec.artifactDigest,
        request: immutableRequest,
        maxAttempts: spec.maxAttempts
      },
      {}
    );
    const operationRequest = exactStoredWorkflowRequest(operation.request_json);
    if (!operationRequest)
      throw new Error('Release Bus v2 operation has no workflow identity');
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status))
      return operation;
    if (
      operation.status === 'RETRY_WAIT' &&
      Number(operation.next_retry_at) > Date.now()
    )
      return operation;
    if (operation.status === 'RETRY_WAIT') {
      const sameAttempt = transportRetryState(operation.result_json);
      if (!sameAttempt && operation.attempt >= operation.max_attempts) {
        await this.update(operation, {
          status: 'FAILED',
          completedAt: Date.now(),
          failureClass: operation.failure_class ?? 'INFRASTRUCTURE',
          failureMessage:
            operation.failure_message ?? 'Infrastructure retry budget exhausted'
        });
        return (
          (await this.repository.findOperation(
            spec.idempotencyKey,
            {},
            true
          )) ??
          operation
        );
      }
      await this.update(operation, {
        status: 'PENDING',
        attempt: sameAttempt ? operation.attempt : operation.attempt + 1,
        externalId: null,
        result: sameAttempt ? undefined : null,
        nextRetryAt: null,
        failureClass: null,
        failureMessage: null,
        completedAt: null
      });
      operation =
        (await this.repository.findOperation(
          spec.idempotencyKey,
          {},
          true
        )) ??
        operation;
    }

    if (
      operation.status === 'PENDING' &&
      operation.attempt === 1 &&
      operation.external_id === null &&
      spec.betaInfrastructureFailureInjection
    ) {
      const nextRetryAt = Date.now() + retryDelayMs(operation.attempt);
      await this.update(operation, {
        status: 'RETRY_WAIT',
        nextRetryAt,
        failureClass: 'INFRASTRUCTURE',
        failureMessage:
          'Injected operator beta infrastructure failure before dispatch'
      });
      await this.repository.appendEvent(
        {
          trainId: operation.train_id,
          candidateId: spec.betaInfrastructureFailureInjection.candidateId,
          eventType: 'BETA_INFRASTRUCTURE_FAILURE_INJECTED',
          actor: 'release-bus-v2-beta',
          payload: {
            attempt: operation.attempt,
            next_retry_at: nextRetryAt,
            operation_id: operation.id,
            operation_type: operation.operation_type,
            test_id: spec.betaInfrastructureFailureInjection.testId
          }
        },
        {}
      );
      return (
        (await this.repository.findOperation(
          spec.idempotencyKey,
          {},
          true
        )) ??
        operation
      );
    }

    const attemptKey = attemptOperationKey(
      operation.idempotency_key,
      operation.attempt
    );
    const dispatchInputs = {
      ...operationRequest.inputs,
      operation_key: attemptKey
    };
    const recoveringTransport = transportRetryState(operation.result_json);
    let run;
    try {
      run = await releaseBusGitHubApp.findWorkflowRun(
        spec.repository,
        operationRequest.workflow,
        attemptKey,
        operation.external_id
      );
      if (!run && operation.status === 'PENDING' && recoveringTransport) {
        // A dispatch response may have been lost. Require one successful GitHub
        // discovery boundary before permitting another dispatch with the same
        // attempt key, so an eventually indexed run wins over a duplicate.
        await this.update(operation, { status: 'PENDING', result: null });
        return (
          (await this.repository.findOperation(
            spec.idempotencyKey,
            {},
            true
          )) ??
          operation
        );
      }
      if (!run && operation.status === 'PENDING') {
        // Reserve the exact attempt before calling GitHub. Concurrent
        // reconcilers race on this optimistic update, so only one winner can
        // dispatch while the workflow is not yet discoverable.
        await this.update(operation, { status: 'DISPATCHED', result: null });
        const reserved = await this.repository.findOperation(
          spec.idempotencyKey,
          {},
          true
        );
        if (!reserved)
          throw new Error(
            'Release Bus v2 dispatch reservation was not visible on the writer'
          );
        if (reserved.status !== 'DISPATCHED') return reserved;
        operation = reserved;
        await releaseBusGitHubApp.dispatchWorkflow(
          spec.repository,
          operationRequest.workflow,
          operationRequest.ref,
          dispatchInputs
        );
        return operation;
      }
    } catch (error) {
      if (isGitHubInfrastructureError(error))
        return this.deferTransportRetry(operation, error.message);
      if (operation.status === 'DISPATCHED' && operation.external_id === null)
        await this.update(operation, {
          status: 'FAILED',
          failureClass: 'CONTROL_PLANE',
          failureMessage: `GitHub workflow dispatch was rejected before creation: ${
            error instanceof Error ? error.message : 'unknown dispatch error'
          }`,
          completedAt: Date.now()
        });
      throw error;
    }
    if (!run && operation.status === 'DISPATCHED') {
      if (
        Date.now() - Number(operation.updated_at) >=
        DISPATCH_DISCOVERY_GRACE_MS
      )
        return this.deferTransportRetry(
          operation,
          'Reserved dispatch was not discoverable after the indexing grace period'
        );
      return operation;
    }
    if (!run) return operation;
    if (
      operation.external_id !== String(run.id) ||
      operation.status === 'DISPATCHED'
    ) {
      await this.update(operation, {
        status: 'RUNNING',
        externalId: String(run.id),
        result: transportRetryState(operation.result_json) ? null : undefined
      });
      operation =
        (await this.repository.findOperation(
          spec.idempotencyKey,
          {},
          true
        )) ??
        operation;
    }
    if (run.status !== 'completed') return operation;

    const latest =
      (await this.repository.findOperation(spec.idempotencyKey, {}, true)) ??
      operation;
    if (['SUCCEEDED', 'FAILED', 'RETRY_WAIT'].includes(latest.status))
      return latest;
    const failureClass = unreportedWorkflowFailureClass(
      latest.operation_type,
      run.conclusion
    );
    const retry =
      failureClass === 'INFRASTRUCTURE' && latest.attempt < latest.max_attempts;
    await this.update(latest, {
      status: retry ? 'RETRY_WAIT' : 'FAILED',
      externalId: String(run.id),
      nextRetryAt: retry ? Date.now() + retryDelayMs(latest.attempt) : null,
      failureClass,
      failureMessage: `GitHub workflow concluded ${
        run.conclusion ?? 'without a conclusion'
      } without a structured terminal callback`,
      completedAt: retry ? null : Date.now()
    });
    return (
      (await this.repository.findOperation(spec.idempotencyKey, {}, true)) ??
      latest
    );
  }

  public async authorize(
    input: ReleaseBusV2Authorization
  ): Promise<{ authorized: true }> {
    const { idempotencyKey, attempt } = parseAttemptOperationKey(
      input.operation_key
    );
    const operation = await this.repository.findOperation(
      idempotencyKey,
      {},
      true
    );
    if (
      !operation ||
      operation.train_id !== input.train_id ||
      operation.attempt !== attempt
    )
      throw new Error('Release Bus v2 operation attempt does not exist');
    if (
      !['PENDING', 'DISPATCHED', 'RUNNING', 'RETRY_WAIT'].includes(
        operation.status
      )
    )
      throw new Error(
        `Release Bus v2 operation cannot authorize while ${operation.status}`
      );
    if (
      operation.repository !== input.repository ||
      operation.environment !== input.environment ||
      operation.service !== input.service ||
      operation.expected_sha !== input.expected_sha ||
      operation.artifact_digest !== input.artifact_digest
    )
      throw new Error(
        'Release Bus v2 operation does not match the authorization request'
      );
    if (
      operation.external_id &&
      operation.external_id !== input.workflow_run_id
    )
      throw new Error(
        'Release Bus v2 operation is already bound to another workflow run'
      );
    const request = exactStoredWorkflowRequest(operation.request_json);
    if (!request)
      throw new Error('Release Bus v2 operation has no workflow identity');
    const identity = await releaseBusGitHubApp.getWorkflowRunIdentity(
      input.repository,
      input.workflow_run_id
    );
    const expectedWorkflowPath = `.github/workflows/${request.workflow}`;
    const legacyControlIdentity =
      !request.workflow_control_sha &&
      (request.inputs.candidate_evidence_mode === undefined ||
        request.inputs.candidate_evidence_mode === 'legacy-whole-train') &&
      identity.headBranch === request.ref
        ? identity.headSha
        : null;
    if (legacyControlIdentity) {
      const workflowBlobSha = await releaseBusGitHubApp.getWorkflowBlobIdentity(
        input.repository,
        request.workflow,
        legacyControlIdentity
      );
      if (
        !isAllowedLegacyOperationWorkflowBlob(
          input.repository,
          request.workflow,
          workflowBlobSha
        )
      )
        throw new Error(
          'Legacy Release Bus workflow content is not exactly allowlisted'
        );
    }
    const workflowControlSha =
      request.workflow_control_sha ?? legacyControlIdentity;
    if (!/^[a-f0-9]{40}$/.test(workflowControlSha ?? ''))
      throw new Error(
        'Release Bus v2 operation has no exact workflow control identity'
      );
    const expectedWorkflowRefs = new Set([
      expectedWorkflowPath,
      `${expectedWorkflowPath}@${request.ref}`,
      `${expectedWorkflowPath}@refs/heads/${request.ref}`,
      `${expectedWorkflowPath}@refs/tags/${request.ref}`
    ]);
    if (
      !isReleaseBusGitHubAppActor(identity.actor) ||
      identity.event !== 'workflow_dispatch' ||
      !expectedWorkflowRefs.has(identity.path) ||
      identity.headSha !== workflowControlSha ||
      !identity.displayTitle.includes(`[${input.operation_key}]`)
    )
      throw new Error('Workflow run identity does not match the v2 operation');
    if ((request.inputs?.artifact_run_id ?? null) !== input.artifact_run_id)
      throw new Error(
        'Release Bus v2 artifact source does not match the dispatched operation'
      );
    assertCandidateEvidenceAuthorization(request.inputs ?? {}, input);
    if (!operation.external_id || operation.status === 'DISPATCHED') {
      await this.update(operation, {
        status: 'RUNNING',
        externalId: input.workflow_run_id,
        artifactDigest: input.artifact_digest ?? undefined
      });
    }
    return { authorized: true };
  }

  public async reportProgress(
    input: ReleaseBusV2Progress
  ): Promise<{ accepted: true; reused: boolean }> {
    const { idempotencyKey, attempt } = parseAttemptOperationKey(
      input.operation_key
    );
    const operation = await this.repository.findOperation(
      idempotencyKey,
      {},
      true
    );
    if (
      !operation ||
      operation.train_id !== input.train_id ||
      operation.attempt !== attempt
    )
      throw new Error('Release Bus v2 operation attempt does not exist');
    if (operation.external_id !== input.workflow_run_id)
      throw new Error(
        'Release Bus v2 progress run does not match the authorized operation'
      );
    const storedResult = parseStoredJson<ReleaseBusV2Progress>(
      operation.result_json
    );
    if (['SUCCEEDED', 'FAILED'].includes(operation.status)) {
      if (isDeepStrictEqual(storedResult, input))
        return { accepted: true, reused: true };
      throw new Error(
        'A different terminal progress report already exists for this v2 operation'
      );
    }
    const terminal = input.status === 'SUCCEEDED' || input.status === 'FAILED';
    const failureClass =
      input.status === 'FAILED' ? classifyFailure(input.failure_class) : null;
    const shouldRetry =
      input.status === 'FAILED' &&
      (failureClass === 'INFRASTRUCTURE' || failureClass === 'DEPLOYMENT') &&
      Boolean(input.retryable) &&
      operation.attempt < operation.max_attempts;
    const artifactDigest = progressArtifactDigest(input);
    const request = parseStoredJson<{
      inputs?: Readonly<Record<string, string>>;
    }>(operation.request_json);
    if (
      input.status === 'SUCCEEDED' &&
      isArtifactPreparationOperation(operation.operation_type) &&
      !artifactDigest
    )
      throw new Error(
        'A successful artifact preparation report requires an exact SHA-256 digest'
      );
    if (
      input.status === 'SUCCEEDED' &&
      isArtifactPreparationOperation(operation.operation_type)
    )
      validateEnvironmentBoundArtifactSummary(
        operation,
        input,
        request?.inputs ?? {}
      );
    if (input.status === 'SUCCEEDED')
      validateEnvironmentBoundDeploySummary(
        operation,
        input,
        request?.inputs ?? {}
      );
    if (input.status === 'SUCCEEDED')
      validateLegacyDeploySummary(operation, input, request?.inputs ?? {});
    await this.update(operation, {
      status: shouldRetry
        ? 'RETRY_WAIT'
        : input.status === 'RUNNING'
          ? 'RUNNING'
          : input.status,
      result: input,
      artifactDigest: artifactDigest ?? undefined,
      nextRetryAt: shouldRetry
        ? Date.now() + retryDelayMs(operation.attempt)
        : null,
      failureClass,
      failureMessage:
        input.status === 'FAILED'
          ? `${input.failure_phase ?? 'workflow'} failed`
          : null,
      completedAt: terminal && !shouldRetry ? Date.now() : null
    });
    return { accepted: true, reused: false };
  }

  private async update(
    operation: ReleaseBusV2OperationRecord,
    fields: Parameters<ReleaseBusV2RepositoryClass['updateOperation']>[2]
  ): Promise<void> {
    if (
      !(await this.repository.updateOperation(
        operation.id,
        operation.row_version,
        fields,
        {}
      ))
    )
      throw new Error('Release Bus v2 operation changed concurrently');
  }

  private async deferTransportRetry(
    operation: ReleaseBusV2OperationRecord,
    message: string
  ): Promise<ReleaseBusV2OperationRecord> {
    const previous = transportRetryState(operation.result_json);
    const failures = (previous?.transport_failures ?? 0) + 1;
    const exhausted = failures >= operation.max_attempts;
    await this.update(operation, {
      status: exhausted ? 'FAILED' : 'RETRY_WAIT',
      result: { retry_same_attempt: true, transport_failures: failures },
      nextRetryAt: exhausted ? null : Date.now() + retryDelayMs(failures),
      failureClass: 'INFRASTRUCTURE',
      failureMessage: exhausted
        ? `GitHub transport retry budget exhausted: ${message}`
        : `GitHub transport is unavailable; discovering the same attempt before retry: ${message}`,
      completedAt: exhausted ? Date.now() : null
    });
    return (
      (await this.repository.findOperation(
        operation.idempotency_key,
        {},
        true
      )) ??
      operation
    );
  }
}

export const releaseBusV2Operations = new ReleaseBusV2Operations();
