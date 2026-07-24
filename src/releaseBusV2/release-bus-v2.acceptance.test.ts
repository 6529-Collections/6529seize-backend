const mockReconcileWorkflow = jest.fn();
const mockEnsureCommitStatus = jest.fn();
const mockResolveRef = jest.fn();
const mockResolveRefIfExists = jest.fn();
const mockRefContainsCommit = jest.fn();
const mockUpdateRef = jest.fn();
const mockHasActiveStagingRun = jest.fn();
const mockHasStagingRunSince = jest.fn();
const mockHasActiveProductionRun = jest.fn();
const mockFindWorkflowRun = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.operations', () => ({
  releaseBusV2Operations: {
    reconcileWorkflow: (...args: unknown[]) => mockReconcileWorkflow(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args),
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    resolveRefIfExists: (...args: unknown[]) => mockResolveRefIfExists(...args),
    refContainsCommit: (...args: unknown[]) => mockRefContainsCommit(...args),
    updateRef: (...args: unknown[]) => mockUpdateRef(...args),
    hasActiveStagingMutationOrE2ERun: (...args: unknown[]) =>
      mockHasActiveStagingRun(...args),
    hasStagingMutationOrE2ERunSince: (...args: unknown[]) =>
      mockHasStagingRunSince(...args),
    hasActiveProductionMutationOrE2ERun: (...args: unknown[]) =>
      mockHasActiveProductionRun(...args),
    findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args)
  }
}));

import { ReleaseBusV2Reconciler } from '@/releaseBusV2/release-bus-v2.reconciler';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ReleaseBusV2ControlRecord,
  ReleaseBusV2DependencyRecord,
  ReleaseBusV2LockRecord,
  ReleaseBusV2ManifestRecord,
  ReleaseBusV2TrainCandidateRecord
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2OperationRecord,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

const FRONTEND_SHA = 'a'.repeat(40);
const BACKEND_SHA = 'b'.repeat(40);
const FRONTEND_DIGEST = 'c'.repeat(64);
const BACKEND_DIGEST = 'd'.repeat(64);

function train(
  id: string,
  overrides: Partial<ReleaseBusV2TrainRecord> = {}
): ReleaseBusV2TrainRecord {
  return {
    id,
    lane: 'STAGING',
    status: 'PREPARED',
    frontend_base_sha: '1'.repeat(40),
    backend_base_sha: '2'.repeat(40),
    frontend_composed_sha: FRONTEND_SHA,
    backend_composed_sha: BACKEND_SHA,
    frontend_artifact_digest: FRONTEND_DIGEST,
    backend_artifact_digest: BACKEND_DIGEST,
    manifest_id: null,
    parent_train_id: null,
    qualification_identity_sha256: null,
    qualification_train_id: null,
    failure_class: null,
    failure_message: null,
    recovery_message: null,
    phase_started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1,
    ...overrides
  };
}

