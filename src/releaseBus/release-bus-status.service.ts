import {
  currentTrainPhase,
  RELEASE_WAIT_REASON_CODES,
  selectCurrentOperation,
  toOperationView,
  type ReleaseOperationView,
  type ReleaseWaitReason
} from '@/releaseBus/release-bus.observability';
import {
  releaseBusRepository,
  type ReleaseBusControlRecord,
  type ReleaseLaneRecord,
  type ReleaseOperationRecord,
  type ReleaseTrainEventRecord,
  type ReleaseTrainItemRecord
} from '@/releaseBus/release-bus.repository';
import type {
  ReleaseCandidateRecord,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';

const TERMINAL_TRAIN_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED'
]);

function metadata(value: unknown): Record<string, unknown> {
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

function safeText(value: unknown, maxLength = 1000): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, maxLength) : null;
}

function safeWaitReason(value: unknown): ReleaseWaitReason | null {
  const candidate = metadata(value);
  const code = safeText(candidate.code, 64);
  const summary = safeText(candidate.summary);
  if (
    !code ||
    !summary ||
    !RELEASE_WAIT_REASON_CODES.includes(
      code as (typeof RELEASE_WAIT_REASON_CODES)[number]
    )
  )
    return null;
  const lease = metadata(candidate.lease);
  const safeLease = lease.name
    ? {
        name: safeText(lease.name, 64) ?? 'unknown',
        owner: safeText(lease.owner, 100),
        train_id: safeText(lease.train_id, 100),
        heartbeat_at:
          typeof lease.heartbeat_at === 'number' ? lease.heartbeat_at : null,
        expires_at:
          typeof lease.expires_at === 'number' ? lease.expires_at : null
      }
    : null;
  return {
    code: code as ReleaseWaitReason['code'],
    summary,
    ...(safeLease ? { lease: safeLease } : {})
  };
}

function latestWaitReason(
  events: readonly ReleaseTrainEventRecord[],
  currentOperation: ReleaseOperationView | null
): ReleaseWaitReason | null {
  const latestWait = events.find(
    (event) => event.event_type === 'TRAIN_WAITING'
  );
  const persisted = safeWaitReason(
    metadata(latestWait?.payload_json).wait_reason
  );
  if (persisted) return persisted;
  if (!currentOperation) return null;
  if (currentOperation.phase === 'BASE_CANARY_RUNNING') {
    return {
      code: 'GITHUB_WORKFLOW_RUNNING',
      summary: `Frontend base canary running for staging SHA ${currentOperation.expected_sha ?? 'unknown'}. Candidates have not been tested yet.`
    };
  }
  if (currentOperation.health === 'STALLED') {
    return {
      code: 'OPERATION_STALLED',
      summary: `${currentOperation.operation_type} is stalled: ${currentOperation.stalled_reason}.`
    };
  }
  return {
    code: currentOperation.workflow_url
      ? 'GITHUB_WORKFLOW_RUNNING'
      : 'OPERATION_RUNNING',
    summary: `Waiting for ${currentOperation.operation_type} to complete.`
  };
}

function controlPaused(
  train: ReleaseTrainRecord,
  controls: readonly ReleaseBusControlRecord[]
): boolean {
  return controls.some(
    (control) =>
      Boolean(control.paused) &&
      (control.scope === 'ALL' || control.scope === train.target_lane)
  );
}

function eventView(event: ReleaseTrainEventRecord) {
  const payload = metadata(event.payload_json);
  return {
    id: event.id,
    event_type: event.event_type,
    candidate_id: event.candidate_id,
    created_at: Number(event.created_at),
    phase: safeText(payload.phase, 64) ?? safeText(payload.to, 64),
    status: safeText(payload.status, 64),
    operation_key: safeText(payload.operation_key, 180),
    operation_type: safeText(payload.operation_type, 64),
    active_job: safeText(payload.active_job, 200),
    active_step: safeText(payload.active_step, 200),
    failed_job: safeText(payload.failed_job, 200),
    failed_step: safeText(payload.failed_step, 200),
    reason: safeText(payload.reason),
    candidate_disposition: safeText(payload.candidate_disposition, 32),
    source_train_id: safeText(payload.source_train_id, 100),
    source_run_id: safeText(payload.source_run_id, 100),
    source_evidence_id: safeText(payload.source_evidence_id, 100),
    source_evidence_type: safeText(payload.source_evidence_type, 100),
    evidence_uri: safeText(payload.evidence_uri, 1000),
    source_artifact_digest: safeText(payload.source_artifact_digest, 80),
    proof_digest: safeText(payload.proof_digest, 80),
    final_sha: safeText(payload.final_sha, 40)
  };
}

