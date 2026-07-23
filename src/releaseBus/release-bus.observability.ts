import type {
  ReleaseLaneRecord,
  ReleaseOperationRecord
} from '@/releaseBus/release-bus.repository';
import type {
  ReleaseTrainRecord,
  ReleaseTrainStatus
} from '@/releaseBus/release-bus.types';

export const RELEASE_TRAIN_PHASES = [
  'COLLECTING',
  'FROZEN',
  'BASE_CANARY_RUNNING',
  'COMPOSING',
  'PREFLIGHTING',
  'ISOLATING_FAILURE',
  'DEPLOYING_BACKEND',
  'DEPLOYING_FRONTEND',
  'E2E_RUNNING',
  'VALIDATING_STAGING',
  'MERGING_PRODUCTION',
  'VALIDATING_PRODUCTION',
  'SYNCING_STAGING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED'
] as const;

export type ReleaseTrainPhase = (typeof RELEASE_TRAIN_PHASES)[number];

export const RELEASE_WAIT_REASON_CODES = [
  'ROLLOUT_MODE_OFF',
  'SHADOW_MODE',
  'PRODUCTION_MODE_DISABLED',
  'CONTROL_PAUSED',
  'LEASE_UNAVAILABLE',
  'EXTERNAL_DEPLOYMENT_ACTIVE',
  'OPERATION_RUNNING',
  'GITHUB_WORKFLOW_RUNNING',
  'INFRASTRUCTURE_RETRY_BACKOFF',
  'OPERATION_STALLED',
  'OPERATION_RECONCILING',
  'PHASE_TRANSITION'
] as const;

export type ReleaseWaitReasonCode = (typeof RELEASE_WAIT_REASON_CODES)[number];

export type ReleaseWaitReason = {
  readonly code: ReleaseWaitReasonCode;
  readonly summary: string;
  readonly lease?: {
    readonly name: string;
    readonly owner: string | null;
    readonly train_id: string | null;
    readonly heartbeat_at: number | null;
    readonly expires_at: number | null;
  };
  readonly external_operation?: {
    readonly repository: 'frontend' | 'backend' | 'unknown';
    readonly environment: 'staging' | 'prod' | 'unknown';
  };
  readonly control?: {
    readonly scope: string;
    readonly reason: string | null;
    readonly actor: string | null;
    readonly updated_at: number;
  };
};

export type ReleaseOperationHealth =
  | 'PENDING'
  | 'RUNNING'
  | 'STALLED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type ReleaseOperationView = {
  readonly operation_key: string;
  readonly operation_type: string;
  readonly phase: ReleaseTrainPhase;
  readonly status: string;
  readonly health: ReleaseOperationHealth;
  readonly stalled_reason: string | null;
  readonly repository: string | null;
  readonly environment: string | null;
  readonly service: string | null;
  readonly expected_sha: string | null;
  readonly run_id: string | null;
  readonly workflow_url: string | null;
  readonly workflow_status: string | null;
  readonly workflow_conclusion: string | null;
  readonly active_job: string | null;
  readonly active_step: string | null;
  readonly failed_job: string | null;
  readonly failed_step: string | null;
  readonly gate_report: unknown;
  readonly started_at: number | null;
  readonly updated_at: number;
  readonly completed_at: number | null;
  readonly elapsed_ms: number;
  readonly last_progress_at: number | null;
  readonly stale_after_ms: number;
};

const TERMINAL_OPERATION_STATUSES = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
]);

const ACTIONS_URL_PATTERN =
  /^https:\/\/github\.com\/6529-Collections\/6529seize-(?:frontend|backend)\/actions\/runs\/\d+$/;

function objectMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : null;
}

