import { createHash } from 'node:crypto';
import {
  ReleaseBusV2BaselineAdoptionError,
  ReleaseBusV2BaselineAdoptionService,
  type ReleaseBusV2BaselineAdoptionInput,
  type ReleaseBusV2BaselineAutomaticE2EDecisionInput,
  type ReleaseBusV2BaselineBackendDeploymentEventInput
} from '@/releaseBusV2/release-bus-v2.baseline-adoption';

const NOW = 2_000_000_000_000;
const FRONTEND_SHA = 'a'.repeat(40);
const BACKEND_SHA = 'b'.repeat(40);
const CANDIDATE_SHA = 'c'.repeat(40);
const INTENT_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_INTENT_ID = '10000000-0000-4000-8000-000000000002';
const CANDIDATE_ID = '20000000-0000-4000-8000-000000000002';
const FRONTEND_E2E_RUN_ID = '91000';
const FRONTEND_DEPLOY_RUN_ID = '92000';
const BACKEND_DEPLOY_RUN_ID = '93000';
const OTHER_BACKEND_DEPLOY_RUN_ID = '93001';
const BOUND_E2E_RUN_ID = '94000';

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
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

function controls() {
  return [
    {
      scope: 'ALL',
      paused: false,
      reason: null,
      github_actor: null,
      updated_at: NOW,
      row_version: 1
    },
    {
      scope: 'PRODUCTION',
      paused: true,
      reason: 'manual fallback',
      github_actor: 'owner',
      updated_at: NOW,
      row_version: 2
    },
    {
      scope: 'STAGING',
      paused: true,
      reason: 'manual fallback',
      github_actor: 'owner',
      updated_at: NOW,
      row_version: 3
    }
  ];
}

function candidate() {
  return {
    id: CANDIDATE_ID,
    repository: 'frontend',
    pr_number: 42,
    branch_name: 'feature/exact',
    head_sha: CANDIDATE_SHA,
    requested_by: 'developer',
    status: 'READY_FOR_PRODUCTION',
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: 'historical-train',
    staging_validated_manifest_id: 'historical-manifest',
    staging_live_state: 'NOT_LIVE',
    staging_live_manifest_id: null,
    staging_admitted_at: null,
    staging_live_updated_at: null,
    staging_transition_request: null,
    staging_transition_requested_at: null,
    staging_transition_requested_by: null,
    staging_transition_reason: null,
    production_requested_at: 123,
    production_requested_by: 'developer',
    production_selection_id: '30000000-0000-4000-8000-000000000003',
    hold_reason: 'preserve me',
    superseded_at: null,
    created_at: NOW,
    updated_at: NOW,
    row_version: 7
  };
}

function input(
  withCandidate = false,
  idempotencyKey = INTENT_ID
): ReleaseBusV2BaselineAdoptionInput {
  return {
    idempotency_key: idempotencyKey,
    reason: 'Adopt the exact manually deployed staging pair',
    expires_at: NOW + 30 * 60 * 1000,
    expected_staging_state_row_version: 23,
    expected_frontend_ref: '1a-staging',
    expected_frontend_sha: FRONTEND_SHA,
    expected_frontend_runtime_sha: FRONTEND_SHA,
    expected_backend_ref: '1a-staging',
    expected_backend_sha: BACKEND_SHA,
    expected_backend_runtime_sha: BACKEND_SHA,
    required_backend_units: [{ service: 'api', expected_sha: BACKEND_SHA }],
    candidates: withCandidate
      ? [
          {
            candidate_id: CANDIDATE_ID,
            repository: 'frontend',
            pr_number: 42,
            head_sha: CANDIDATE_SHA,
            row_version: 7
          }
        ]
      : []
  };
}

function automaticInput(): ReleaseBusV2BaselineAutomaticE2EDecisionInput {
  return {
    e2e_workflow_run_id: FRONTEND_E2E_RUN_ID,
    deploy_workflow_run_id: FRONTEND_DEPLOY_RUN_ID,
    deployed_ref: '1a-staging',
    deployed_sha: FRONTEND_SHA
  };
}

function backendInput(
  workflowRunId = BACKEND_DEPLOY_RUN_ID
): ReleaseBusV2BaselineBackendDeploymentEventInput {
  return {
    environment: 'staging',
    service: 'api',
    workflow_run_id: workflowRunId,
    workflow_run_attempt: 1,
    source_ref: '1a-staging',
    source_sha: BACKEND_SHA,
    status: 'SUCCEEDED'
  };
}

class FakeRepository {
  public controls = controls();
  public locks = [
    {
      name: 'production-environment',
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: NOW,
      row_version: 1
    },
    {
      name: 'scheduler',
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: NOW,
      row_version: 1
    },
    {
      name: 'staging-environment',
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: NOW,
      row_version: 1
    }
  ];
  public state = {
    id: 'current',
    status: 'CLEAN_MAIN',
    current_manifest_id: null,
    last_validated_manifest_id: 'old-manifest',
    frontend_sha: 'd'.repeat(40),
    backend_sha: 'e'.repeat(40),
    frontend_staging_ref_sha: 'd'.repeat(40),
    backend_staging_ref_sha: 'e'.repeat(40),
    clean_main: true,
    last_transition_train_id: null,
    updated_at: NOW,
    row_version: 23
  };
  public trains: any[] = [];
  public manifests: any[] = [];
  public operations: any[] = [];
  public candidates: any[] = [];
  public events: any[] = [];
  public failCandidateUpdate = false;