function baseEvidenceStatus(
  events: readonly ReleaseTrainEventRecord[],
  operations: readonly ReleaseOperationRecord[],
  candidates: readonly ReturnType<typeof candidateSummary>[]
) {
  const reused = events.find(
    (event) => event.event_type === 'BASE_CANARY_EVIDENCE_REUSED'
  );
  const reusePayload = metadata(reused?.payload_json);
  const baseOperation = operations
    .filter((operation) => operation.operation_type === 'base-canary-frontend')
    .sort((left, right) => right.attempt - left.attempt)[0];
  let decision: string;
  let summary: string;
  if (reused) {
    const carriedForward =
      reusePayload.source_evidence_type === 'BASE_EVIDENCE_PROMOTED';
    decision = carriedForward
      ? 'CARRIED_FORWARD_REUSED'
      : 'BASE_CANARY_EVIDENCE_REUSED';
    summary = carriedForward
      ? 'Base canary skipped: exact staging SHA and gate contract matched carried-forward evidence.'
      : 'Base canary skipped: exact staging SHA and gate contract matched fresh base-canary evidence.';
  } else if (baseOperation) {
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
      baseOperation.status
    );
    decision = terminal ? 'FRESH_EXECUTED' : 'FRESH_EXECUTING';
    summary = terminal
      ? `Base canary executed fresh for this train (${baseOperation.status}).`
      : 'Base canary is executing fresh for this train.';
  } else if (
    !candidates.some((candidate) => candidate.repository === 'frontend')
  ) {
    decision = 'NOT_REQUIRED';
    summary = 'No frontend candidate; a frontend base canary was not required.';
  } else {
    decision = 'FRESH_PENDING';
    summary =
      'No reusable exact evidence was selected; fresh validation is pending.';
  }
  const promotion = events.find((event) =>
    ['BASE_EVIDENCE_PROMOTED', 'BASE_EVIDENCE_PROMOTION_REJECTED'].includes(
      event.event_type
    )
  );
  const promotionPayload = metadata(promotion?.payload_json);
  return {
    decision,
    summary,
    canary_skipped: Boolean(reused),
    source_train_id: safeText(reusePayload.source_train_id, 100),
    source_run_id: safeText(reusePayload.source_run_id, 100),
    source_evidence_id: safeText(reusePayload.source_evidence_id, 100),
    source_evidence_type: safeText(reusePayload.source_evidence_type, 100),
    evidence_uri: safeText(reusePayload.evidence_uri, 1000),
    source_artifact_digest: safeText(reusePayload.source_artifact_digest, 80),
    source_workflow_runs: {
      preflight: {
        run_id: safeText(reusePayload.source_preflight_run_id, 100),
        run_url: safeText(reusePayload.source_preflight_run_url, 1000),
        artifact_digest: safeText(
          reusePayload.source_preflight_artifact_digest,
          80
        )
      },
      deployment: {
        run_id: safeText(reusePayload.source_deployment_run_id, 100),
        run_url: safeText(reusePayload.source_deployment_run_url, 1000),
        artifact_digest: safeText(
          reusePayload.source_deployment_artifact_digest,
          80
        )
      },
      e2e: {
        run_id: safeText(reusePayload.source_e2e_run_id, 100),
        run_url: safeText(reusePayload.source_e2e_run_url, 1000),
        artifact_digest: null
      }
    },
    promotion: promotion
      ? {
          status:
            promotion.event_type === 'BASE_EVIDENCE_PROMOTED'
              ? 'PROMOTED'
              : 'REJECTED',
          reason: safeText(promotionPayload.reason),
          final_sha: safeText(promotionPayload.final_sha, 40),
          proof_digest: safeText(promotionPayload.proof_digest, 80)
        }
      : null
  };
}