function boundedInteger(value: unknown, max: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

function numericFields(
  value: unknown,
  names: readonly string[],
  max: number
): Record<string, number> {
  const source = objectMetadata(value);
  return Object.fromEntries(
    names.flatMap((name) => {
      const number = boundedInteger(source[name], max);
      return number === null ? [] : [[name, number]];
    })
  );
}

function sanitizeGateReport(value: unknown): unknown {
  const report = objectMetadata(value);
  if (Object.keys(report).length === 0) return null;
  const stages = Array.isArray(report.stages)
    ? report.stages.slice(0, 8).flatMap((stage) => {
        const record = objectMetadata(stage);
        const name = boundedText(record.name, 32);
        const status = boundedText(record.status, 32);
        return name && status ? [{ name, status }] : [];
      })
    : [];
  const rawJest = objectMetadata(report.jest);
  const jest = Object.keys(rawJest).length
    ? {
        num_failed_test_suites:
          boundedInteger(rawJest.num_failed_test_suites, 10_000) ?? 0,
        num_failed_tests:
          boundedInteger(rawJest.num_failed_tests, 100_000) ?? 0,
        failing_suites: Array.isArray(rawJest.failing_suites)
          ? rawJest.failing_suites
              .flatMap((suite) => {
                const text = boundedText(suite, 500);
                return text ? [text] : [];
              })
              .slice(0, 50)
          : [],
        failing_tests: Array.isArray(rawJest.failing_tests)
          ? rawJest.failing_tests
              .flatMap((test) => {
                const record = objectMetadata(test);
                const suite = boundedText(record.suite, 500);
                const name = boundedText(record.test, 500);
                return suite && name ? [{ suite, test: name }] : [];
              })
              .slice(0, 100)
          : []
      }
    : null;
  const rawSummary = objectMetadata(report.summary);
  const summary = Object.keys(rawSummary).length
    ? {
        kind: boundedText(rawSummary.kind, 80),
        base_sha: boundedText(rawSummary.base_sha, 40),
        environment: boundedText(rawSummary.environment, 32),
        gate_fingerprint: boundedText(rawSummary.gate_fingerprint, 80),
        behavior_digest: boundedText(rawSummary.behavior_digest, 80),
        build_profile_digest: boundedText(rawSummary.build_profile_digest, 80),
        workflow_sha: boundedText(rawSummary.workflow_sha, 40),
        workflow_digest: boundedText(rawSummary.workflow_digest, 80),
        node_version: boundedText(rawSummary.node_version, 64),
        package_manager: boundedText(rawSummary.package_manager, 128),
        gate_mode: boundedText(rawSummary.gate_mode, 16),
        shard_count: boundedInteger(rawSummary.shard_count, 256),
        summary_artifact_name: boundedText(
          rawSummary.summary_artifact_name,
          500
        ),
        summary_artifact_digest: boundedText(
          rawSummary.summary_artifact_digest,
          80
        ),
        phase_durations_ms: numericFields(
          rawSummary.phase_durations_ms,
          ['lint', 'typecheck', 'unit_tests', 'build', 'total'],
          24 * 60 * 60 * 1000
        ),
        totals: numericFields(
          rawSummary.totals,
          [
            'files',
            'test_suites',
            'tests',
            'failed_test_suites',
            'failed_tests',
            'skipped_tests'
          ],
          10_000_000
        ),
        fresh_or_reused: boundedText(rawSummary.fresh_or_reused, 16),
        shards: Array.isArray(rawSummary.shards)
          ? rawSummary.shards.slice(0, 256).map((shard) => {
              const record = objectMetadata(shard);
              return {
                index: boundedInteger(record.index, 255),
                count: boundedInteger(record.count, 256),
                coordinate: boundedText(record.coordinate, 64),
                status: boundedText(record.status, 32),
                duration_ms: boundedInteger(
                  record.duration_ms,
                  24 * 60 * 60 * 1000
                ),
                ...numericFields(
                  record,
                  [
                    'files',
                    'test_suites',
                    'tests',
                    'failed_test_suites',
                    'failed_tests'
                  ],
                  10_000_000
                )
              };
            })
          : [],
        missing_files: Array.isArray(rawSummary.missing_files)
          ? rawSummary.missing_files
              .flatMap((file) => {
                const text = boundedText(file, 500);
                return text ? [text] : [];
              })
              .slice(0, 200)
          : [],
        duplicate_files: Array.isArray(rawSummary.duplicate_files)
          ? rawSummary.duplicate_files
              .flatMap((file) => {
                const text = boundedText(file, 500);
                return text ? [text] : [];
              })
              .slice(0, 200)
          : [],
        unexpected_files: Array.isArray(rawSummary.unexpected_files)
          ? rawSummary.unexpected_files
              .flatMap((file) => {
                const text = boundedText(file, 500);
                return text ? [text] : [];
              })
              .slice(0, 200)
          : [],
        proof_origin: boundedText(rawSummary.proof_origin, 64),
        build_environments: Array.isArray(rawSummary.build_environments)
          ? rawSummary.build_environments
              .flatMap((environment) => {
                const text = boundedText(environment, 32);
                return text ? [text] : [];
              })
              .slice(0, 2)
          : [],
        build_coverage: (() => {
          const coverage = objectMetadata(rawSummary.build_coverage);
          return Object.keys(coverage).length
            ? {
                authoritative_profile: boundedText(
                  coverage.authoritative_profile,
                  32
                ),
                compilation_count: boundedInteger(
                  coverage.compilation_count,
                  10
                ),
                deployed_artifact_bound:
                  coverage.deployed_artifact_bound === true,
                base_canary_profile: boundedText(
                  coverage.base_canary_profile,
                  32
                ),
                deploy_artifact_profile: boundedText(
                  coverage.deploy_artifact_profile,
                  32
                )
              }
            : null;
        })(),
        immutable_artifact: (() => {
          const artifact = objectMetadata(rawSummary.immutable_artifact);
          return Object.keys(artifact).length
            ? {
                artifact_name: boundedText(artifact.artifact_name, 500),
                run_id: boundedText(artifact.run_id, 100),
                source_sha: boundedText(artifact.source_sha, 40),
                environment: boundedText(artifact.environment, 32),
                package_digest: boundedText(artifact.package_digest, 80),
                upload_digest: boundedText(artifact.upload_digest, 80),
                build_profile_digest: boundedText(
                  artifact.build_profile_digest,
                  80
                )
              }
            : null;
        })()
      }
    : null;
  const rawBackendEvidence = objectMetadata(report.backend_evidence);
  const rawBackendTests = objectMetadata(rawBackendEvidence.tests);
  const backendEvidence = Object.keys(rawBackendEvidence).length
    ? {
        source_sha: boundedText(rawBackendEvidence.source_sha, 40),
        source_tree: boundedText(rawBackendEvidence.source_tree, 40),
        gate_fingerprint: boundedText(rawBackendEvidence.gate_fingerprint, 80),
        behavior_digest: boundedText(rawBackendEvidence.behavior_digest, 80),
        execution: boundedText(rawBackendEvidence.execution, 64),
        reuse_reason: boundedText(rawBackendEvidence.reuse_reason, 100),
        selected_units: Array.isArray(rawBackendEvidence.selected_units)
          ? rawBackendEvidence.selected_units
              .flatMap((unit) => {
                const text = boundedText(unit, 100);
                return text ? [text] : [];
              })
              .slice(0, 100)
          : [],
        package_build_count: boundedInteger(
          rawBackendEvidence.package_build_count,
          100
        ),
        artifact_digest: boundedText(rawBackendEvidence.artifact_digest, 80),
        tests: {
          status: boundedText(rawBackendTests.status, 32),
          jest_max_workers: boundedInteger(
            rawBackendTests.jest_max_workers,
            16
          ),
          expected_files: boundedInteger(
            rawBackendTests.expected_files,
            10_000_000
          ),
          executed_files: boundedInteger(
            rawBackendTests.executed_files,
            10_000_000
          ),
          total_tests: boundedInteger(rawBackendTests.total_tests, 10_000_000),
          skipped_tests: boundedInteger(
            rawBackendTests.skipped_tests,
            10_000_000
          )
        }
      }
    : null;
  return {
    phase: boundedText(report.phase, 32),
    status: boundedText(report.status, 32),
    stages,
    jest,
    summary,
    build_profile_digest: boundedText(report.build_profile_digest, 80),
    backend_evidence: backendEvidence,
    reported_at: boundedInteger(report.reported_at, Number.MAX_SAFE_INTEGER)
  };
}

export function operationStaleAfterMs(operationType: string): number {
  if (
    operationType.startsWith('base-canary-') ||
    operationType.startsWith('preflight-') ||
    operationType.startsWith('isolate-')
  )
    return 60 * 60 * 1000;
  if (operationType.startsWith('deploy-frontend-')) return 45 * 60 * 1000;
  if (
    operationType.startsWith('deploy-backend-') ||
    operationType.startsWith('e2e-')
  )
    return 30 * 60 * 1000;
  if (
    operationType.startsWith('compose-') ||
    operationType.startsWith('merge-') ||
    operationType.startsWith('sync-staging-')
  )
    return 15 * 60 * 1000;
  return 30 * 60 * 1000;
}

export function operationPhase(operationType: string): ReleaseTrainPhase {
  if (operationType.startsWith('base-canary-')) return 'BASE_CANARY_RUNNING';
  if (operationType.startsWith('compose-')) return 'COMPOSING';
  if (operationType.startsWith('preflight-')) return 'PREFLIGHTING';
  if (operationType.startsWith('isolate-')) return 'ISOLATING_FAILURE';
  if (operationType.startsWith('deploy-backend-')) return 'DEPLOYING_BACKEND';
  if (operationType.startsWith('deploy-frontend-')) return 'DEPLOYING_FRONTEND';
  if (operationType.startsWith('e2e-')) return 'E2E_RUNNING';
  if (operationType.startsWith('merge-')) return 'MERGING_PRODUCTION';
  if (operationType.startsWith('sync-staging-')) return 'SYNCING_STAGING';
  return 'FROZEN';
}

function phaseFromStatus(status: ReleaseTrainStatus): ReleaseTrainPhase {
  switch (status) {
    case 'COLLECTING_STAGING':
    case 'COLLECTING_PRODUCTION':
      return 'COLLECTING';
    case 'STAGING':
    case 'DEPLOYING_BACKEND':
    case 'DEPLOYING_BACKEND_PRODUCTION':
      return 'DEPLOYING_BACKEND';
    case 'DEPLOYING_FRONTEND':
    case 'DEPLOYING_FRONTEND_PRODUCTION':
      return 'DEPLOYING_FRONTEND';
    case 'E2E_RUNNING':
    case 'PRODUCTION_E2E_RUNNING':
      return 'E2E_RUNNING';
    case 'DEPLOYING_PRODUCTION':
    case 'MERGING_FRONTEND_PRODUCTION':
      return 'MERGING_PRODUCTION';
    default:
      return status;
  }
}

export function currentTrainPhase(
  train: ReleaseTrainRecord,
  operations: readonly ReleaseOperationRecord[],
  paused: boolean
): ReleaseTrainPhase {
  if (
    paused &&
    !['COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED'].includes(train.status)
  )
    return 'PAUSED';
  const active = selectCurrentOperation(operations);
  if (active) return operationPhase(active.operation_type);
  return phaseFromStatus(train.status);
}

export function selectCurrentOperation(
  operations: readonly ReleaseOperationRecord[]
): ReleaseOperationRecord | null {
  const active = operations
    .filter((operation) => !TERMINAL_OPERATION_STATUSES.has(operation.status))
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  return active ?? null;
}

function classifyHealth(
  operation: ReleaseOperationRecord,
  lastProgressAt: number | null,
  workflowStatus: string | null,
  now: number,
  staleAfterMs: number
): { health: ReleaseOperationHealth; stalledReason: string | null } {
  if (operation.status === 'SUCCEEDED')
    return { health: 'SUCCEEDED', stalledReason: null };
  if (operation.status === 'FAILED')
    return { health: 'FAILED', stalledReason: null };
  if (operation.status === 'CANCELLED')
    return { health: 'CANCELLED', stalledReason: null };
  const lastChange =
    lastProgressAt ?? operation.started_at ?? operation.updated_at;
  if (now - lastChange <= staleAfterMs) {
    return {
      health: operation.status === 'PENDING' ? 'PENDING' : 'RUNNING',
      stalledReason: null
    };
  }
  if (operation.status === 'AMBIGUOUS')
    return {
      health: 'STALLED',
      stalledReason: 'GITHUB_WORKFLOW_RECONCILIATION_STALE'
    };
  if (!workflowStatus)
    return {
      health: 'STALLED',
      stalledReason: 'GITHUB_WORKFLOW_NOT_DISCOVERED'
    };
  return {
    health: 'STALLED',
    stalledReason: 'GITHUB_WORKFLOW_NO_RECENT_PROGRESS'
  };
}

export function toOperationView(
  operation: ReleaseOperationRecord,
  now = Date.now()
): ReleaseOperationView {
  const result = objectMetadata(operation.result_metadata_json);
  const rawUrl = optionalString(result.url);
  const workflowUrl =
    rawUrl && ACTIONS_URL_PATTERN.test(rawUrl) ? rawUrl : null;
  const workflowStatus = optionalString(result.workflow_status);
  const recordedProgressAt = optionalTimestamp(result.last_progress_at);
  const lastProgressAt =
    recordedProgressAt !== null && recordedProgressAt <= now
      ? recordedProgressAt
      : null;
  const staleAfterMs = operationStaleAfterMs(operation.operation_type);
  const health = classifyHealth(
    operation,
    lastProgressAt,
    workflowStatus,
    now,
    staleAfterMs
  );
  const startedAt = operation.started_at ?? operation.created_at;
  const finishedAt = operation.completed_at ?? now;
  return {
    operation_key: operation.operation_key,
    operation_type: operation.operation_type,
    phase: operationPhase(operation.operation_type),
    status: operation.status,
    health: health.health,
    stalled_reason: health.stalledReason,
    repository: operation.repository,
    environment: operation.environment,
    service: operation.service,
    expected_sha: operation.expected_sha,
    run_id:
      operation.external_id && /^\d+$/.test(operation.external_id)
        ? operation.external_id
        : null,
    workflow_url: workflowUrl,
    workflow_status: workflowStatus,
    workflow_conclusion: optionalString(result.workflow_conclusion),
    active_job: optionalString(result.active_job),
    active_step: optionalString(result.active_step),
    failed_job: optionalString(result.failed_job),
    failed_step: optionalString(result.failed_step),
    gate_report: sanitizeGateReport(result.gate_report),
    started_at: operation.started_at,
    updated_at: operation.updated_at,
    completed_at: operation.completed_at,
    elapsed_ms: Math.max(0, finishedAt - startedAt),
    last_progress_at: lastProgressAt,
    stale_after_ms: staleAfterMs
  };
}

export function leaseWaitReason(
  laneName: string,
  lane: ReleaseLaneRecord | null
): ReleaseWaitReason {
  return {
    code: 'LEASE_UNAVAILABLE',
    summary: lane?.lease_owner
      ? `Waiting for ${laneName} lease held by ${lane.lease_owner}.`
      : `Waiting to acquire ${laneName} lease.`,
    lease: {
      name: laneName,
      owner: lane?.lease_owner ?? null,
      train_id: lane?.train_id ?? null,
      heartbeat_at: lane?.heartbeat_at ?? null,
      expires_at: lane?.expires_at ?? null
    }
  };
}