  public listControls = jest.fn(async () => this.controls);
  public listLocks = jest.fn(async () => this.locks);
  public listActiveTrains = jest.fn(async () =>
    this.trains.filter(
      ({ status }) =>
        ![
          'STAGING_VALIDATED',
          'STAGING_ROLLBACK_FAILED',
          'PRODUCTION_DEPLOYED',
          'FAILED',
          'CANCELLED'
        ].includes(status)
    )
  );
  public listNonterminalOperationsForLanes = jest.fn(async (lanes: string[]) =>
    this.operations.filter(
      (operation) =>
        !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(operation.status) &&
        lanes.includes(
          this.trains.find(({ id }) => id === operation.train_id)?.lane
        )
    )
  );
  public getStagingState = jest.fn(async () => this.state);
  public listLiveStagingCandidates = jest.fn(async () =>
    this.candidates.filter(
      ({ staging_live_state }) => staging_live_state === 'LIVE'
    )
  );
  public findCandidateById = jest.fn(async (id: string) =>
    this.candidates.find((item) => item.id === id)
  );
  public findTrain = jest.fn(async (id: string) =>
    this.trains.find((item) => item.id === id)
  );
  public findManifest = jest.fn(async (id: string) =>
    this.manifests.find((item) => item.id === id)
  );
  public findOperation = jest.fn(async (key: string) =>
    this.operations.find((item) => item.idempotency_key === key)
  );
  public listOperations = jest.fn(async (trainId: string) =>
    this.operations.filter((item) => item.train_id === trainId)
  );
  public findEvent = jest.fn(async (id: string) =>
    this.events.find((item) => item.id === id)
  );
  public listEventsByTypes = jest.fn(
    async (
      eventTypes: readonly string[],
      limit: number,
      _ctx: unknown,
      _forUpdate: boolean,
      createdAtGte?: number
    ) =>
      this.events
        .filter(
          ({ event_type, created_at }) =>
            eventTypes.includes(event_type) &&
            (createdAtGte === undefined || created_at >= createdAtGte)
        )
        .slice(0, limit)
  );
  public appendEvent = jest.fn(async (event: any) => {
    if (this.events.some(({ id }) => id === event.eventId)) return;
    this.events.push({
      id: event.eventId,
      train_id: event.trainId ?? null,
      candidate_id: event.candidateId ?? null,
      operation_id: event.operationId ?? null,
      event_type: event.eventType,
      actor: event.actor,
      payload_json: event.payload ?? null,
      created_at: NOW
    });
  });

  public executeNativeQueriesInTransaction = jest.fn(async (work: any) => {
    const snapshot = structuredClone({
      controls: this.controls,
      locks: this.locks,
      state: this.state,
      trains: this.trains,
      manifests: this.manifests,
      operations: this.operations,
      candidates: this.candidates,
      events: this.events
    });
    try {
      return await work({});
    } catch (error) {
      this.controls = snapshot.controls;
      this.locks = snapshot.locks;
      this.state = snapshot.state;
      this.trains = snapshot.trains;
      this.manifests = snapshot.manifests;
      this.operations = snapshot.operations;
      this.candidates = snapshot.candidates;
      this.events = snapshot.events;
      throw error;
    }
  });

  public createTrain = jest.fn(async (request: any) => {
    const existing = this.trains.find(({ id }) => id === request.trainId);
    if (existing) return existing;
    const train = {
      id: request.trainId,
      lane: request.lane,
      status: request.initialStatus,
      frontend_base_sha: request.frontendBaseSha,
      backend_base_sha: request.backendBaseSha,
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      manifest_id: null,
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: request.stagingPolicy,
      staging_baseline_manifest_id: request.stagingBaselineManifestId,
      staging_transition_json: request.stagingTransition,
      qualification_policy: null,
      qualification_evidence_json: null,
      failure_class: null,
      failure_message: null,
      recovery_message: null,
      phase_started_at: NOW,
      completed_at: null,
      created_at: NOW,
      updated_at: NOW,
      row_version: 1
    };
    this.trains.push(train);
    return train;
  });

  public acquireLock = jest.fn(
    async (
      name: string,
      ownerTrainId: string,
      leaseOwner: string,
      ttl: number
    ) => {
      const lock = this.locks.find((item) => item.name === name);
      if (!lock || lock.lease_token) return null;
      Object.assign(lock, {
        owner_train_id: ownerTrainId,
        lease_owner: leaseOwner,
        lease_token: 'lease-token',
        heartbeat_at: NOW,
        expires_at: NOW + ttl,
        row_version: lock.row_version + 1
      });
      return lock;
    }
  );

  public createManifest = jest.fn(async (request: any) => {
    const manifest = {
      id: '50000000-0000-4000-8000-000000000005',
      ...request,
      created_at: NOW,
      updated_at: NOW
    };
    this.manifests.push(manifest);
    return manifest;
  });

  public updateTrain = jest.fn(
    async (id: string, rowVersion: number, fields: any) => {
      const train = this.trains.find((item) => item.id === id);
      if (!train || train.row_version !== rowVersion) return false;
      Object.assign(train, {
        status: fields.status ?? train.status,
        frontend_composed_sha:
          fields.frontendComposedSha ?? train.frontend_composed_sha,
        backend_composed_sha:
          fields.backendComposedSha ?? train.backend_composed_sha,
        manifest_id: fields.manifestId ?? train.manifest_id,
        failure_class: fields.failureClass ?? train.failure_class,
        failure_message: fields.failureMessage ?? train.failure_message,
        recovery_message: fields.recoveryMessage ?? train.recovery_message,
        completed_at: fields.completedAt ?? train.completed_at,
        row_version: train.row_version + 1
      });
      return true;
    }
  );

  public getOrCreateOperation = jest.fn(async (request: any) => {
    const existing = this.operations.find(
      ({ idempotency_key }) => idempotency_key === request.idempotencyKey
    );
    if (existing) return existing;
    const operation = {
      id: '60000000-0000-4000-8000-000000000006',
      idempotency_key: request.idempotencyKey,
      train_id: request.trainId,
      operation_type: request.operationType,
      repository: request.repository,
      service: request.service,
      environment: request.environment,
      expected_sha: request.expectedSha,
      artifact_digest: request.artifactDigest,
      external_id: null,
      status: 'PENDING',
      attempt: 1,
      max_attempts: request.maxAttempts,
      request_json: request.request,
      result_json: null,
      next_retry_at: null,
      failure_class: null,
      failure_message: null,
      created_at: NOW,
      updated_at: NOW,
      completed_at: null,
      row_version: 1
    };
    this.operations.push(operation);
    return operation;
  });