function failureOperation(
  operations: readonly ReleaseOperationRecord[]
): ReleaseOperationView | null {
  const failed = operations
    .filter((operation) => operation.status === 'FAILED')
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  return failed ? toOperationView(failed) : null;
}

function candidateSummary(
  item: ReleaseTrainItemRecord,
  candidate: ReleaseCandidateRecord | null,
  currentPhase: string,
  phaseStateValue: string,
  currentOperation: ReleaseOperationView | null
) {
  return {
    sequence: item.sequence,
    item_status: item.status,
    item_hold_reason: item.hold_reason,
    id: candidate?.id ?? item.candidate_id,
    repository: candidate?.repository ?? null,
    branch_name: candidate?.branch_name ?? null,
    head_sha: candidate?.head_sha ?? null,
    pr_number: candidate?.pr_number ?? null,
    status: candidate?.status ?? 'UNKNOWN',
    lifecycle_status: candidate?.status ?? 'UNKNOWN',
    current_phase: currentPhase,
    phase_state: phaseStateValue,
    operation_type: currentOperation?.operation_type ?? null,
    active_job: currentOperation?.active_job ?? null,
    active_step: currentOperation?.active_step ?? null,
    failed_job: currentOperation?.failed_job ?? null,
    failed_step: currentOperation?.failed_step ?? null,
    hold_reason: candidate?.hold_reason ?? null
  };
}

function supersedingBranchHead(candidate: ReleaseCandidateRecord): string | null {
  if (candidate.status !== 'SUPERSEDED') return null;
  const match = /^Branch moved to ([a-f0-9]{40})$/.exec(
    candidate.hold_reason ?? ''
  );
  return match?.[1] ?? null;
}

export function projectReleaseCandidate(candidate: ReleaseCandidateRecord) {
  const supersedingHead = supersedingBranchHead(candidate);
  const superseded = candidate.status === 'SUPERSEDED';
  return {
    ...candidate,
    immutable_head_sha: candidate.head_sha,
    immutable_validation_scope: 'EXACT_SHA',
    head_relation: superseded
      ? candidate.hold_reason === 'Branch moved to deleted'
        ? 'BRANCH_DELETED'
        : 'SUPERSEDED_BY_UNREGISTERED_HEAD'
      : candidate.status === 'STAGING_VALIDATED'
        ? 'VALIDATED_IMMUTABLE_SHA'
        : 'REGISTERED_IMMUTABLE_SHA',
    unregistered_branch_head_sha: supersedingHead,
    requires_new_readiness: superseded,
    status_summary: superseded
      ? supersedingHead
        ? `Historical immutable SHA; branch moved to unregistered head ${supersedingHead}`
        : 'Historical immutable SHA; branch no longer matches this readiness record'
      : candidate.status === 'STAGING_VALIDATED'
        ? 'Staging validation applies only to this immutable SHA'
        : 'Readiness applies only to this immutable SHA'
  };
}

function runningBaseIncident(
  operation: ReleaseOperationView | null
): Record<string, unknown> | null {
  if (
    operation?.phase !== 'BASE_CANARY_RUNNING' ||
    operation.health === 'FAILED'
  )
    return null;
  const stalled = operation.health === 'STALLED';
  const recommendedRecovery = stalled
    ? 'Inspect the linked workflow job and step. Retry only after GitHub reports the operation terminal or deterministic reconciliation proves it absent.'
    : 'No recovery is needed while the workflow is making progress.';
  return {
    severity: stalled ? 'WARNING' : 'INFO',
    title: 'Frontend base canary running',
    summary: `Frontend base canary running for staging SHA ${operation.expected_sha ?? 'unknown'}. Candidates have not been tested yet.`,
    attribution: 'PRE_EXISTING_BASE_CHECK',
    failed_gate: null,
    failed_job: null,
    failed_step: null,
    failing_suites: [],
    failing_tests: [],
    returned_candidates: [],
    quarantined_candidates: [],
    recommended_recovery: recommendedRecovery
  };
}