function candidate(
  id: string,
  repository: 'frontend' | 'backend',
  plan: ReleaseBusV2CandidateRecord['deploy_plan_json']
): ReleaseBusV2CandidateRecord {
  return {
    id,
    repository,
    pr_number: repository === 'frontend' ? 20 : 21,
    branch_name: `feature/${id}`,
    head_sha: repository === 'frontend' ? '3'.repeat(40) : '4'.repeat(40),
    requested_by: 'acceptance',
    status: 'STAGING_BUILDING',
    deploy_plan_json: plan,
    pr_evidence_json: null,
    current_train_id: 'train-1',
    staging_validated_train_id: null,
    staging_validated_manifest_id: null,
    production_requested_at: null,
    production_requested_by: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

function operation(
  trainId: string,
  type: string,
  repository: 'frontend' | 'backend',
  externalId: string,
  service: string | null = null
): ReleaseBusV2OperationRecord {
  return {
    id: `${trainId}-${type}-${service ?? repository}`,
    idempotency_key: `rb2:${trainId}:${type.toLowerCase()}`,
    train_id: trainId,
    operation_type: type,
    repository,
    service,
    environment: type.startsWith('E2E') ? 'staging' : 'orchestration',
    expected_sha: repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA,
    artifact_digest:
      repository === 'frontend' ? FRONTEND_DIGEST : BACKEND_DIGEST,
    external_id: externalId,
    status: 'SUCCEEDED',
    attempt: 1,
    max_attempts: 3,
    next_retry_at: null,
    failure_class: null,
    failure_message: null,
    request_json: null,
    result_json: null,
    started_at: 2,
    completed_at: 3,
    created_at: 2,
    updated_at: 3,
    row_version: 1
  };
}

class InMemoryAcceptanceRepository {
  public readonly trains = new Map<string, ReleaseBusV2TrainRecord>();
  public readonly candidates = new Map<string, ReleaseBusV2CandidateRecord>();
  public readonly memberships: ReleaseBusV2TrainCandidateRecord[] = [];
  public readonly dependencies: ReleaseBusV2DependencyRecord[] = [];
  public readonly operations: ReleaseBusV2OperationRecord[] = [];
  public readonly manifests = new Map<string, ReleaseBusV2ManifestRecord>();
  public readonly events: Array<{
    readonly trainId?: string | null;
    readonly candidateId?: string | null;
    readonly eventType: string;
    readonly actor?: string | null;
    readonly payload?: unknown;
    readonly createdAt: number;
  }> = [];
  public readonly controls = new Map<
    ReleaseBusV2ControlRecord['scope'],
    ReleaseBusV2ControlRecord
  >(
    (['ALL', 'STAGING', 'PRODUCTION'] as const).map((scope) => [
      scope,
      {
        scope,
        paused: false,
        reason: null,
        github_actor: null,
        updated_at: 1,
        row_version: 1
      }
    ])
  );
  private eventClock = Date.now();
  public lock: ReleaseBusV2LockRecord = {
    name: 'staging-environment',
    owner_train_id: null,
    lease_owner: null,
    lease_token: null,
    heartbeat_at: null,
    expires_at: null,
    updated_at: 1,
    row_version: 1
  };

  public async listControls(): Promise<ReleaseBusV2ControlRecord[]> {
    return Array.from(this.controls.values());
  }

  public async listTrains(): Promise<ReleaseBusV2TrainRecord[]> {
    return Array.from(this.trains.values());
  }

  public async listCandidates(
    statuses: readonly ReleaseBusV2CandidateRecord['status'][]
  ): Promise<ReleaseBusV2CandidateRecord[]> {
    const selected = new Set(statuses);
    return Array.from(this.candidates.values()).filter((item) =>
      selected.has(item.status)
    );
  }

  public async findTrain(id: string): Promise<ReleaseBusV2TrainRecord | null> {
    return this.trains.get(id) ?? null;
  }

  public async listTrainCandidates(
    trainId: string
  ): Promise<ReleaseBusV2TrainCandidateRecord[]> {
    return this.memberships.filter((item) => item.train_id === trainId);
  }

  public async findCandidateById(
    id: string
  ): Promise<ReleaseBusV2CandidateRecord | null> {
    return this.candidates.get(id) ?? null;
  }

  public async listDependencies(
    candidateIds: readonly string[]
  ): Promise<ReleaseBusV2DependencyRecord[]> {
    const selected = new Set(candidateIds);
    return this.dependencies.filter((item) => selected.has(item.candidate_id));
  }

  public async updateCandidate(
    id: string,
    rowVersion: number,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const current = this.candidates.get(id);
    if (!current || current.row_version !== rowVersion) return false;
    this.candidates.set(id, {
      ...current,
      status:
        (fields.status as ReleaseBusV2CandidateRecord['status']) ??
        current.status,
      current_train_id:
        fields.currentTrainId === undefined
          ? current.current_train_id
          : (fields.currentTrainId as string | null),
      staging_validated_train_id:
        fields.stagingValidatedTrainId === undefined
          ? current.staging_validated_train_id
          : (fields.stagingValidatedTrainId as string | null),
      staging_validated_manifest_id:
        fields.stagingValidatedManifestId === undefined
          ? current.staging_validated_manifest_id
          : (fields.stagingValidatedManifestId as string | null),
      hold_reason:
        fields.holdReason === undefined
          ? current.hold_reason
          : (fields.holdReason as string | null),
      row_version: current.row_version + 1,
      updated_at: Date.now()
    });
    return true;
  }

  public async updateTrainCandidateDisposition(
    trainId: string,
    candidateId: string,
    disposition: string
  ): Promise<void> {
    const index = this.memberships.findIndex(
      (item) => item.train_id === trainId && item.candidate_id === candidateId
    );
    const membership = this.memberships[index];
    if (membership) this.memberships[index] = { ...membership, disposition };
  }

  public async updateTrain(
    id: string,
    rowVersion: number,
    fields: Record<string, unknown>
  ): Promise<boolean> {
    const current = this.trains.get(id);
    if (!current || current.row_version !== rowVersion) return false;
    this.trains.set(id, {
      ...current,
      status:
        (fields.status as ReleaseBusV2TrainRecord['status']) ?? current.status,
      frontend_composed_sha:
        fields.frontendComposedSha === undefined
          ? current.frontend_composed_sha
          : (fields.frontendComposedSha as string | null),
      backend_composed_sha:
        fields.backendComposedSha === undefined
          ? current.backend_composed_sha
          : (fields.backendComposedSha as string | null),
      manifest_id:
        fields.manifestId === undefined
          ? current.manifest_id
          : (fields.manifestId as string | null),
      failure_class:
        fields.failureClass === undefined
          ? current.failure_class
          : (fields.failureClass as ReleaseBusV2TrainRecord['failure_class']),
      failure_message:
        fields.failureMessage === undefined
          ? current.failure_message
          : (fields.failureMessage as string | null),
      recovery_message:
        fields.recoveryMessage === undefined
          ? current.recovery_message
          : (fields.recoveryMessage as string | null),
      completed_at:
        fields.completedAt === undefined
          ? current.completed_at
          : (fields.completedAt as number | null),
      phase_started_at: Date.now(),
      updated_at: Date.now(),
      row_version: current.row_version + 1
    });
    return true;
  }

  public async appendEvent(
    input: Omit<(typeof this.events)[number], 'createdAt'>
  ): Promise<void> {
    this.eventClock += 1;
    this.events.push({ ...input, createdAt: this.eventClock });
  }

  public async listEvents(trainId: string): Promise<
    Array<{
      readonly id: string;
      readonly train_id: string | null;
      readonly candidate_id: string | null;
      readonly event_type: string;
      readonly github_actor: string | null;
      readonly payload_json: unknown;
      readonly created_at: number;
    }>
  > {
    return this.events
      .filter((event) => event.trainId === trainId)
      .map((event, index) => ({
        id: `event-${index}`,
        train_id: event.trainId ?? null,
        candidate_id: event.candidateId ?? null,
        event_type: event.eventType,
        github_actor: event.actor ?? null,
        payload_json: event.payload ?? null,
        created_at: event.createdAt
      }))
      .reverse();
  }

  public async acquireLock(
    _name: string,
    ownerTrainId: string,
    leaseOwner: string
  ): Promise<ReleaseBusV2LockRecord | null> {
    if (this.lock.lease_owner && this.lock.lease_owner !== leaseOwner)
      return null;
    this.lock = {
      ...this.lock,
      owner_train_id: ownerTrainId,
      lease_owner: leaseOwner,
      lease_token: `${ownerTrainId}-lease-${this.lock.row_version}`,
      heartbeat_at: Date.now(),
      expires_at: Date.now() + 300_000,
      updated_at: Date.now(),
      row_version: this.lock.row_version + 1
    };
    return this.lock;
  }

  public async releaseLock(_name: string, token: string): Promise<boolean> {
    if (this.lock.lease_token !== token) return false;
    this.lock = {
      ...this.lock,
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: Date.now(),
      row_version: this.lock.row_version + 1
    };
    return true;
  }

  public async listLocks(): Promise<ReleaseBusV2LockRecord[]> {
    return [this.lock];
  }

  public async listOperations(
    trainId: string
  ): Promise<ReleaseBusV2OperationRecord[]> {
    return this.operations.filter((item) => item.train_id === trainId);
  }

  public async findOperation(
    idempotencyKey: string
  ): Promise<ReleaseBusV2OperationRecord | null> {
    return (
      this.operations.find((item) => item.idempotency_key === idempotencyKey) ??
      null
    );
  }

  public async getOrCreateOperation(input: {
    readonly idempotencyKey: string;
    readonly trainId: string;
    readonly operationType: string;
    readonly repository: 'frontend' | 'backend';
    readonly service: string | null;
    readonly environment: string;
    readonly expectedSha: string | null;
    readonly artifactDigest: string | null;
    readonly request: unknown;
    readonly maxAttempts: number;
  }): Promise<ReleaseBusV2OperationRecord> {
    const existing = await this.findOperation(input.idempotencyKey);
    if (existing) return existing;
    const now = Date.now();
    const created: ReleaseBusV2OperationRecord = {
      id: `operation-${this.operations.length + 1}`,
      idempotency_key: input.idempotencyKey,
      train_id: input.trainId,
      operation_type: input.operationType,
      repository: input.repository,
      service: input.service,
      environment: input.environment,
      expected_sha: input.expectedSha,
      artifact_digest: input.artifactDigest,
      external_id: null,
      status: 'PENDING',
      attempt: 1,
      max_attempts: input.maxAttempts,
      next_retry_at: null,
      failure_class: null,
      failure_message: null,
      request_json: input.request,
      result_json: null,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      row_version: 1
    };
    this.operations.push(created);
    return created;
  }

  public async updateOperation(
    id: string,
    rowVersion: number,
    fields: Partial<{
      readonly status: ReleaseBusV2OperationRecord['status'];
      readonly externalId: string | null;
      readonly result: unknown;
      readonly failureClass: ReleaseBusV2OperationRecord['failure_class'];
      readonly failureMessage: string | null;
      readonly attempt: number;
      readonly completedAt: number | null;
    }>
  ): Promise<boolean> {
    const index = this.operations.findIndex((item) => item.id === id);
    const current = this.operations[index];
    if (!current || current.row_version !== rowVersion) return false;
    this.operations[index] = {
      ...current,
      status: fields.status ?? current.status,
      external_id:
        fields.externalId === undefined
          ? current.external_id
          : fields.externalId,
      result_json:
        fields.result === undefined ? current.result_json : fields.result,
      failure_class:
        fields.failureClass === undefined
          ? current.failure_class
          : fields.failureClass,
      failure_message:
        fields.failureMessage === undefined
          ? current.failure_message
          : fields.failureMessage,
      attempt: fields.attempt ?? current.attempt,
      completed_at:
        fields.completedAt === undefined
          ? current.completed_at
          : fields.completedAt,
      updated_at: Date.now(),
      row_version: current.row_version + 1
    };
    return true;
  }

  public async createManifest(
    input: Omit<ReleaseBusV2ManifestRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ReleaseBusV2ManifestRecord> {
    const existing = Array.from(this.manifests.values()).find(
      (item) => item.identity_sha256 === input.identity_sha256
    );
    if (existing) return existing;
    const created: ReleaseBusV2ManifestRecord = {
      ...input,
      id: `manifest-${this.manifests.size + 1}`,
      created_at: Date.now(),
      updated_at: Date.now()
    };
    this.manifests.set(created.id, created);
    return created;
  }

  public async findManifest(
    id: string
  ): Promise<ReleaseBusV2ManifestRecord | null> {
    return this.manifests.get(id) ?? null;
  }

  public async updateManifestStatus(
    id: string,
    status: ReleaseBusV2ManifestRecord['status'],
    e2eRunId: string | null
  ): Promise<void> {
    const current = this.manifests.get(id);
    if (!current) throw new Error('manifest missing');
    this.manifests.set(id, {
      ...current,
      status,
      e2e_run_id: e2eRunId,
      validated_at: status === 'STAGING_VALIDATED' ? Date.now() : null,
      updated_at: Date.now()
    });
  }
}

function harness(e2eStatus: 'RUNNING' | 'SUCCEEDED' | 'FAILED') {
  const repository = new InMemoryAcceptanceRepository();
  const backend = candidate('backend-candidate', 'backend', {
    units: ['dbMigrationsLoop', 'ethPriceLoop', 'api'],
    edges: [['dbMigrationsLoop', 'api']]
  });
  const frontend = candidate('frontend-candidate', 'frontend', null);
  repository.candidates.set(backend.id, backend);
  repository.candidates.set(frontend.id, frontend);
  repository.trains.set('train-1', train('train-1'));
  repository.memberships.push(
    {
      id: 'membership-backend',
      train_id: 'train-1',
      candidate_id: backend.id,
      sequence: 1,
      disposition: 'INCLUDED',
      created_at: 1
    },
    {
      id: 'membership-frontend',
      train_id: 'train-1',
      candidate_id: frontend.id,
      sequence: 2,
      disposition: 'INCLUDED',
      created_at: 1
    }
  );
  repository.dependencies.push({
    id: 'dependency',
    candidate_id: frontend.id,
    prerequisite_candidate_id: backend.id,
    environment: 'BOTH',
    created_at: 1
  });
  repository.operations.push(
    operation('train-1', 'PREPARE_ARTIFACT_FRONTEND', 'frontend', '101'),
    operation('train-1', 'PREPARE_ARTIFACT_BACKEND', 'backend', '102')
  );
  const service = {
    claimLane: jest.fn(async () => null),
    setPaused: jest.fn(
      async (
        scope: ReleaseBusV2ControlRecord['scope'],
        paused: boolean,
        reason: string,
        actor: string
      ) => {
        const prior = repository.controls.get(scope);
        if (!prior) throw new Error(`Missing ${scope} control`);
        repository.controls.set(scope, {
          ...prior,
          paused,
          reason,
          github_actor: actor,
          updated_at: prior.updated_at + 1,
          row_version: prior.row_version + 1
        });
      }
    ),
    invalidateBranch: jest.fn(async () => undefined),
    restoreProductionReadinessAfterBranchCleanup: jest.fn(
      async () => undefined
    ),
    yieldUnsatisfiableProductionQualification: jest.fn(
      async ({
        qualificationTrainId
      }: {
        readonly qualificationTrainId: string;
      }) => {
        const qualification = repository.trains.get(qualificationTrainId);
        const parent = qualification?.parent_train_id
          ? repository.trains.get(qualification.parent_train_id)
          : null;
        if (!qualification || !parent)
          throw new Error('qualification parent missing');
        if (
          qualification.status === 'CANCELLED' &&
          parent.status === 'CANCELLED'
        )
          return {
            yielded: false,
            parentTrainId: parent.id,
            qualificationTrainId: qualification.id,
            candidateIds: []
          };
        const candidateIds = repository.memberships
          .filter(
            (membership) =>
              membership.train_id === parent.id &&
              membership.disposition === 'INCLUDED'
          )
          .map(({ candidate_id }) => candidate_id);
        repository.trains.set(qualification.id, {
          ...qualification,
          status: 'CANCELLED',
          completed_at: Date.now(),
          row_version: qualification.row_version + 1
        });
        repository.trains.set(parent.id, {
          ...parent,
          status: 'CANCELLED',
          completed_at: Date.now(),
          row_version: parent.row_version + 1
        });
        repository.events.push({
          trainId: qualification.id,
          eventType: 'PRODUCTION_QUALIFICATION_YIELDED',
          actor: 'release-bus-v2',
          createdAt: Date.now()
        });
        for (const candidateId of candidateIds) {
          const current = repository.candidates.get(candidateId);
          if (!current) continue;
          repository.candidates.set(candidateId, {
            ...current,
            status: 'WAITING_FOR_PRODUCTION_REPLAN',
            current_train_id: null,
            hold_reason: 'Waiting for a safe combined production replan',
            row_version: current.row_version + 1
          });
        }
        return {
          yielded: true,
          parentTrainId: parent.id,
          qualificationTrainId: qualification.id,
          candidateIds
        };
      }
    ),
    isBetaTrainAllowed: jest.fn(async () => true)
  };
  return {
    repository,
    service,
    reconciler: new ReleaseBusV2Reconciler(
      repository as never,
      service as never
    ),
    e2eStatus
  };
}

describe('Release Bus v2 offline acceptance harness', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;
  const previousBetaAllowlist = process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    mockHasActiveStagingRun.mockResolvedValue(false);
    mockHasStagingRunSince.mockResolvedValue(false);
    mockHasActiveProductionRun.mockResolvedValue(false);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    mockRefContainsCommit.mockResolvedValue(false);
  });

  it('does not claim or advance any durable work while mode is OFF', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';

    await expect(state.reconciler.runOnce('acceptance-off')).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).not.toHaveBeenCalled();
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
  });

  it('releases a terminal train lock in OFF mode only after all operations are terminal', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: 4
      })
    );
    await state.repository.acquireLock(
      'staging-environment',
      'train-1',
      'train:train-1'
    );

    await expect(
      state.reconciler.runOnce('acceptance-terminal-lock')
    ).resolves.toEqual({ mode: 'OFF', claimed: [], advanced: [] });
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: 'train-1'
      })
    );
  });

  it('reconciles a stranded terminal main operation before releasing its lock', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const failed = train('terminal-production', {
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: 4
    });
    state.repository.trains.set(failed.id, failed);
    state.repository.operations.push({
      ...operation(failed.id, 'ADVANCE_MAIN_BACKEND', 'backend', 'unused'),
      id: 'stranded-main-operation',
      idempotency_key: `rb2:${failed.id}:advance-main:backend`,
      expected_sha: failed.backend_composed_sha,
      external_id: null,
      status: 'PENDING',
      failure_class: null,
      failure_message: null,
      completed_at: null
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      failed.id,
      `train:${failed.id}`
    );
    mockResolveRef.mockResolvedValue(failed.backend_base_sha);

    await state.reconciler.runOnce('acceptance-terminal-ref-reconciliation');

    expect(
      state.repository.operations.find(
        (item) => item.id === 'stranded-main-operation'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: expect.any(Number)
      })
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'TERMINAL_INTERNAL_REF_OPERATION_RECONCILED',
          trainId: failed.id,
          payload: expect.objectContaining({
            repository: 'backend',
            operation_status: 'FAILED',
            observed_sha: failed.backend_base_sha
          })
        }),
        expect.objectContaining({
          eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
          trainId: failed.id
        })
      ])
    );
  });

  it('retains a terminal lock when a stranded main operation is still ambiguous', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const failed = train('ambiguous-production', {
      lane: 'PRODUCTION',
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: 4
    });
    state.repository.trains.set(failed.id, failed);
    state.repository.operations.push({
      ...operation(failed.id, 'ADVANCE_MAIN_BACKEND', 'backend', 'unused'),
      id: 'ambiguous-main-operation',
      idempotency_key: `rb2:${failed.id}:advance-main:backend`,
      expected_sha: failed.backend_composed_sha,
      external_id: null,
      status: 'PENDING',
      completed_at: null
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      failed.id,
      `train:${failed.id}`
    );
    mockResolveRef.mockResolvedValue('9'.repeat(40));

    await state.reconciler.runOnce('acceptance-ambiguous-terminal-ref');

    expect(
      state.repository.operations.find(
        (item) => item.id === 'ambiguous-main-operation'
      )?.status
    ).toBe('PENDING');
    expect(state.repository.lock.owner_train_id).toBe(failed.id);
    expect(state.repository.events).not.toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: failed.id
      })
    );
  });

  it('pauses only beta automation when the OFF allowlist is malformed', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = 'not-json';

    await expect(
      state.reconciler.runOnce('acceptance-invalid-beta')
    ).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'ALL',
      true,
      expect.stringContaining('allowlist is invalid'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).not.toHaveBeenCalled();
  });

  it('pauses only production for an invalid STAGING-mode beta allowlist', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = 'not-json';
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-invalid-production-beta')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'PRODUCTION',
      true,
      expect.stringContaining('staging remains enabled'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-invalid-production-beta:staging'
    );
  });

  it('resumes only a beta-owned production pause after allowlist repair', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-repaired',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-repaired',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.controls.set('PRODUCTION', {
      scope: 'PRODUCTION',
      paused: true,
      reason: 'invalid beta config',
      github_actor: 'release-bus-v2-beta',
      updated_at: 2,
      row_version: 2
    });
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-repaired-production-beta')
    ).resolves.toEqual({ mode: 'STAGING', claimed: [], advanced: [] });
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'PRODUCTION',
      false,
      expect.stringContaining('recovered'),
      'release-bus-v2-beta'
    );
    expect(state.service.claimLane).toHaveBeenCalledTimes(2);
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      2,
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-repaired-production-beta:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('claims ordinary staging and allowlisted production independently in STAGING mode', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-one',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );

    await expect(
      state.reconciler.runOnce('acceptance-staging-production-beta')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      1,
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-staging-production-beta:staging'
    );
    expect(state.service.claimLane).toHaveBeenNthCalledWith(
      2,
      'PRODUCTION',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-staging-production-beta:production',
      { frontendSha: FRONTEND_SHA, backendSha: BACKEND_SHA }
    );
  });

  it('repairs an allowlisted production candidate after its exact merged branch is deleted', async () => {
    const state = harness('SUCCEEDED');
    const candidateId = '11111111-1111-4111-8111-111111111111';
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-branch-cleanup',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-production-branch-cleanup',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );
    const merged = {
      ...candidate(candidateId, 'frontend', null),
      branch_name: 'agent/rb2-production-branch-cleanup',
      requested_by: 'beta-operator',
      status: 'SUPERSEDED' as const,
      current_train_id: null,
      staging_validated_manifest_id: 'manifest-1',
      production_requested_at: 2,
      production_requested_by: 'beta-operator',
      superseded_at: 3
    };
    state.repository.candidates.set(candidateId, merged);
    mockResolveRefIfExists.mockImplementation(async (_repository, branch) =>
      branch === merged.branch_name ? null : FRONTEND_SHA
    );
    mockRefContainsCommit.mockResolvedValue(true);

    await state.reconciler.runOnce('acceptance-branch-cleanup');

    expect(mockRefContainsCommit).toHaveBeenCalledWith(
      'frontend',
      'main',
      merged.head_sha
    );
    expect(
      state.service.restoreProductionReadinessAfterBranchCleanup
    ).toHaveBeenCalledWith(candidateId, 'release-bus-v2-reconciler');
    expect(state.service.invalidateBranch).not.toHaveBeenCalledWith(
      'frontend',
      merged.branch_name,
      'deleted',
      expect.any(String)
    );
  });

  it('still supersedes an explicit production candidate when its branch moves', async () => {
    const state = harness('SUCCEEDED');
    const candidateId = '11111111-1111-4111-8111-111111111111';
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-branch-move',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-production-branch-move',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { status: 'CANCELLED', completed_at: 2 })
    );
    const ready = {
      ...candidate(candidateId, 'frontend', null),
      branch_name: 'agent/rb2-production-branch-move',
      requested_by: 'beta-operator',
      status: 'READY_FOR_PRODUCTION' as const,
      current_train_id: null,
      staging_validated_manifest_id: 'manifest-1',
      production_requested_at: 2,
      production_requested_by: 'beta-operator'
    };
    state.repository.candidates.set(candidateId, ready);
    const movedHead = '9'.repeat(40);
    mockResolveRefIfExists.mockImplementation(async (_repository, branch) =>
      branch === ready.branch_name ? movedHead : FRONTEND_SHA
    );

    await state.reconciler.runOnce('acceptance-branch-move');

    expect(mockRefContainsCommit).not.toHaveBeenCalled();
    expect(state.service.invalidateBranch).toHaveBeenCalledWith(
      'frontend',
      ready.branch_name,
      movedHead,
      'release-bus-v2-reconciler'
    );
  });

  it('does not advance an unallowlisted production train in STAGING mode', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'production-subset-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-production-subset-one',
        operator: 'beta-operator',
        lanes: ['PRODUCTION']
      }
    ]);
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION', status: 'PREPARED' })
    );
    state.service.isBetaTrainAllowed.mockResolvedValue(false);

    await expect(
      state.reconciler.runOnce('acceptance-unlisted-production-train')
    ).resolves.toEqual({
      mode: 'STAGING',
      claimed: [],
      advanced: []
    });
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
  });

  it('enters the OFF beta lane but does not advance an unallowlisted active train', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    state.service.isBetaTrainAllowed.mockResolvedValue(false);

    await expect(state.reconciler.runOnce('acceptance-beta')).resolves.toEqual({
      mode: 'OFF',
      claimed: [],
      advanced: []
    });
    expect(state.service.claimLane).toHaveBeenCalledTimes(1);
    expect(state.service.claimLane).toHaveBeenCalledWith(
      'STAGING',
      FRONTEND_SHA,
      BACKEND_SHA,
      'acceptance-beta:staging'
    );
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.trains.get('train-1')?.status).toBe('PREPARED');
  });

  it('double-checks idle refs around the staging lock before a beta mutation', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'backend-only-1',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'backend',
        branch_name: 'agent/rb2-beta-backend-one',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA
    );
    const updateTrain = state.repository.updateTrain.bind(state.repository);
    jest
      .spyOn(state.repository, 'updateTrain')
      .mockImplementation(async (id, rowVersion, fields) => {
        const updated = await updateTrain(id, rowVersion, fields);
        const trainAfterUpdate = state.repository.trains.get(id);
        if (updated && trainAfterUpdate) {
          state.repository.trains.set(id, {
            ...trainAfterUpdate,
            row_version: rowVersion
          });
        }
        return updated;
      });

    const result = await state.reconciler.runOnce('acceptance-beta-idle');
    expect({
      result,
      train: state.repository.trains.get('train-1'),
      events: state.repository.events,
      lock: state.repository.lock
    }).toMatchObject({
      result: { mode: 'OFF', claimed: [], advanced: ['train-1'] },
      train: { status: 'DEPLOYING' },
      lock: { owner_train_id: 'train-1' }
    });
    expect(mockHasActiveStagingRun).toHaveBeenCalledTimes(4);
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'BETA_STAGING_IDLE_HANDSHAKE',
        trainId: 'train-1',
        payload: expect.objectContaining({
          staging_lock: 'owned',
          workflow_fence_started_at: expect.any(Number),
          verified_at: expect.any(Number)
        })
      })
    );
  });

  it('binds an unchanged repository to the exact shared staging ref before deployment', async () => {
    const state = harness('SUCCEEDED');
    const backendStagingSha = 'e'.repeat(40);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'frontend-candidate'
      )!
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend', ref: string) => {
        expect(ref).toBe('1a-staging');
        return repository === 'frontend' ? 'f'.repeat(40) : backendStagingSha;
      }
    );

    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_base_sha: '1'.repeat(40),
        backend_base_sha: '2'.repeat(40),
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: backendStagingSha
      })
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_ENVIRONMENT_IDENTITY_BOUND',
        trainId: 'train-1',
        payload: expect.objectContaining({
          frontend_sha: FRONTEND_SHA,
          backend_sha: backendStagingSha,
          frontend_from_existing_staging: false,
          backend_from_existing_staging: true
        })
      })
    );
  });

  it('transactionally yields exact production qualification when an unchanged repository differs in staging', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );

    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(state.repository.trains.get('production-parent')?.status).toBe(
      'CANCELLED'
    );
    expect(state.repository.candidates.get('frontend-candidate')).toEqual(
      expect.objectContaining({
        status: 'WAITING_FOR_PRODUCTION_REPLAN',
        current_train_id: null
      })
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
    expect(
      state.service.yieldUnsatisfiableProductionQualification
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        qualificationTrainId: 'train-1',
        stagingIdentity: {
          frontendSha: FRONTEND_SHA,
          backendSha: 'e'.repeat(40)
        }
      })
    );
  });

  it('does not repeat a yielded qualification on overlapping reconciles', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await Promise.all([
      (
        state.reconciler as unknown as {
          advanceStagingOrQualification(input: typeof context): Promise<void>;
        }
      ).advanceStagingOrQualification(context),
      (
        state.reconciler as unknown as {
          advanceStagingOrQualification(input: typeof context): Promise<void>;
        }
      ).advanceStagingOrQualification(context)
    ]);

    expect(state.repository.trains.get('train-1')?.status).toBe('CANCELLED');
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(mockReconcileWorkflow).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: expect.stringMatching(/^DEPLOY_/)
      })
    );
    expect(
      state.repository.events.filter(
        ({ eventType }) => eventType === 'PRODUCTION_QUALIFICATION_YIELDED'
      )
    ).toHaveLength(1);
  });

  it('recovers a stalled qualification in STAGING mode only while PRODUCTION is paused and staging is idle', async () => {
    const state = harness('SUCCEEDED');
    state.repository.controls.set('PRODUCTION', {
      ...state.repository.controls.get('PRODUCTION')!,
      paused: true
    });
    jest
      .spyOn(state.repository, 'listLocks')
      .mockResolvedValue(
        ['scheduler', 'staging-environment', 'production-environment'].map(
          (name) => ({ ...state.repository.lock, name })
        )
      );
    state.repository.trains.set(
      'production-parent',
      train('production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'train-1'
      })
    );
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'production-parent'
      })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        train_id: 'production-parent'
      },
      {
        ...state.repository.memberships.find(
          ({ candidate_id }) => candidate_id === 'frontend-candidate'
        )!,
        id: 'qualification-frontend-membership',
        train_id: 'train-1'
      }
    );
    state.repository.candidates.set('frontend-candidate', {
      ...state.repository.candidates.get('frontend-candidate')!,
      status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
      current_train_id: 'production-parent'
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? FRONTEND_SHA : 'e'.repeat(40)
    );
    state.repository.trains.set(
      'second-production-parent',
      train('second-production-parent', {
        lane: 'PRODUCTION',
        status: 'WAITING_FOR_ENVIRONMENT',
        qualification_train_id: 'second-qualification'
      })
    );
    state.repository.trains.set(
      'second-qualification',
      train('second-qualification', {
        lane: 'PRODUCTION_QUALIFICATION',
        status: 'WAITING_FOR_ENVIRONMENT',
        parent_train_id: 'second-production-parent'
      })
    );

    const result =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );

    expect(result).toEqual({
      recovered: [
        {
          parent_train_id: 'production-parent',
          qualification_train_id: 'train-1',
          candidate_ids: ['frontend-candidate']
        }
      ],
      staging_identity: {
        frontend_sha: FRONTEND_SHA,
        backend_sha: 'e'.repeat(40)
      },
      has_more: true
    });
    expect(state.repository.trains.get('train-1')?.status).toBe('CANCELLED');
    expect(state.repository.trains.get('production-parent')?.status).toBe(
      'CANCELLED'
    );
    expect(state.repository.trains.get('second-qualification')?.status).toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(state.repository.lock.lease_token).toBeNull();

    const second =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );
    expect(second).toEqual(
      expect.objectContaining({
        recovered: [
          expect.objectContaining({
            parent_train_id: 'second-production-parent',
            qualification_train_id: 'second-qualification'
          })
        ],
        has_more: true
      })
    );

    const drained =
      await state.reconciler.recoverUnsatisfiableProductionQualifications(
        'operator'
      );
    expect(drained).toEqual(
      expect.objectContaining({
        recovered: [],
        has_more: false
      })
    );
    expect(state.repository.lock.lease_token).toBeNull();
  });

  it('rejects STAGING-mode maintenance recovery while PRODUCTION is running', async () => {
    const state = harness('SUCCEEDED');

    await expect(
      state.reconciler.recoverUnsatisfiableProductionQualifications('operator')
    ).rejects.toThrow(
      'requires PRODUCTION to be paused while STAGING remains enabled'
    );
    expect(
      state.service.yieldUnsatisfiableProductionQualification
    ).not.toHaveBeenCalled();
  });

  it('allows a coupled qualification to replace both unrelated staging repositories', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? 'e'.repeat(40) : 'f'.repeat(40)
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_base_sha: '1'.repeat(40),
        backend_base_sha: '2'.repeat(40),
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
  });

  it('starts exact production qualification after unchanged staging matches the target', async () => {
    const state = harness('SUCCEEDED');
    state.repository.trains.set(
      'train-1',
      train('train-1', { lane: 'PRODUCTION_QUALIFICATION' })
    );
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'frontend-candidate'
      )!
    );
    mockResolveRefIfExists.mockImplementation(
      async (repository: 'frontend' | 'backend') =>
        repository === 'frontend' ? 'e'.repeat(40) : BACKEND_SHA
    );
    const context = {
      train: state.repository.trains.get('train-1')!,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advanceStagingOrQualification(input: typeof context): Promise<void>;
      }
    ).advanceStagingOrQualification(context);

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'DEPLOYING',
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: BACKEND_SHA
      })
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_ENVIRONMENT_IDENTITY_BOUND',
        trainId: 'train-1',
        payload: expect.objectContaining({
          frontend_sha: FRONTEND_SHA,
          backend_sha: BACKEND_SHA,
          backend_from_existing_staging: false
        })
      })
    );
  });

  it('releases the production beta lock when the post-lock idle snapshot fails', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    let resolveCalls = 0;
    mockResolveRef.mockImplementation(async (repository: string) => {
      resolveCalls += 1;
      if (resolveCalls > 2) throw new Error('GitHub ref lookup failed');
      return repository === 'frontend' ? FRONTEND_SHA : BACKEND_SHA;
    });

    await expect(
      (
        state.reconciler as unknown as {
          advanceProduction(input: typeof context): Promise<void>;
        }
      ).advanceProduction(context)
    ).rejects.toThrow('GitHub ref lookup failed');
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.lock.lease_token).toBeNull();
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
    if (previousBetaAllowlist === undefined)
      delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    else process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = previousBetaAllowlist;
  });

  it('serializes only dependency edges, binds E2E to the exact manifest, and is duplicate-safe', async () => {
    const state = harness('SUCCEEDED');
    let activeBackend = 0;
    let maximumBackend = 0;
    const sequence: string[] = [];
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        service: string | null;
        inputs: Record<string, string>;
        artifactDigest: string | null;
      };
      if (typed.operationType.startsWith('DEPLOY_BACKEND')) {
        activeBackend += 1;
        maximumBackend = Math.max(maximumBackend, activeBackend);
        sequence.push(`start:${typed.service}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        sequence.push(`finish:${typed.service}`);
        activeBackend -= 1;
        const completed = operation(
          'train-1',
          typed.operationType,
          'backend',
          `backend-${typed.service}`,
          typed.service
        );
        state.repository.operations.push(completed);
        return completed;
      }
      if (typed.operationType === 'DEPLOY_FRONTEND_STAGING') {
        sequence.push('start:frontend');
        const completed = operation(
          'train-1',
          typed.operationType,
          'frontend',
          'frontend-deploy'
        );
        state.repository.operations.push(completed);
        return completed;
      }
      expect(typed.inputs.release_manifest_id).toBe('manifest-1');
      expect(typed.inputs.frontend_sha).toBe(FRONTEND_SHA);
      expect(typed.inputs.backend_sha).toBe(BACKEND_SHA);
      expect(typed.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
      const completed = operation(
        'train-1',
        'E2E_STAGING',
        'frontend',
        'e2e-run'
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-success');

    expect(state.repository.trains.get('train-1')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(state.repository.candidates.get('backend-candidate')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(state.repository.candidates.get('frontend-candidate')?.status).toBe(
      'STAGING_VALIDATED'
    );
    const manifest = Array.from(state.repository.manifests.values())[0];
    expect(manifest).toEqual(
      expect.objectContaining({
        status: 'STAGING_VALIDATED',
        frontend_sha: FRONTEND_SHA,
        backend_sha: BACKEND_SHA,
        frontend_artifact_digest: FRONTEND_DIGEST,
        backend_artifact_digest: BACKEND_DIGEST,
        e2e_run_id: 'e2e-run'
      })
    );
    expect(maximumBackend).toBe(2);
    expect(sequence.indexOf('start:api')).toBeGreaterThan(
      sequence.indexOf('finish:dbMigrationsLoop')
    );
    expect(sequence.indexOf('start:frontend')).toBeGreaterThan(
      sequence.indexOf('finish:api')
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_IDLE_HANDSHAKE',
        trainId: 'train-1'
      })
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'STAGING_FINAL_FENCE_VERIFIED',
        trainId: 'train-1'
      })
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);

    const externalCalls = mockReconcileWorkflow.mock.calls.length;
    await state.reconciler.runOnce('acceptance-duplicate');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(externalCalls);
  });

  it('ignores every exact retried workflow attempt in the final staging fence', async () => {
    const state = harness('SUCCEEDED');
    mockFindWorkflowRun.mockResolvedValue({ id: 101 });
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        operationType: string;
        service: string | null;
      };
      const repository =
        typed.operationType.includes('FRONTEND') ||
        typed.operationType === 'E2E_STAGING'
          ? 'frontend'
          : 'backend';
      const completed = operation(
        'train-1',
        typed.operationType,
        repository,
        typed.operationType === 'E2E_STAGING'
          ? '202'
          : `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      const retried =
        typed.operationType === 'E2E_STAGING'
          ? {
              ...completed,
              idempotency_key: 'rb2:train-1:e2e:staging',
              attempt: 2,
              max_attempts: 2,
              request_json: { workflow: 'staging-e2e.yml' }
            }
          : completed;
      state.repository.operations.push(retried);
      return retried;
    });

    await state.reconciler.runOnce('acceptance-retried-final-fence');

    expect(state.repository.trains.get('train-1')?.status).toBe(
      'STAGING_VALIDATED'
    );
    expect(mockFindWorkflowRun).toHaveBeenCalledWith(
      'frontend',
      'staging-e2e.yml',
      'rb2:train-1:e2e:staging:a1'
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);
    for (const [, , ignoredRunIds] of mockHasStagingRunSince.mock.calls) {
      expect(ignoredRunIds).toEqual(expect.arrayContaining(['101', '202']));
    }
  });

  it('fails closed when an unrelated staging workflow ran after the beta handshake', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'frontend-only-fence',
        candidate_id: '11111111-1111-4111-8111-111111111111',
        repository: 'frontend',
        branch_name: 'agent/rb2-beta-frontend-fence',
        operator: 'beta-operator',
        lanes: ['STAGING']
      }
    ]);
    mockHasStagingRunSince.mockResolvedValue(true);
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ||
          typed.operationType === 'E2E_STAGING'
          ? 'frontend'
          : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-beta-final-fence');

    expect(state.repository.trains.get('train-1')).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        failure_message: expect.stringContaining('Shared staging')
      })
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status === 'READY_FOR_STAGING'
      )
    ).toBe(true);
    expect(Array.from(state.repository.manifests.values())[0]?.status).toBe(
      'FAILED'
    );
    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'ALL',
      true,
      expect.stringContaining('control-plane failure'),
      'release-bus-v2'
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'BETA_STAGING_FINAL_FENCE_VIOLATED',
        trainId: 'train-1'
      })
    );
    const expectedRunIds = new Set(
      state.repository.operations
        .map(({ external_id }) => external_id)
        .filter((runId): runId is string => runId !== null)
    );
    expect(mockHasStagingRunSince).toHaveBeenCalledTimes(2);
    for (const [, , ignoredRunIds] of mockHasStagingRunSince.mock.calls) {
      expect(ignoredRunIds).toHaveLength(expectedRunIds.size);
      expect(new Set(ignoredRunIds as string[])).toEqual(expectedRunIds);
    }
  });

  it('keeps staging locked and prevents a second mutation while exact E2E is running', async () => {
    const state = harness('RUNNING');
    state.repository.trains.set(
      'train-2',
      train('train-2', { created_at: 2, updated_at: 2 })
    );
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      if (typed.operationType === 'E2E_STAGING') {
        const running = {
          ...operation('train-1', 'E2E_STAGING', 'frontend', 'e2e-running'),
          status: 'RUNNING' as const,
          completed_at: null
        };
        state.repository.operations.push(running);
        return running;
      }
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ? 'frontend' : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-lock');

    expect(state.repository.trains.get('train-1')?.status).toBe('E2E_RUNNING');
    expect(state.repository.trains.get('train-2')?.status).toBe(
      'WAITING_FOR_ENVIRONMENT'
    );
    expect(state.repository.lock.owner_train_id).toBe('train-1');
    expect(
      mockReconcileWorkflow.mock.calls.some(
        ([spec]) =>
          (spec as { trainId?: string }).trainId === 'train-2' &&
          (spec as { operationType?: string }).operationType?.startsWith(
            'DEPLOY'
          )
      )
    ).toBe(false);
  });

  it('never marks a failed E2E manifest staging validated or globally pauses', async () => {
    const state = harness('FAILED');
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as { operationType: string; service: string | null };
      if (typed.operationType === 'E2E_STAGING') {
        const failed = {
          ...operation('train-1', 'E2E_STAGING', 'frontend', 'e2e-failed'),
          status: 'FAILED' as const,
          failure_class: 'E2E' as const,
          failure_message: 'read-only pack failed'
        };
        state.repository.operations.push(failed);
        return failed;
      }
      const completed = operation(
        'train-1',
        typed.operationType,
        typed.operationType.includes('FRONTEND') ? 'frontend' : 'backend',
        `run-${typed.service ?? typed.operationType}`,
        typed.service
      );
      state.repository.operations.push(completed);
      return completed;
    });

    await state.reconciler.runOnce('acceptance-e2e-failure');

    expect(state.repository.trains.get('train-1')?.status).toBe('FAILED');
    expect(Array.from(state.repository.manifests.values())[0]?.status).toBe(
      'STAGING_DEPLOYED'
    );
    expect(state.service.setPaused).not.toHaveBeenCalled();
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status !== 'STAGING_VALIDATED'
      )
    ).toBe(true);
  });

  it('requeues a production plan when candidate-bearing main moves before qualification', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(production.id, production);
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
        current_train_id: production.id
      });
    }
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await state.reconciler.runOnce('acceptance-production-main-moved');

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        failure_class: 'INTERACTION',
        failure_message: expect.stringContaining('frontend main moved')
      })
    );
    expect(
      Array.from(state.repository.candidates.values()).map(
        ({ status, current_train_id }) => ({ status, current_train_id })
      )
    ).toEqual([
      { status: 'READY_FOR_PRODUCTION', current_train_id: null },
      { status: 'READY_FOR_PRODUCTION', current_train_id: null }
    ]);
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.lock.owner_train_id).toBeNull();
  });

  it('waits for dispatched composition before requeueing a moved production plan', async () => {
    const state = harness('SUCCEEDED');
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    const production = train('train-1', {
      lane: 'PRODUCTION',
      status: 'COMPOSING',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    state.repository.trains.set(production.id, production);
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        status: 'PRODUCTION_BUILDING_OR_QUALIFYING',
        current_train_id: production.id
      });
    }
    const running = {
      ...operation(
        production.id,
        'COMPOSE_FRONTEND',
        'frontend',
        'running-compose'
      ),
      status: 'RUNNING' as const,
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'release-bus-v2/production-train-train-1-frontend',
        inputs: {
          release_train_id: production.id,
          expected_sha: FRONTEND_SHA
        }
      },
      completed_at: null
    };
    state.repository.operations.push(running);
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await state.reconciler.runOnce('acceptance-production-main-moved-running');
    await state.reconciler.runOnce(
      'acceptance-production-main-moved-running-again'
    );

    expect(state.repository.trains.get(production.id)).toEqual(
      expect.objectContaining({
        status: 'COMPOSING',
        recovery_message: expect.stringContaining(
          'waiting for already-dispatched orchestration'
        )
      })
    );
    expect(
      state.repository.operations.find(({ id }) => id === running.id)?.status
    ).toBe('RUNNING');
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(3);
    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: running.idempotency_key,
        operationType: running.operation_type
      })
    );
    expect(state.repository.operations).toHaveLength(3);

    const runningIndex = state.repository.operations.findIndex(
      ({ id }) => id === running.id
    );
    state.repository.operations[runningIndex] = {
      ...state.repository.operations[runningIndex],
      status: 'SUCCEEDED',
      completed_at: Date.now(),
      row_version: state.repository.operations[runningIndex].row_version + 1
    };
    await state.reconciler.runOnce('acceptance-production-main-moved-terminal');

    expect(state.repository.trains.get(production.id)?.status).toBe(
      'CANCELLED'
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        ({ status, current_train_id }) =>
          status === 'READY_FOR_PRODUCTION' && current_train_id === null
      )
    ).toBe(true);
    expect(mockReconcileWorkflow).toHaveBeenCalledTimes(3);
    expect(state.repository.operations).toHaveLength(3);
  });

  it('never mutates production when either exact main base moved', async () => {
    const state = harness('SUCCEEDED');
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend' ? '9'.repeat(40) : production.backend_base_sha
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceProductionRefs(input: typeof context): Promise<void>;
        }
      ).advanceProductionRefs(context)
    ).rejects.toThrow('main moved');
    expect(mockUpdateRef).not.toHaveBeenCalled();
  });

  it('terminalizes a rejected exact main update and safely releases its production lock', async () => {
    const state = harness('SUCCEEDED');
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    state.repository.memberships.forEach((membership, index) => {
      state.repository.memberships[index] = {
        ...membership,
        train_id: production.id
      };
    });
    state.repository.lock = {
      ...state.repository.lock,
      name: 'production-environment'
    };
    await state.repository.acquireLock(
      'production-environment',
      production.id,
      `train:${production.id}`
    );
    mockResolveRef.mockResolvedValue(production.backend_base_sha);
    mockUpdateRef.mockRejectedValue(
      new Error('Repository rule violations found')
    );

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).rejects.toThrow('Repository rule violations found');

    const mainOperation = state.repository.operations.find(
      (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
    );
    expect(mainOperation).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failure_class: 'CONTROL_PLANE',
        completed_at: expect.any(Number)
      })
    );

    await (
      state.reconciler as unknown as {
        failTrain(
          input: ReleaseBusV2TrainRecord,
          failureClass: 'CONTROL_PLANE',
          message: string
        ): Promise<void>;
      }
    ).failTrain(production, 'CONTROL_PLANE', 'ruleset rejected update');

    expect(state.repository.lock.owner_train_id).toBeNull();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'TERMINAL_ENVIRONMENT_LOCK_RELEASED',
        trainId: production.id,
        payload: expect.objectContaining({
          lock: 'production-environment',
          train_status: 'FAILED'
        })
      })
    );
  });

  it('accepts an exact main update that succeeded before its transport error', async () => {
    const state = harness('SUCCEEDED');
    const production = train('accepted-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    mockUpdateRef.mockRejectedValue(new Error('response connection reset'));
    mockResolveRef.mockResolvedValue(production.backend_composed_sha);

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).resolves.toBeUndefined();

    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        external_id: production.backend_composed_sha,
        completed_at: expect.any(Number)
      })
    );
  });

  it('bounds exact main infrastructure retries in the durable operation', async () => {
    const state = harness('SUCCEEDED');
    const production = train('retry-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    const infrastructureError = new Error('GitHub returned 503');
    infrastructureError.name = 'ReleaseBusGitHubInfrastructureError';
    mockUpdateRef.mockRejectedValue(infrastructureError);
    mockResolveRef.mockResolvedValue(production.backend_base_sha);
    const advance = () =>
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(
        production,
        'backend',
        production.backend_base_sha ?? ''
      );

    await expect(advance()).rejects.toThrow('GitHub returned 503');
    await expect(advance()).rejects.toThrow('GitHub returned 503');
    await expect(advance()).rejects.toThrow('GitHub returned 503');

    expect(mockUpdateRef).toHaveBeenCalledTimes(3);
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        attempt: 3,
        max_attempts: 3,
        failure_class: 'INFRASTRUCTURE',
        completed_at: expect.any(Number)
      })
    );
  });

  it('cancels a main operation when its post-failure ref is an unexpected third SHA', async () => {
    const state = harness('SUCCEEDED');
    const production = train('moved-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    state.repository.trains.set(production.id, production);
    mockUpdateRef.mockRejectedValue(new Error('update rejected'));
    mockResolveRef.mockResolvedValue('9'.repeat(40));

    await expect(
      (
        state.reconciler as unknown as {
          advanceMainRef(
            input: ReleaseBusV2TrainRecord,
            repository: 'backend',
            observedSha: string
          ): Promise<void>;
        }
      ).advanceMainRef(production, 'backend', production.backend_base_sha ?? '')
    ).rejects.toThrow('main moved');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )
    ).toEqual(
      expect.objectContaining({
        status: 'CANCELLED',
        failure_class: 'INTERACTION',
        completed_at: expect.any(Number)
      })
    );
  });

  it('pauses for exact reconciliation after a partial multi-repository main advance', async () => {
    const state = harness('SUCCEEDED');
    const production = train('partial-production', {
      lane: 'PRODUCTION',
      status: 'MERGING_PRODUCTION'
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'backend'
        ? production.backend_base_sha
        : production.frontend_base_sha
    );
    mockUpdateRef.mockImplementation(async (repository: string) => {
      if (repository === 'frontend')
        throw new Error('frontend update rejected');
    });
    let frontendReads = 0;
    mockResolveRef.mockImplementation(async (repository: string) => {
      if (repository === 'backend') return production.backend_base_sha;
      frontendReads += 1;
      return frontendReads > 1 ? '9'.repeat(40) : production.frontend_base_sha;
    });

    await expect(
      (
        state.reconciler as unknown as {
          advanceProductionRefs(input: typeof context): Promise<void>;
        }
      ).advanceProductionRefs(context)
    ).rejects.toThrow('Partial production main advance: backend');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_BACKEND'
      )?.status
    ).toBe('SUCCEEDED');
    expect(
      state.repository.operations.find(
        (item) => item.operation_type === 'ADVANCE_MAIN_FRONTEND'
      )?.status
    ).toBe('CANCELLED');
  });

  it('pauses only automation and requeues candidates on a control-plane defect', async () => {
    const state = harness('SUCCEEDED');
    mockReconcileWorkflow.mockRejectedValue(
      new Error('structured callback protocol mismatch')
    );

    await state.reconciler.runOnce('acceptance-control-plane');

    expect(state.repository.trains.get('train-1')?.status).toBe('FAILED');
    expect(state.service.setPaused).toHaveBeenCalledWith(
      'ALL',
      true,
      expect.stringContaining('structured callback protocol mismatch'),
      'release-bus-v2'
    );
    expect(
      Array.from(state.repository.candidates.values()).every(
        (item) => item.status === 'READY_FOR_STAGING'
      )
    ).toBe(true);
    expect(mockEnsureCommitStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'error',
      expect.stringContaining('control_plane failure'),
      'Release Bus v2'
    );
  });

  it('bisects a real composed-code failure and quarantines only an interaction set', async () => {
    const state = harness('SUCCEEDED');
    state.repository.candidates.clear();
    state.repository.memberships.length = 0;
    state.repository.trains.set(
      'train-1',
      train('train-1', {
        status: 'PREFLIGHTING',
        frontend_composed_sha: FRONTEND_SHA,
        backend_composed_sha: null,
        frontend_artifact_digest: null,
        backend_artifact_digest: null
      })
    );
    const backendBase =
      state.repository.trains.get('train-1')?.backend_base_sha;
    if (!backendBase) throw new Error('test backend base is missing');
    const candidates = ['a', 'b', 'c', 'd'].map((id, index) => ({
      ...candidate(id, 'backend', { units: ['api'], edges: [] }),
      pr_number: 100 + index,
      head_sha: String(index + 3).repeat(40),
      pr_evidence_json: {
        base_sha: backendBase,
        merge_sha: String(index + 7).repeat(40),
        checks_run_id: String(200 + index),
        checks_completed_at: 1,
        artifact_run_id: null,
        artifact_name: null,
        artifact_digest: null
      }
    }));
    candidates.forEach((item, index) => {
      state.repository.candidates.set(item.id, item);
      state.repository.memberships.push({
        id: `membership-${item.id}`,
        train_id: 'train-1',
        candidate_id: item.id,
        sequence: index + 1,
        disposition: 'INCLUDED',
        created_at: 1
      });
    });
    mockReconcileWorkflow.mockImplementation(async (spec) => {
      const typed = spec as {
        idempotencyKey: string;
        operationType: string;
        expectedSha: string;
      };
      if (typed.operationType === 'ISOLATE_COMPOSE_BACKEND')
        return {
          ...operation(
            'train-1',
            typed.operationType,
            'backend',
            `compose-${typed.idempotencyKey}`
          ),
          expected_sha: typed.expectedSha,
          result_json: {
            summary: {
              composed_sha: 'e'.repeat(40),
              excluded_shas: []
            }
          }
        };
      const failedLeft = typed.idempotencyKey.includes(':backend:0:preflight');
      return {
        ...operation(
          'train-1',
          typed.operationType,
          'backend',
          `preflight-${typed.idempotencyKey}`
        ),
        status: failedLeft ? ('FAILED' as const) : ('SUCCEEDED' as const),
        failure_class: failedLeft ? ('CANDIDATE' as const) : null,
        failure_message: failedLeft ? 'composed tests failed' : null
      };
    });
    const context = {
      train: state.repository.trains.get('train-1') as ReleaseBusV2TrainRecord,
      memberships: state.repository.memberships,
      candidates,
      dependencies: []
    };

    await (
      state.reconciler as unknown as {
        reconcileCandidateIsolation(
          input: typeof context,
          repository: 'backend'
        ): Promise<void>;
      }
    ).reconcileCandidateIsolation(context, 'backend');

    expect(state.repository.trains.get('train-1')).toMatchObject({
      status: 'FAILED',
      failure_class: 'INTERACTION'
    });
    expect(state.repository.candidates.get('a')).toMatchObject({
      status: 'FAILED',
      hold_reason: expect.stringContaining('COMBINATION_FAILED')
    });
    expect(state.repository.candidates.get('b')?.status).toBe('FAILED');
    expect(state.repository.candidates.get('c')?.status).toBe(
      'READY_FOR_STAGING'
    );
    expect(state.repository.candidates.get('d')?.status).toBe(
      'READY_FOR_STAGING'
    );
    expect(
      state.repository.memberships.find((item) => item.candidate_id === 'a')
        ?.disposition
    ).toBe('COMBINATION_FAILED');
    expect(
      state.repository.memberships.find((item) => item.candidate_id === 'c')
        ?.disposition
    ).toBe('RETURNED_TO_QUEUE');
  });

  it('has no base-canary operation in the normal reconciler path', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/releaseBusV2/release-bus-v2.reconciler.ts'),
      'utf8'
    );
    expect(source).not.toContain('BASE_CANARY');
  });

  it('reuses only the exact common staging manifest before production composition', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'validated-common-manifest';
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        staging_validated_manifest_id: manifestId,
        staging_validated_train_id: 'train-1'
      });
    }
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: 'train-1',
      lane: 'STAGING',
      identity_sha256: 'f'.repeat(64),
      status: 'STAGING_VALIDATED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: 'validated-e2e',
      manifest_json: {},
      deployed_at: 2,
      validated_at: 3,
      created_at: 2,
      updated_at: 3
    });
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };
    const findExact = (
      state.reconciler as unknown as {
        findExactValidatedProductionManifest(
          input: typeof context
        ): Promise<ReleaseBusV2ManifestRecord | null>;
      }
    ).findExactValidatedProductionManifest.bind(state.reconciler);

    await expect(findExact(context)).resolves.toMatchObject({
      id: manifestId,
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA
    });

    const validatedManifest = state.repository.manifests.get(manifestId);
    if (!validatedManifest) throw new Error('Missing validated manifest');
    state.repository.manifests.set(manifestId, {
      ...validatedManifest,
      status: 'STAGING_DEPLOYED'
    });
    await expect(findExact(context)).resolves.toBeNull();
    state.repository.manifests.delete(manifestId);
    await expect(findExact(context)).resolves.toBeNull();
    state.repository.manifests.set(manifestId, validatedManifest);
    const sourceTrain = state.repository.trains.get('train-1');
    if (!sourceTrain) throw new Error('Missing source train');
    state.repository.trains.delete('train-1');
    await expect(findExact(context)).resolves.toBeNull();
    state.repository.trains.set('train-1', sourceTrain);

    state.repository.memberships.push({
      id: 'unselected-source-membership',
      train_id: 'train-1',
      candidate_id: 'not-in-production-subset',
      sequence: 3,
      disposition: 'INCLUDED',
      created_at: 1
    });
    await expect(findExact(context)).resolves.toBeNull();
    state.repository.memberships.pop();
    await expect(
      findExact({
        ...context,
        train: { ...production, backend_base_sha: '9'.repeat(40) }
      })
    ).resolves.toBeNull();

    const frontendSourceMembershipIndex =
      state.repository.memberships.findIndex(
        ({ candidate_id }) => candidate_id === 'frontend-candidate'
      );
    if (frontendSourceMembershipIndex < 0)
      throw new Error('Missing frontend source membership');
    state.repository.memberships[frontendSourceMembershipIndex] = {
      ...state.repository.memberships[frontendSourceMembershipIndex],
      disposition: 'EXCLUDED'
    };
    const backendOnly = {
      ...context,
      memberships: context.memberships.filter(
        ({ candidate_id }) => candidate_id === 'backend-candidate'
      ),
      candidates: context.candidates.filter(
        ({ repository }) => repository === 'backend'
      ),
      dependencies: []
    };
    await expect(findExact(backendOnly)).resolves.toBeNull();
    state.repository.manifests.set(manifestId, {
      ...(state.repository.manifests.get(
        manifestId
      ) as ReleaseBusV2ManifestRecord),
      frontend_sha: production.frontend_base_sha,
      frontend_artifact_digest: null
    });
    await expect(findExact(backendOnly)).resolves.toMatchObject({
      id: manifestId
    });
  });

  it('prepares production from the exact staging manifest without workflows', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'validated-production-manifest';
    for (const [id, current] of Array.from(
      state.repository.candidates.entries()
    )) {
      state.repository.candidates.set(id, {
        ...current,
        staging_validated_manifest_id: manifestId,
        staging_validated_train_id: 'train-1'
      });
    }
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: 'train-1',
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_VALIDATED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: 'validated-e2e',
      manifest_json: {},
      deployed_at: 2,
      validated_at: 3,
      created_at: 2,
      updated_at: 3
    });
    const production = train('production-train', {
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null
    });
    mockResolveRef.mockImplementation(async (repository: string) =>
      repository === 'frontend'
        ? production.frontend_base_sha
        : production.backend_base_sha
    );
    state.repository.trains.set(production.id, production);
    const context = {
      train: production,
      memberships: state.repository.memberships.map((item) => ({
        ...item,
        train_id: production.id
      })),
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        advancePreparation(input: typeof context): Promise<void>;
      }
    ).advancePreparation(context);

    expect(state.repository.trains.get(production.id)).toMatchObject({
      status: 'PREPARED',
      frontend_composed_sha: FRONTEND_SHA,
      backend_composed_sha: BACKEND_SHA,
      manifest_id: manifestId
    });
    expect(
      Array.from(state.repository.candidates.values()).map(
        ({ status }) => status
      )
    ).toEqual([
      'PRODUCTION_BUILDING_OR_QUALIFYING',
      'PRODUCTION_BUILDING_OR_QUALIFYING'
    ]);
    expect(mockReconcileWorkflow).not.toHaveBeenCalled();
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        trainId: production.id,
        eventType: 'EXACT_STAGING_MANIFEST_REUSED'
      })
    );
    expect(state.repository.events).toContainEqual(
      expect.objectContaining({
        eventType: 'EXACT_STAGING_MANIFEST_REUSED',
        payload: expect.objectContaining({
          manifest_identity_sha256: 'e'.repeat(64)
        })
      })
    );
  });

  it('runs staging E2E from the immutable exact-composition release ref', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'exact-workflow-manifest';
    const exactTrain = train('train-1', { manifest_id: manifestId });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: exactTrain.id,
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_DEPLOYED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: FRONTEND_DIGEST,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: null,
      manifest_json: {},
      deployed_at: 2,
      validated_at: null,
      created_at: 2,
      updated_at: 2
    });
    const releaseRef = `release-bus-v2/staging-train-${exactTrain.id}-frontend`;
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) =>
        repository === 'frontend' && ref === releaseRef ? FRONTEND_SHA : null
    );
    mockReconcileWorkflow.mockResolvedValue(
      operation(exactTrain.id, 'E2E_STAGING', 'frontend', 'exact-e2e')
    );
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        reconcileE2E(
          input: typeof context,
          environment: 'staging'
        ): Promise<ReleaseBusV2OperationRecord>;
      }
    ).reconcileE2E(context, 'staging');

    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'E2E_STAGING',
        ref: releaseRef,
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: releaseRef,
          expected_sha: FRONTEND_SHA
        })
      })
    );
  });

  it('runs backend-only staging E2E from the exact shared staging ref when main moved', async () => {
    const state = harness('SUCCEEDED');
    const manifestId = 'backend-only-workflow-manifest';
    const exactTrain = train('train-1', {
      manifest_id: manifestId,
      frontend_artifact_digest: null
    });
    state.repository.trains.set(exactTrain.id, exactTrain);
    state.repository.memberships.splice(
      0,
      state.repository.memberships.length,
      state.repository.memberships.find(
        ({ candidate_id }) => candidate_id === 'backend-candidate'
      )!
    );
    state.repository.manifests.set(manifestId, {
      id: manifestId,
      train_id: exactTrain.id,
      lane: 'STAGING',
      identity_sha256: 'e'.repeat(64),
      status: 'STAGING_DEPLOYED',
      frontend_sha: FRONTEND_SHA,
      backend_sha: BACKEND_SHA,
      frontend_artifact_digest: null,
      backend_artifact_digest: BACKEND_DIGEST,
      e2e_run_id: null,
      manifest_json: {},
      deployed_at: 2,
      validated_at: null,
      created_at: 2,
      updated_at: 2
    });
    mockResolveRefIfExists.mockImplementation(
      async (repository: string, ref: string) => {
        if (repository !== 'frontend') return null;
        if (ref === '1a-staging') return FRONTEND_SHA;
        if (ref === 'main') return '9'.repeat(40);
        return null;
      }
    );
    mockReconcileWorkflow.mockResolvedValue(
      operation(exactTrain.id, 'E2E_STAGING', 'frontend', 'exact-e2e')
    );
    const context = {
      train: exactTrain,
      memberships: [...state.repository.memberships],
      candidates: Array.from(state.repository.candidates.values()),
      dependencies: state.repository.dependencies
    };

    await (
      state.reconciler as unknown as {
        reconcileE2E(
          input: typeof context,
          environment: 'staging'
        ): Promise<ReleaseBusV2OperationRecord>;
      }
    ).reconcileE2E(context, 'staging');

    expect(mockReconcileWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        operationType: 'E2E_STAGING',
        ref: '1a-staging',
        expectedSha: FRONTEND_SHA,
        inputs: expect.objectContaining({
          source_ref: '1a-staging',
          expected_sha: FRONTEND_SHA
        })
      })
    );
  });

  it('proves exact four-way Jest inventory in the combined preflight', () => {
    const workflow = readFileSync(
      path.join(
        process.cwd(),
        '.github/workflows/release-bus-v2-preflight.yml'
      ),
      'utf8'
    );
    expect(workflow).toContain(
      'shard: [lint, typecheck, inventory, tests-1, tests-2, tests-3, tests-4]'
    );
    expect(workflow).toContain(
      "matrix.shard == 'typecheck' || startsWith(matrix.shard, 'tests-')"
    );
    expect(workflow).toContain(
      'npm --prefix src/api-serverless ci --ignore-scripts'
    );
    expect(workflow).toContain('uniq -d shards.sorted');
    expect(workflow).toContain('diff -u complete.sorted shards.sorted');
    expect(workflow).toContain("steps.inventory_verify.outcome == 'success'");
  });

  it('reuses parent artifacts during exact production qualification', () => {
    const source = readFileSync(
      path.join(__dirname, 'release-bus-v2.reconciler.ts'),
      'utf8'
    );
    expect(source).toContain('if (storedComposedSha && storedArtifactDigest)');
    expect(source).toContain(
      'const sourceTrainId = train.parent_train_id ?? train.id'
    );
  });
});