  public updateOperation = jest.fn(
    async (id: string, rowVersion: number, fields: any) => {
      const operation = this.operations.find((item) => item.id === id);
      if (!operation || operation.row_version !== rowVersion) return false;
      Object.assign(operation, {
        status: fields.status,
        external_id:
          fields.externalId === undefined
            ? operation.external_id
            : fields.externalId,
        result_json:
          fields.result === undefined ? operation.result_json : fields.result,
        next_retry_at: fields.nextRetryAt ?? null,
        failure_class: fields.failureClass ?? null,
        failure_message: fields.failureMessage ?? null,
        attempt: fields.attempt ?? operation.attempt,
        completed_at: fields.completedAt ?? null,
        row_version: operation.row_version + 1
      });
      return true;
    }
  );

  public updateStagingState = jest.fn(
    async (rowVersion: number, fields: any) => {
      if (this.state.row_version !== rowVersion) return false;
      Object.assign(this.state, {
        status: fields.status,
        current_manifest_id: fields.currentManifestId,
        last_validated_manifest_id: fields.lastValidatedManifestId,
        frontend_sha: fields.frontendSha,
        backend_sha: fields.backendSha,
        frontend_staging_ref_sha: fields.frontendStagingRefSha,
        backend_staging_ref_sha: fields.backendStagingRefSha,
        clean_main: fields.cleanMain,
        last_transition_train_id: fields.lastTransitionTrainId,
        row_version: this.state.row_version + 1
      });
      return true;
    }
  );

  public updateCandidate = jest.fn(
    async (id: string, rowVersion: number, fields: any) => {
      if (this.failCandidateUpdate) return false;
      const item = this.candidates.find((row) => row.id === id);
      if (!item || item.row_version !== rowVersion) return false;
      Object.assign(item, {
        status: fields.status,
        staging_validated_train_id: fields.stagingValidatedTrainId,
        staging_validated_manifest_id: fields.stagingValidatedManifestId,
        staging_live_state: fields.stagingLiveState,
        staging_live_manifest_id: fields.stagingLiveManifestId,
        staging_admitted_at: fields.stagingAdmittedAt,
        staging_live_updated_at: fields.stagingLiveUpdatedAt,
        row_version: item.row_version + 1
      });
      return true;
    }
  );

  public updateManifestStatus = jest.fn(
    async (id: string, status: string, e2eRunId: string | null) => {
      const manifest = this.manifests.find((item) => item.id === id);
      Object.assign(manifest, {
        status,
        e2e_run_id: e2eRunId ?? manifest.e2e_run_id
      });
    }
  );

  public releaseLock = jest.fn(async (name: string, token: string) => {
    const lock = this.locks.find((item) => item.name === name);
    if (!lock || lock.lease_token !== token) return false;
    Object.assign(lock, {
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      row_version: lock.row_version + 1
    });
    return true;
  });
}

function frontendE2EIdentity() {
  return {
    actor: 'github-actions[bot]',
    attempt: 1,
    conclusion: null,
    event: 'workflow_run',
    headBranch: 'main',
    headSha: FRONTEND_SHA,
    name: 'Staging E2E [automatic]',
    path: '.github/workflows/staging-e2e.yml',
    displayTitle: 'Staging E2E [automatic]',
    status: 'in_progress'
  };
}

function frontendDeployIdentity() {
  return {
    actor: 'owner',
    attempt: 1,
    conclusion: 'success',
    event: 'push',
    headBranch: '1a-staging',
    headSha: FRONTEND_SHA,
    name: 'Web Deploy - STAGING',
    path: '.github/workflows/deploy-staging.yml',
    displayTitle: 'Web Deploy - STAGING',
    status: 'completed'
  };
}

function backendDeployIdentity(runId: string) {
  return {
    actor: 'owner',
    attempt: 1,
    conclusion: null,
    event: 'workflow_dispatch',
    headBranch: '1a-staging',
    headSha: BACKEND_SHA,
    name: 'Deploy a service',
    path: '.github/workflows/deploy.yml',
    displayTitle: 'Deploy api to staging [manual]',
    status: 'in_progress',
    runId
  };
}

function harness(options?: {
  withCandidate?: boolean;
  productionBusy?: boolean;
}) {
  const repository = new FakeRepository();
  if (options?.withCandidate) repository.candidates.push(candidate());
  if (options?.productionBusy) {
    repository.trains.push({
      id: '70000000-0000-4000-8000-000000000007',
      lane: 'PRODUCTION',
      status: 'PRODUCTION_DEPLOYING'
    });
    Object.assign(repository.locks[0], {
      owner_train_id: '70000000-0000-4000-8000-000000000007',
      lease_owner: 'production-owner',
      lease_token: 'production-token',
      heartbeat_at: NOW,
      expires_at: NOW + 60_000
    });
  }
  let now = NOW;
  const refs = { frontend: FRONTEND_SHA, backend: BACKEND_SHA };
  const runtimes = { frontend: FRONTEND_SHA, backend: BACKEND_SHA };
  const identities: Record<string, any> = {
    [FRONTEND_E2E_RUN_ID]: frontendE2EIdentity(),
    [FRONTEND_DEPLOY_RUN_ID]: frontendDeployIdentity(),
    [BACKEND_DEPLOY_RUN_ID]: backendDeployIdentity(BACKEND_DEPLOY_RUN_ID),
    [OTHER_BACKEND_DEPLOY_RUN_ID]: backendDeployIdentity(
      OTHER_BACKEND_DEPLOY_RUN_ID
    )
  };
  const deps = {
    getMode: () => 'PRODUCTION',
    now: () => now,
    resolveStagingRefs: jest.fn(async () => refs),
    readRuntimeShas: jest.fn(async () => runtimes),
    readFrontendRuntimeSha: jest.fn(async () => runtimes.frontend),
    readBackendRuntimeSha: jest.fn(async () => runtimes.backend),
    waitForBackendRuntimeRetry: jest.fn(async () => undefined),
    hasActiveStagingWorkflow: jest.fn(async () => false),
    refContainsCommit: jest.fn(async () => true),
    getWorkflowRunIdentity: jest.fn(
      async (_repository: string, runId: string) => identities[runId]
    )
  };
  let dispatchCount = 0;
  const operations = {
    reconcileWorkflow: jest.fn(async (spec: any) => {
      const operation = repository.operations.find(
        ({ idempotency_key }) => idempotency_key === spec.idempotencyKey
      );
      if (operation.status === 'PENDING') {
        operation.status = 'DISPATCHED';
        operation.external_id = BOUND_E2E_RUN_ID;
        operation.row_version += 1;
        dispatchCount += 1;
      }
      return operation;
    })
  };
  const service = new ReleaseBusV2BaselineAdoptionService(
    repository as any,
    deps as any,
    operations as any
  );
  return {
    repository,
    deps,
    refs,
    runtimes,
    identities,
    operations,
    service,
    dispatchCount: () => dispatchCount,
    setNow: (value: number) => {
      now = value;
    }
  };
}