function failingSuiteNames(jest: Record<string, unknown>): string[] {
  if (!Array.isArray(jest.failing_suites)) return [];
  return jest.failing_suites
    .map((suite) => safeText(suite, 500))
    .filter((suite): suite is string => Boolean(suite))
    .slice(0, 50);
}

function failingTestNames(
  jest: Record<string, unknown>
): Array<{ suite: string; test: string }> {
  if (!Array.isArray(jest.failing_tests)) return [];
  return jest.failing_tests
    .map((test) => {
      const value = metadata(test);
      const suite = safeText(value.suite, 500);
      const name = safeText(value.test, 500);
      return suite && name ? { suite, test: name } : null;
    })
    .filter((test): test is { suite: string; test: string } => Boolean(test))
    .slice(0, 100);
}

function failureAttribution(
  baseFailure: boolean,
  quarantinedCount: number
): string {
  if (baseFailure) return 'PRE_EXISTING_BASE';
  if (quarantinedCount > 0) return 'DETERMINISTIC_CANDIDATE';
  return 'TRAIN_OR_ENVIRONMENT';
}

function recoveryRecommendation(
  baseFailure: boolean,
  quarantinedCount: number
): string {
  if (baseFailure)
    return 'Repair and validate the existing staging base, deploy that isolated repair, then resume the paused lane. Do not modify or blame queued candidates.';
  if (quarantinedCount > 0)
    return 'Fix the quarantined source branch, push a new immutable SHA, and mark the new SHA ready. Unrelated returned candidates may depart on a later train.';
  return 'Inspect the linked deterministic workflow evidence, repair the failing base, environment, or combined interaction, then resume the lane explicitly.';
}

function incidentSummary(
  train: ReleaseTrainRecord,
  candidates: readonly ReturnType<typeof candidateSummary>[],
  currentPhase: string,
  currentOperation: ReleaseOperationView | null,
  failedOperation: ReleaseOperationView | null,
  controls: readonly ReleaseBusControlRecord[]
) {
  if (train.status === 'COMPLETED') return null;
  const runningIncident = runningBaseIncident(currentOperation);
  if (runningIncident) return runningIncident;
  if (train.status !== 'FAILED' && !controlPaused(train, controls)) return null;
  const operation = failedOperation ?? currentOperation;
  const gateReport = metadata(operation?.gate_report);
  const jest = metadata(gateReport.jest);
  const baseFailure =
    operation?.phase === 'BASE_CANARY_RUNNING' ||
    /existing (?:staging |frontend |backend )?base failed/i.test(
      train.failure_reason ?? ''
    );
  const returnedCandidates = candidates
    .filter((candidate) => candidate.status !== 'QUARANTINED')
    .map((candidate) => candidate.id);
  const quarantinedCandidates = candidates
    .filter((candidate) => candidate.status === 'QUARANTINED')
    .map((candidate) => candidate.id);
  const retryState =
    gateReport.retryable === true
      ? train.status === 'FAILED'
        ? 'AUTOMATIC_RETRY_EXHAUSTED'
        : 'AUTOMATIC_RETRY_PENDING'
      : 'NOT_RETRYABLE';
  const summary = baseFailure
    ? `Existing staging base failed ${operation?.operation_type ?? 'the deterministic gate'} for SHA ${operation?.expected_sha ?? train.frontend_base_sha}. Candidates had not been tested. No candidate was blamed. ${train.target_lane} was paused.`
    : (safeText(train.failure_reason) ??
      `${train.target_lane} train failed and the lane was paused.`);
  return {
    severity: 'ERROR',
    title: baseFailure
      ? 'Existing staging base failed'
      : 'Release train paused',
    summary,
    phase: currentPhase,
    retry_state: retryState,
    attribution: failureAttribution(baseFailure, quarantinedCandidates.length),
    failed_gate: operation?.operation_type ?? null,
    failed_job: operation?.failed_job ?? null,
    failed_step: operation?.failed_step ?? null,
    failing_suites: failingSuiteNames(jest),
    failing_tests: failingTestNames(jest),
    returned_candidates: returnedCandidates,
    quarantined_candidates: baseFailure ? [] : quarantinedCandidates,
    candidate_dispositions: candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      hold_reason: candidate.hold_reason
    })),
    recommended_recovery: recoveryRecommendation(
      baseFailure,
      quarantinedCandidates.length
    )
  };
}

function phaseState(
  train: ReleaseTrainRecord,
  paused: boolean,
  currentOperation: ReleaseOperationView | null
): string {
  if (TERMINAL_TRAIN_STATUSES.has(train.status)) return train.status;
  if (paused) return 'PAUSED';
  if (currentOperation?.health === 'STALLED') return 'STALLED';
  return 'RUNNING';
}

function laneState(lane: ReleaseLaneRecord, now: number): string {
  if (lane.expires_at && Number(lane.expires_at) <= now) return 'EXPIRED';
  return 'ACTIVE';
}

function backendDeployStatus(operations: readonly ReleaseOperationRecord[]) {
  const allBackendOperations = operations.filter((operation) =>
    operation.operation_type.startsWith('deploy-backend-')
  );
  const latestByService = new Map<string, ReleaseOperationRecord>();
  for (const operation of allBackendOperations) {
    if (!operation.service) continue;
    const current = latestByService.get(operation.service);
    if (
      !current ||
      operation.attempt > current.attempt ||
      (operation.attempt === current.attempt &&
        Number(operation.updated_at) > Number(current.updated_at))
    ) {
      latestByService.set(operation.service, operation);
    }
  }
  const backendOperations = Array.from(latestByService.values()).sort(
    (left, right) => String(left.service).localeCompare(String(right.service))
  );
  const graphOperation = [...backendOperations]
    .sort((left, right) => Number(right.updated_at) - Number(left.updated_at))
    .find(
      (operation) =>
        Object.keys(
          metadata(
            metadata(operation.request_metadata_json).backend_deploy_graph
          )
        ).length > 0
    );
  if (!graphOperation) return null;
  const graph = metadata(
    metadata(graphOperation.request_metadata_json).backend_deploy_graph
  );
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const text = safeText(entry, 100);
          return text ? [text] : [];
        })
      : [];
  return {
    environment: graphOperation.environment,
    concurrency: Number(graph.concurrency) || null,
    active_layer: Number.isInteger(graph.active_layer)
      ? Number(graph.active_layer)
      : null,
    frontier: strings(graph.frontier),
    layers: Array.isArray(graph.layers)
      ? graph.layers.slice(0, 50).map(strings)
      : [],
    edges: Array.isArray(graph.edges)
      ? graph.edges.slice(0, 200).map(strings)
      : [],
    active_services: backendOperations
      .filter((operation) =>
        ['PENDING', 'DISPATCHED', 'RUNNING', 'AMBIGUOUS'].includes(
          operation.status
        )
      )
      .flatMap((operation) => (operation.service ? [operation.service] : [])),
    succeeded_services: backendOperations
      .filter((operation) => operation.status === 'SUCCEEDED')
      .flatMap((operation) => (operation.service ? [operation.service] : [])),
    failed_services: backendOperations
      .filter((operation) => ['FAILED', 'CANCELLED'].includes(operation.status))
      .flatMap((operation) => (operation.service ? [operation.service] : []))
  };
}