type Harness = ReturnType<typeof harness>;

async function prepare(context: Harness, withCandidate = false) {
  return context.service.execute(input(withCandidate), 'owner');
}

async function freeze(
  context: Harness,
  last: 'frontend' | 'backend' = 'frontend'
) {
  if (last === 'frontend') {
    await context.service.recordBackendDeployment(backendInput());
    return context.service.decideAutomaticE2E(automaticInput());
  }
  await context.service.decideAutomaticE2E(automaticInput());
  return context.service.recordBackendDeployment(backendInput());
}

function succeedBoundE2E(context: Harness) {
  Object.assign(context.repository.operations[0], {
    status: 'SUCCEEDED',
    external_id: BOUND_E2E_RUN_ID,
    failure_message: null,
    row_version: context.repository.operations[0].row_version + 1
  });
}

describe('ReleaseBusV2BaselineAdoptionService', () => {
  it('accepts only the API unit whose deployed commit has an independent runtime proof', async () => {
    const context = harness();
    await expect(
      context.service.execute(
        {
          ...input(),
          required_backend_units: [
            { service: 'releaseBus', expected_sha: BACKEND_SHA }
          ]
        },
        'owner'
      )
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.events).toHaveLength(0);
    expect(context.repository.trains).toHaveLength(0);
  });

  it('prepares only an immutable expiring intent without a synthetic train, lock, operation, or state change', async () => {
    const context = harness();
    const result = await prepare(context);
    expect(result).toMatchObject({
      adoption_id: INTENT_ID,
      status: 'WAITING_FOR_DEPLOYMENTS',
      manifest_id: null,
      operation_id: null,
      reused: false
    });
    expect(context.repository.events).toHaveLength(1);
    expect(context.repository.events[0]).toMatchObject({
      id: INTENT_ID,
      event_type: 'EXACT_STAGING_BASELINE_ADOPTION_INTENT_PREPARED'
    });
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.manifests).toHaveLength(0);
    expect(context.repository.operations).toHaveLength(0);
    expect(context.repository.locks[2].lease_token).toBeNull();
    expect(context.repository.state.row_version).toBe(23);
  });

  it('prepares before target refs and runtimes move, then requires the exact deployed pair before freeze', async () => {
    const context = harness();
    context.refs.frontend = 'd'.repeat(40);
    context.refs.backend = 'e'.repeat(40);
    context.runtimes.frontend = 'd'.repeat(40);
    context.runtimes.backend = 'e'.repeat(40);
    await expect(prepare(context)).resolves.toMatchObject({
      status: 'WAITING_FOR_DEPLOYMENTS'
    });
    expect(context.repository.trains).toHaveLength(0);

    context.refs.frontend = FRONTEND_SHA;
    context.refs.backend = BACKEND_SHA;
    context.runtimes.frontend = FRONTEND_SHA;
    context.runtimes.backend = BACKEND_SHA;
    await freeze(context);
    expect(context.repository.manifests).toHaveLength(1);
    expect(context.dispatchCount()).toBe(1);
  });

  it('preserves ordinary legacy automatic E2E when no pending intent exists', async () => {
    const context = harness();
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toEqual({
      decision: 'LEGACY',
      adoption_id: null,
      operation_key: null,
      expires_at: null
    });
    expect(context.deps.getWorkflowRunIdentity).not.toHaveBeenCalled();
    expect(context.repository.events).toHaveLength(0);
  });

  it('records exact frontend evidence and DEFERRED without executing or dispatching an expensive suite', async () => {
    const context = harness();
    await prepare(context);
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toMatchObject({
      decision: 'DEFERRED',
      adoption_id: INTENT_ID,
      manifest_ready: false
    });
    expect(
      context.repository.events.map(({ event_type }) => event_type)
    ).toEqual(
      expect.arrayContaining([
        'EXACT_STAGING_BASELINE_FRONTEND_DEPLOYMENT_VERIFIED',
        'EXACT_STAGING_BASELINE_AUTOMATIC_E2E_DEFERRED'
      ])
    );
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.operations).toHaveLength(0);
    expect(context.operations.reconcileWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    'Staging E2E [automatic]',
    `Staging E2E [rb2:${INTENT_ID}:baseline-adoption-e2e:staging:a1]`
  ])('accepts the real trusted GitHub run.name %s', async (name) => {
    const context = harness();
    Object.assign(context.identities[FRONTEND_E2E_RUN_ID], {
      name,
      displayTitle: name
    });
    await prepare(context);
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toMatchObject({
      decision: 'DEFERRED',
      adoption_id: INTENT_ID,
      manifest_ready: false
    });
  });

  it.each([
    'Staging E2E',
    'Staging E2E [Automatic]',
    'Staging E2E [automatic]-lookalike',
    'Staging E2E [release-bus:train:e2e:a1]',
    'Staging E2E [rb2:train:e2e:a0]',
    `Staging E2E [rb2:${INTENT_ID}:baseline-adoption-e2e:staging:a1:a1]`,
    `Staging E2E [rb2:${'x'.repeat(176)}:a1]`
  ])('rejects the lookalike or untrusted GitHub run.name %s', async (name) => {
    const context = harness();
    Object.assign(context.identities[FRONTEND_E2E_RUN_ID], {
      name,
      displayTitle: name
    });
    await prepare(context);
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.manifests).toHaveLength(0);
    expect(context.repository.operations).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
  });

  it('reconciles a frozen legacy once-suffixed operation without dispatching another E2E', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    const prepared = context.repository.events.find(
      ({ id }) => id === INTENT_ID
    ).payload_json;
    const { intent_identity_sha256: _oldIdentity, ...core } = prepared;
    core.operation_key = `rb2:${INTENT_ID}:baseline-adoption-e2e:staging:a1`;
    Object.assign(prepared, {
      ...core,
      intent_identity_sha256: sha256(core)
    });
    Object.assign(context.repository.operations[0], {
      idempotency_key: core.operation_key,
      status: 'FAILED',
      failure_message: 'Legacy double-suffixed workflow failed'
    });

    await expect(
      context.service.recordBackendDeployment(backendInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.operations.reconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: core.operation_key })
    );
    expect(context.dispatchCount()).toBe(1);
    expect(context.repository.operations).toHaveLength(1);
    expect(context.repository.trains[0].status).toBe('FAILED');
    expect(context.repository.locks[2].lease_token).toBeNull();
  });

  it.each(['frontend', 'backend'] as const)(
    'freezes the immutable manifest when %s is the last exact deployment and dispatches one bound E2E',
    async (last) => {
      const context = harness();
      await prepare(context);
      await expect(freeze(context, last)).resolves.toMatchObject(
        last === 'frontend'
          ? { decision: 'DEFERRED', manifest_ready: true }
          : { outcome: 'E2E_DISPATCHED' }
      );
      expect(context.repository.trains).toHaveLength(1);
      expect(context.repository.manifests).toHaveLength(1);
      expect(context.repository.operations).toHaveLength(1);
      expect(context.dispatchCount()).toBe(1);
      expect(context.repository.state.row_version).toBe(23);
      expect(context.repository.operations[0]).toMatchObject({
        operation_type: 'E2E_STAGING',
        idempotency_key: `rb2:${INTENT_ID}:baseline-adoption-e2e:staging`,
        expected_sha: FRONTEND_SHA,
        max_attempts: 1,
        status: 'DISPATCHED',
        external_id: BOUND_E2E_RUN_ID
      });
      expect(context.operations.reconcileWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: `rb2:${INTENT_ID}:baseline-adoption-e2e:staging`,
          workflow: 'staging-e2e.yml',
          ref: '1a-staging',
          artifactDigest: context.repository.manifests[0].identity_sha256,
          inputs: expect.objectContaining({
            pack: 'all',
            release_manifest_id: context.repository.manifests[0].id,
            release_manifest_identity_sha256:
              context.repository.manifests[0].identity_sha256
          })
        })
      );
    }
  );

  it('keeps exact callbacks and dispatch retries idempotent while rejecting a different callback identity', async () => {
    const context = harness();
    await prepare(context);
    await context.service.recordBackendDeployment(backendInput());
    await context.service.recordBackendDeployment(backendInput());
    await context.service.decideAutomaticE2E(automaticInput());
    await context.service.decideAutomaticE2E(automaticInput());
    await context.service.recordBackendDeployment(backendInput());
    expect(context.repository.operations).toHaveLength(1);
    expect(context.dispatchCount()).toBe(1);
    expect(
      context.repository.events.filter(
        ({ event_type }) =>
          event_type === 'EXACT_STAGING_BASELINE_BACKEND_UNIT_VERIFIED'
      )
    ).toHaveLength(1);

    const conflict = harness();
    await prepare(conflict);
    await conflict.service.recordBackendDeployment(backendInput());
    await expect(
      conflict.service.recordBackendDeployment(
        backendInput(OTHER_BACKEND_DEPLOY_RUN_ID)
      )
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(conflict.repository.state.row_version).toBe(23);
    expect(conflict.repository.trains).toHaveLength(0);
  });

  it('freezes from newly inserted immutable evidence through the writer when the replica is stale', async () => {
    const context = harness();
    await prepare(context);
    await context.service.recordBackendDeployment(backendInput());
    context.repository.findEvent.mockImplementation(
      async (
        id: string,
        ctx?: { connection?: unknown },
        _forUpdate = false,
        forceWrite = false
      ) =>
        ctx?.connection || forceWrite
          ? context.repository.events.find((item) => item.id === id)
          : undefined
    );

    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toMatchObject({
      decision: 'DEFERRED',
      manifest_ready: true
    });
    expect(
      context.repository.events.filter(({ event_type }) =>
        [
          'EXACT_STAGING_BASELINE_FRONTEND_DEPLOYMENT_VERIFIED',
          'EXACT_STAGING_BASELINE_AUTOMATIC_E2E_DEFERRED'
        ].includes(event_type)
      )
    ).toHaveLength(2);
    expect(
      context.repository.events.some(
        ({ event_type }) =>
          event_type === 'EXACT_STAGING_BASELINE_ADOPTION_FAILED'
      )
    ).toBe(false);
    expect(context.dispatchCount()).toBe(1);
  });

  it('dispatches from the writer when the frozen train and manifest are not yet visible on a replica', async () => {
    const context = harness();
    await prepare(context);
    await context.service.recordBackendDeployment(backendInput());
    context.repository.findTrain.mockImplementation(
      async (
        id: string,
        _ctx?: unknown,
        forUpdate = false,
        forceWrite = false
      ) =>
        forUpdate || forceWrite
          ? context.repository.trains.find((item) => item.id === id)
          : undefined
    );
    context.repository.findManifest.mockImplementation(
      async (id: string, _ctx?: unknown, forceWrite = false) =>
        forceWrite
          ? context.repository.manifests.find((item) => item.id === id)
          : undefined
    );

    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toMatchObject({
      decision: 'DEFERRED',
      manifest_ready: true
    });
    expect(context.repository.findTrain).toHaveBeenCalledWith(
      INTENT_ID,
      {},
      false,
      true
    );
    expect(context.repository.findManifest).toHaveBeenCalledWith(
      context.repository.manifests[0].id,
      {},
      true
    );
    expect(context.dispatchCount()).toBe(1);
  });

  it('fails ambiguous and malformed intent lookup closed without partial adoption', async () => {
    const context = harness();
    const other = harness();
    await prepare(context);
    await other.service.execute(input(false, OTHER_INTENT_ID), 'owner');
    context.repository.events.push(structuredClone(other.repository.events[0]));
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
    expect(
      context.repository.events.filter(
        ({ event_type }) =>
          event_type === 'EXACT_STAGING_BASELINE_ADOPTION_FAILED'
      )
    ).toHaveLength(2);

    const malformed = harness();
    await prepare(malformed);
    malformed.repository.events[0].payload_json.reason = 'tampered';
    await expect(
      malformed.service.decideAutomaticE2E(automaticInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(malformed.repository.trains).toHaveLength(0);
    expect(malformed.repository.state.row_version).toBe(23);
  });

  it('fails closed when the bounded lifecycle scan cannot prove uniqueness', async () => {
    const context = harness();
    context.repository.events = Array.from({ length: 2000 }, (_, index) => ({
      id: `event-${index}`,
      train_id: null,
      candidate_id: null,
      operation_id: null,
      event_type: 'EXACT_STAGING_BASELINE_ADOPTION_FAILED',
      actor: 'release-bus-v2',
      payload_json: {},
      created_at: NOW - index
    }));
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.state.row_version).toBe(23);
    expect(context.repository.trains).toHaveLength(0);
  });

  it('ignores immutable terminal lifecycle history older than any valid intent', async () => {
    const context = harness();
    context.repository.events = Array.from({ length: 2000 }, (_, index) => ({
      id: `old-event-${index}`,
      train_id: null,
      candidate_id: null,
      operation_id: null,
      event_type: 'EXACT_STAGING_BASELINE_ADOPTION_FAILED',
      actor: 'release-bus-v2',
      payload_json: {},
      created_at: NOW - 2 * 60 * 60 * 1000 - index - 1
    }));
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).resolves.toMatchObject({ decision: 'LEGACY' });
    expect(context.repository.state.row_version).toBe(23);
    expect(context.repository.trains).toHaveLength(0);
  });

  it('requires the exact idempotent DEFERRED evidence before manifest freeze', async () => {
    const context = harness();
    await prepare(context);
    await context.service.decideAutomaticE2E(automaticInput());
    const deferred = context.repository.events.find(
      ({ event_type }) =>
        event_type === 'EXACT_STAGING_BASELINE_AUTOMATIC_E2E_DEFERRED'
    );
    deferred.payload_json.expensive_suite_executed = true;

    await expect(
      context.service.recordBackendDeployment(backendInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.manifests).toHaveLength(0);
    expect(context.repository.operations).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
  });

  it('fails an expired intent closed without creating adoption state', async () => {
    const context = harness();
    await prepare(context);
    context.setNow(NOW + 31 * 60 * 1000);
    await expect(
      context.service.decideAutomaticE2E(automaticInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
    expect(
      context.repository.events.some(
        ({ event_type }) =>
          event_type === 'EXACT_STAGING_BASELINE_ADOPTION_FAILED'
      )
    ).toBe(true);
  });

  it('returns an expired idempotent preparation retry as the same failed intent', async () => {
    const context = harness();
    await prepare(context);
    context.setNow(NOW + 31 * 60 * 1000);
    await expect(
      context.service.execute(input(), 'owner')
    ).resolves.toMatchObject({
      adoption_id: INTENT_ID,
      status: 'FAILED',
      reused: true
    });
    expect(context.repository.events[0].id).toBe(INTENT_ID);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
  });

  it.each([
    [
      'frontend ref',
      (context: Harness) => {
        context.refs.frontend = 'f'.repeat(40);
        return context.service.decideAutomaticE2E(automaticInput());
      }
    ],
    [
      'frontend runtime',
      (context: Harness) => {
        context.runtimes.frontend = 'f'.repeat(40);
        return context.service.decideAutomaticE2E(automaticInput());
      }
    ],
    [
      'backend ref',
      (context: Harness) => {
        context.refs.backend = 'f'.repeat(40);
        return context.service.recordBackendDeployment(backendInput());
      }
    ]
  ])(
    'fails moved %s evidence closed with no partial adoption',
    async (_label, act) => {
      const context = harness();
      await prepare(context);
      await expect(act(context)).rejects.toBeInstanceOf(
        ReleaseBusV2BaselineAdoptionError
      );
      expect(context.repository.trains).toHaveLength(0);
      expect(context.repository.manifests).toHaveLength(0);
      expect(context.repository.operations).toHaveLength(0);
      expect(context.repository.state.row_version).toBe(23);
    }
  );

  it('accepts a transient old backend runtime once the exact deployment converges', async () => {
    const context = harness();
    context.deps.readBackendRuntimeSha
      .mockResolvedValueOnce('f'.repeat(40))
      .mockResolvedValueOnce(BACKEND_SHA);
    await prepare(context);

    await expect(
      context.service.recordBackendDeployment(backendInput())
    ).resolves.toMatchObject({ outcome: 'RECORDED' });
    expect(context.deps.readBackendRuntimeSha).toHaveBeenCalledTimes(2);
    expect(context.deps.waitForBackendRuntimeRetry).toHaveBeenCalledWith(1_000);
    expect(
      context.repository.events.some(
        ({ event_type }) =>
          event_type === 'EXACT_STAGING_BASELINE_ADOPTION_FAILED'
      )
    ).toBe(false);
  });

  it('fails a persistently mismatched backend runtime closed', async () => {
    const context = harness();
    context.runtimes.backend = 'f'.repeat(40);
    await prepare(context);

    await expect(
      context.service.recordBackendDeployment(backendInput())
    ).rejects.toBeInstanceOf(ReleaseBusV2BaselineAdoptionError);
    expect(context.deps.readBackendRuntimeSha).toHaveBeenCalledTimes(4);
    expect(context.deps.waitForBackendRuntimeRetry.mock.calls).toEqual([
      [1_000],
      [2_000],
      [4_000]
    ]);
    expect(context.repository.trains).toHaveLength(0);
    expect(context.repository.manifests).toHaveLength(0);
    expect(context.repository.operations).toHaveLength(0);
    expect(context.repository.state.row_version).toBe(23);
  });

  it.each([
    [
      'state version',
      (context: Harness) => {
        context.repository.state.row_version += 1;
      }
    ],
    [
      'frontend ref',
      (context: Harness) => {
        context.refs.frontend = 'f'.repeat(40);
      }
    ],
    [
      'backend runtime',
      (context: Harness) => {
        context.runtimes.backend = 'f'.repeat(40);
      }
    ]
  ])(
    'rejects stale final %s after sole E2E success without CAS adoption',
    async (_label, mutate) => {
      const context = harness();
      await prepare(context);
      await freeze(context);
      succeedBoundE2E(context);
      mutate(context);
      await context.service.handleE2EProgress(INTENT_ID);
      expect(context.repository.state.current_manifest_id).toBeNull();
      expect(context.repository.trains[0].status).toBe('FAILED');
      expect(context.repository.locks[2].lease_token).toBeNull();
    }
  );

  it('adopts only exact bound terminal success and processes its callback once', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    expect(context.repository.state.row_version).toBe(23);
    succeedBoundE2E(context);
    await context.service.handleE2EProgress(INTENT_ID);
    await context.service.handleE2EProgress(INTENT_ID);
    expect(context.repository.state).toMatchObject({
      status: 'LIVE',
      current_manifest_id: context.repository.manifests[0].id,
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      clean_main: false,
      row_version: 24
    });
    expect(context.repository.trains[0].status).toBe('STAGING_VALIDATED');
    expect(context.repository.manifests[0]).toMatchObject({
      status: 'STAGING_VALIDATED',
      e2e_run_id: BOUND_E2E_RUN_ID
    });
    expect(context.repository.updateStagingState).toHaveBeenCalledTimes(1);
    expect(context.repository.locks[2].lease_token).toBeNull();
  });

  it('lets a manifest frozen before intent expiry finish its sole bound E2E after expiry', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    context.setNow(NOW + 31 * 60 * 1000);
    succeedBoundE2E(context);
    await context.service.handleE2EProgress(INTENT_ID);
    expect(context.repository.state.row_version).toBe(24);
    expect(context.repository.trains[0].status).toBe('STAGING_VALIDATED');
  });

  it('rejects a malformed bound operation identity after E2E without partial adoption', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    context.repository.operations[0].request_json.inputs.expected_sha =
      'f'.repeat(40);
    succeedBoundE2E(context);
    await context.service.handleE2EProgress(INTENT_ID);
    expect(context.repository.state.row_version).toBe(23);
    expect(context.repository.state.current_manifest_id).toBeNull();
    expect(context.repository.trains[0].status).toBe('FAILED');
    expect(context.repository.locks[2].lease_token).toBeNull();
  });

  it('leaves state unchanged on bound E2E failure or ambiguous terminal operations', async () => {
    const failed = harness();
    await prepare(failed);
    await freeze(failed);
    Object.assign(failed.repository.operations[0], {
      status: 'FAILED',
      failure_message: 'E2E failed'
    });
    await failed.service.handleE2EProgress(INTENT_ID);
    expect(failed.repository.state.row_version).toBe(23);
    expect(failed.repository.trains[0].status).toBe('FAILED');
    expect(failed.repository.locks[2].lease_token).toBeNull();

    const ambiguous = harness();
    await prepare(ambiguous);
    await freeze(ambiguous);
    ambiguous.repository.operations.push({
      ...structuredClone(ambiguous.repository.operations[0]),
      id: '60000000-0000-4000-8000-000000000007',
      idempotency_key: `rb2:${INTENT_ID}:e2e:staging:duplicate`,
      status: 'SUCCEEDED'
    });
    await ambiguous.service.handleE2EProgress(INTENT_ID);
    expect(ambiguous.repository.state.row_version).toBe(23);
    expect(ambiguous.repository.trains[0].status).toBe('FAILED');
  });

  it('terminalizes an exact E2E operation that failed before dispatch reservation', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    Object.assign(context.repository.operations[0], {
      status: 'PENDING',
      external_id: null
    });
    context.repository.operations.push({
      ...structuredClone(context.repository.operations[0]),
      id: '60000000-0000-4000-8000-000000000007',
      idempotency_key: `rb2:${INTENT_ID}:e2e:staging:duplicate`,
      status: 'SUCCEEDED'
    });

    await context.service.handleE2EProgress(INTENT_ID);

    expect(context.repository.operations[0]).toMatchObject({
      status: 'CANCELLED',
      external_id: null,
      failure_class: 'CONTROL_PLANE'
    });
    expect(context.repository.events).toContainEqual(
      expect.objectContaining({
        train_id: INTENT_ID,
        event_type: 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED',
        actor: 'release-bus-v2',
        payload_json: expect.objectContaining({
          previous_status: 'PENDING',
          operation_status: 'CANCELLED',
          dispatch_reservation_observed: false,
          external_workflow_run_observed: false
        })
      })
    );
  });

  it('repairs a previously failed intent whose exact E2E operation was left pending', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    Object.assign(context.repository.operations[0], {
      status: 'PENDING',
      external_id: null
    });
    context.repository.operations.push({
      ...structuredClone(context.repository.operations[0]),
      id: '60000000-0000-4000-8000-000000000007',
      idempotency_key: `rb2:${INTENT_ID}:e2e:staging:duplicate`,
      status: 'SUCCEEDED'
    });
    await context.service.handleE2EProgress(INTENT_ID);

    Object.assign(context.repository.operations[0], {
      status: 'PENDING',
      failure_class: null,
      failure_message: null,
      completed_at: null,
      row_version: context.repository.operations[0].row_version + 1
    });
    context.repository.events = context.repository.events.filter(
      ({ event_type }) =>
        event_type !== 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED'
    );
    context.repository.updateOperation.mockClear();

    await expect(
      context.service.execute(input(), 'owner')
    ).resolves.toMatchObject({
      adoption_id: INTENT_ID,
      status: 'FAILED',
      reused: true
    });
    expect(context.repository.operations[0].status).toBe('CANCELLED');
    expect(context.repository.updateOperation).toHaveBeenCalledTimes(1);
    expect(context.repository.events).toContainEqual(
      expect.objectContaining({
        event_type: 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED',
        actor: 'owner'
      })
    );
  });

  it('keeps failed intent reads stable when recovery races', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    Object.assign(context.repository.operations[0], {
      status: 'PENDING',
      external_id: null
    });
    context.repository.operations.push({
      ...structuredClone(context.repository.operations[0]),
      id: '60000000-0000-4000-8000-000000000007',
      idempotency_key: `rb2:${INTENT_ID}:e2e:staging:duplicate`,
      status: 'SUCCEEDED'
    });
    await context.service.handleE2EProgress(INTENT_ID);
    Object.assign(context.repository.operations[0], {
      status: 'PENDING',
      failure_class: null,
      failure_message: null,
      completed_at: null,
      row_version: context.repository.operations[0].row_version + 1
    });
    context.repository.events = context.repository.events.filter(
      ({ event_type }) =>
        event_type !== 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED'
    );
    context.repository.updateOperation.mockImplementationOnce(
      async () => false
    );

    await expect(
      context.service.execute(input(), 'owner')
    ).resolves.toMatchObject({
      adoption_id: INTENT_ID,
      status: 'FAILED',
      reused: true
    });
    expect(context.repository.operations[0].status).toBe('PENDING');
    expect(context.repository.events).not.toContainEqual(
      expect.objectContaining({
        event_type: 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED'
      })
    );
  });

  it('does not guess that a reserved E2E operation was never dispatched', async () => {
    const context = harness();
    await prepare(context);
    await freeze(context);
    Object.assign(context.repository.operations[0], {
      status: 'DISPATCHED',
      external_id: null
    });
    context.repository.operations.push({
      ...structuredClone(context.repository.operations[0]),
      id: '60000000-0000-4000-8000-000000000007',
      idempotency_key: `rb2:${INTENT_ID}:e2e:staging:duplicate`,
      status: 'SUCCEEDED'
    });

    await context.service.handleE2EProgress(INTENT_ID);
    await context.service.execute(input(), 'owner');

    expect(context.repository.operations[0].status).toBe('DISPATCHED');
    expect(context.repository.updateOperation).not.toHaveBeenCalled();
    expect(context.repository.events).not.toContainEqual(
      expect.objectContaining({
        event_type: 'EXACT_STAGING_BASELINE_UNDISPATCHED_E2E_CANCELLED'
      })
    );
  });

  it('rolls back all authoritative changes when a known-candidate CAS fails', async () => {
    const context = harness({ withCandidate: true });
    await prepare(context, true);
    await freeze(context);
    context.repository.failCandidateUpdate = true;
    succeedBoundE2E(context);
    await context.service.handleE2EProgress(INTENT_ID);
    expect(context.repository.state.row_version).toBe(23);
    expect(context.repository.state.current_manifest_id).toBeNull();
    expect(context.repository.candidates[0]).toMatchObject({
      staging_live_state: 'NOT_LIVE',
      production_requested_at: 123,
      hold_reason: 'preserve me'
    });
    expect(context.repository.trains[0].status).toBe('FAILED');
  });

  it.each([false, true])(
    'adopts %s candidate membership while retaining developer and production intent',
    async (withCandidate) => {
      const context = harness({ withCandidate });
      const productionBefore = structuredClone(context.repository.locks[0]);
      const candidateBefore = withCandidate
        ? structuredClone(context.repository.candidates[0])
        : null;
      await prepare(context, withCandidate);
      await freeze(context);
      succeedBoundE2E(context);
      await context.service.handleE2EProgress(INTENT_ID);
      expect(context.repository.locks[0]).toEqual(productionBefore);
      if (candidateBefore)
        expect(context.repository.candidates[0]).toMatchObject({
          status: candidateBefore.status,
          production_requested_at: candidateBefore.production_requested_at,
          production_requested_by: candidateBefore.production_requested_by,
          production_selection_id: candidateBefore.production_selection_id,
          hold_reason: candidateBefore.hold_reason,
          staging_live_state: 'LIVE'
        });
      else expect(context.repository.candidates).toHaveLength(0);
    }
  );

  it('never acquires or mutates independent production ownership', async () => {
    const context = harness({ productionBusy: true });
    const productionBefore = structuredClone(context.repository.locks[0]);
    await prepare(context);
    await freeze(context);
    expect(context.repository.locks[0]).toEqual(productionBefore);
    expect(context.repository.acquireLock).toHaveBeenCalledTimes(1);
    expect(context.repository.acquireLock).toHaveBeenCalledWith(
      'staging-environment',
      INTENT_ID,
      `baseline-adoption:${INTENT_ID}`,
      expect.any(Number),
      expect.any(Object)
    );
  });
});