export function buildReleaseTrainOverview(input: {
  readonly train: ReleaseTrainRecord;
  readonly items: readonly ReleaseTrainItemRecord[];
  readonly candidates: readonly (ReleaseCandidateRecord | null)[];
  readonly operations: readonly ReleaseOperationRecord[];
  readonly events: readonly ReleaseTrainEventRecord[];
  readonly lanes: readonly ReleaseLaneRecord[];
  readonly controls: readonly ReleaseBusControlRecord[];
  readonly now?: number;
}) {
  const now = input.now ?? Date.now();
  const paused = controlPaused(input.train, input.controls);
  const currentRecord = selectCurrentOperation(input.operations);
  const currentOperation = currentRecord
    ? toOperationView(currentRecord, now)
    : null;
  const operationViews = input.operations.map((operation) =>
    toOperationView(operation, now)
  );
  const backendPreflightOperations = operationViews.filter(
    (operation) => operation.operation_type === 'preflight-backend'
  );
  const backendPreflightOperation =
    backendPreflightOperations[backendPreflightOperations.length - 1];
  const currentPhase = currentTrainPhase(
    input.train,
    input.operations,
    paused
  );
  const currentPhaseState = phaseState(
    input.train,
    paused,
    currentOperation
  );
  const candidates = input.items.map((item, index) =>
    candidateSummary(
      item,
      input.candidates[index] ?? null,
      currentPhase,
      currentPhaseState,
      currentOperation
    )
  );
  const ownedLanes = input.lanes
    .filter(
      (lane) => lane.train_id === input.train.id || lane.lease_owner !== null
    )
    .map((lane) => ({
      name: lane.name,
      train_id: lane.train_id,
      lease_owner: lane.lease_owner,
      heartbeat_at: lane.heartbeat_at,
      expires_at: lane.expires_at,
      state: laneState(lane, now)
    }));
  const workerHeartbeat = ownedLanes
    .filter((lane) => lane.train_id === input.train.id && lane.heartbeat_at)
    .map((lane) => Number(lane.heartbeat_at))
    .sort((a, b) => b - a)[0];
  const meaningfulEvent = input.events.find(
    (event) => event.event_type !== 'TRAIN_WAITING'
  );
  const failed = failureOperation(input.operations);
  return {
    ...input.train,
    phase: currentPhase,
    phase_state: currentPhaseState,
    elapsed_ms: Math.max(
      0,
      (input.train.completed_at ?? now) -
        (input.train.started_at ?? input.train.created_at)
    ),
    current_operation: currentOperation,
    active_operations: operationViews.filter((operation) =>
      ['PENDING', 'DISPATCHED', 'RUNNING', 'AMBIGUOUS'].includes(
        operation.status
      )
    ),
    backend_preflight_evidence:
      backendPreflightOperation?.gate_report &&
      typeof backendPreflightOperation.gate_report === 'object'
        ? ((backendPreflightOperation.gate_report as Record<string, unknown>)
            .backend_evidence ?? null)
        : null,
    backend_deploy: backendDeployStatus(input.operations),
    wait_reason: latestWaitReason(input.events, currentOperation),
    latest_worker_heartbeat_at: workerHeartbeat ?? null,
    leases: ownedLanes,
    last_progress_event: meaningfulEvent ? eventView(meaningfulEvent) : null,
    timeline: input.events.slice(0, 100).map(eventView),
    included_candidates: candidates,
    base_evidence: baseEvidenceStatus(
      input.events,
      input.operations,
      candidates
    ),
    incident: incidentSummary(
      input.train,
      candidates,
      currentPhase,
      currentOperation,
      failed,
      input.controls
    )
  };
}

export async function getReleaseTrainOverview(train: ReleaseTrainRecord) {
  const [items, operations, events, lanes, controls] = await Promise.all([
    releaseBusRepository.listTrainItems(train.id, {}),
    releaseBusRepository.listTrainOperations(train.id, {}),
    releaseBusRepository.listTrainEvents(train.id, 100, {}),
    releaseBusRepository.listLanes({}),
    releaseBusRepository.listControls({})
  ]);
  const candidateRows = await releaseBusRepository.findCandidatesByIds(
    items.map((item) => item.candidate_id),
    {}
  );
  const candidatesById = new Map(
    candidateRows.map((candidate) => [candidate.id, candidate])
  );
  const candidates = items.map(
    (item) => candidatesById.get(item.candidate_id) ?? null
  );
  return buildReleaseTrainOverview({
    train,
    items,
    candidates,
    operations,
    events,
    lanes,
    controls
  });
}
