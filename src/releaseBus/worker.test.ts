const mockFindCandidateById = jest.fn();
const mockUpdateCandidateLifecycle = jest.fn();
const mockAddEvidence = jest.fn();
const mockHasTrainEvidence = jest.fn();
const mockListBaseCanaryEvidenceBySha = jest.fn();
const mockEnsureCommitStatus = jest.fn();
const mockCommentOnPullRequest = jest.fn();
const mockRefContainsCommit = jest.fn();
const mockUpdateTrain = jest.fn();
const mockAdvanceTrainPhase = jest.fn();
const mockGetLane = jest.fn();
const mockReleaseLane = jest.fn();
const mockAppendEvent = jest.fn();
const mockPublishReleaseBusMetrics = jest.fn();
const mockFindTrain = jest.fn();
const mockListTrainItems = jest.fn();
const mockHeartbeatLane = jest.fn();
const mockListControls = jest.fn();
const mockListTrainOperations = jest.fn();
const mockListTrainEvents = jest.fn();
const mockGetOrCreateOperation = jest.fn();
const mockFindOperation = jest.fn();
const mockUpdateOperation = jest.fn();
const mockUpdateOperationIfVersion = jest.fn();
const mockSetControl = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockResolveRef = jest.fn();
const mockUpdateRef = jest.fn();
const mockFindWorkflowRun = jest.fn();
const mockDispatchWorkflow = jest.fn();
const mockGetFileContent = jest.fn();
const mockGetActionsVariable = jest.fn();

jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    findCandidateById: (...args: unknown[]) => mockFindCandidateById(...args),
    updateCandidateLifecycle: (...args: unknown[]) =>
      mockUpdateCandidateLifecycle(...args),
    addEvidence: (...args: unknown[]) => mockAddEvidence(...args),
    hasTrainEvidence: (...args: unknown[]) => mockHasTrainEvidence(...args),
    listBaseCanaryEvidenceBySha: (...args: unknown[]) =>
      mockListBaseCanaryEvidenceBySha(...args),
    updateTrain: (...args: unknown[]) => mockUpdateTrain(...args),
    advanceTrainPhase: (...args: unknown[]) => mockAdvanceTrainPhase(...args),
    getLane: (...args: unknown[]) => mockGetLane(...args),
    releaseLane: (...args: unknown[]) => mockReleaseLane(...args),
    appendEvent: (...args: unknown[]) => mockAppendEvent(...args),
    findTrain: (...args: unknown[]) => mockFindTrain(...args),
    listTrainItems: (...args: unknown[]) => mockListTrainItems(...args),
    heartbeatLane: (...args: unknown[]) => mockHeartbeatLane(...args),
    listControls: (...args: unknown[]) => mockListControls(...args),
    listTrainOperations: (...args: unknown[]) =>
      mockListTrainOperations(...args),
    listTrainEvents: (...args: unknown[]) => mockListTrainEvents(...args),
    getOrCreateOperation: (...args: unknown[]) =>
      mockGetOrCreateOperation(...args),
    findOperation: (...args: unknown[]) => mockFindOperation(...args),
    updateOperation: (...args: unknown[]) => mockUpdateOperation(...args),
    updateOperationIfVersion: (...args: unknown[]) =>
      mockUpdateOperationIfVersion(...args),
    setControl: (...args: unknown[]) => mockSetControl(...args),
    executeNativeQueriesInTransaction: (...args: unknown[]) =>
      mockExecuteTransaction(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args),
    commentOnPullRequest: (...args: unknown[]) =>
      mockCommentOnPullRequest(...args),
    refContainsCommit: (...args: unknown[]) => mockRefContainsCommit(...args),
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    updateRef: (...args: unknown[]) => mockUpdateRef(...args),
    findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args),
    dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args),
    getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    getActionsVariable: (...args: unknown[]) => mockGetActionsVariable(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.metrics', () => ({
  publishReleaseBusMetrics: (...args: unknown[]) =>
    mockPublishReleaseBusMetrics(...args)
}));

import type {
  ReleaseCandidateRecord,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';
import {
  buildFrontendGateContract,
  FRONTEND_BASE_IDENTITY_WORKFLOW,
  FRONTEND_GATE_BASE_FILES,
  FRONTEND_GATE_TOOLING_FILES,
  FRONTEND_GATE_WORKFLOW,
  FRONTEND_PREFLIGHT_WORKFLOW,
  FRONTEND_STAGING_DEPLOY_WORKFLOW,
  FRONTEND_STAGING_E2E_WORKFLOW
} from '@/releaseBus/release-bus.base-canary-evidence';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  advanceBackendDeploy,
  advanceReleaseTrain,
  backendDeployGraph,
  baseCanaryInfrastructureRetryDelayMs,
  finishIncompleteComposition,
  finishStaging,
  frontendArtifactEnvironment,
  mergeWorkflowProgress,
  operationFailureReason,
  promoteSuccessfulStagingBaseEvidence,
  reconcile,
  workflowProgress
} from '@/releaseBus/worker';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('operationFailureReason', () => {
  it('includes a trusted GitHub Actions evidence URL', () => {
    expect(
      operationFailureReason('Frontend base failed.', {
        result_metadata_json: {
          url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
        }
      } as never)
    ).toBe(
      'Frontend base failed. Evidence: https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
    );
  });

  it('does not publish an untrusted evidence URL', () => {
    expect(
      operationFailureReason('Frontend base failed.', {
        result_metadata_json: { url: 'https://example.com/untrusted' }
      } as never)
    ).toBe('Frontend base failed.');
  });
});

describe('base canary infrastructure retry backoff', () => {
  it('retries the first two failures promptly and then caps its backoff', () => {
    expect(baseCanaryInfrastructureRetryDelayMs(1)).toBe(0);
    expect(baseCanaryInfrastructureRetryDelayMs(2)).toBe(0);
    expect(baseCanaryInfrastructureRetryDelayMs(3)).toBe(5 * 60_000);
    expect(baseCanaryInfrastructureRetryDelayMs(4)).toBe(10 * 60_000);
    expect(baseCanaryInfrastructureRetryDelayMs(50)).toBe(10 * 60_000);
  });
});

describe('frontend immutable artifact selection', () => {
  it('reuses the train target profile through staging and production deploys', () => {
    expect(frontendArtifactEnvironment({ target_lane: 'STAGING' })).toBe(
      'staging'
    );
    expect(frontendArtifactEnvironment({ target_lane: 'PRODUCTION' })).toBe(
      'production'
    );
  });
});

describe('workflowProgress', () => {
  it('records the active and failed GitHub job and step without raw logs', () => {
    expect(
      workflowProgress({
        id: 12345,
        name: 'Release Bus base canary',
        display_title: 'Base canary',
        status: 'completed',
        conclusion: 'failure',
        head_sha: SHA_A,
        html_url:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
        created_at: '2026-07-21T10:00:00Z',
        updated_at: '2026-07-21T10:05:00Z',
        jobs: [
          {
            id: 1,
            name: 'Frontend gate',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2026-07-21T10:01:00Z',
            completed_at: '2026-07-21T10:05:00Z',
            html_url:
              'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345/job/1',
            steps: [
              {
                name: 'Run unit tests',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-07-21T10:02:00Z',
                completed_at: '2026-07-21T10:05:00Z'
              }
            ]
          }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        failed_job: 'Frontend gate',
        failed_step: 'Run unit tests',
        last_progress_at: Date.parse('2026-07-21T10:05:00Z')
      })
    );
    expect(workflowProgress({} as never)).not.toHaveProperty('logs');
  });

  it('bounds labels and rejects future GitHub progress timestamps', () => {
    const now = Date.parse('2026-07-21T10:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const progress = workflowProgress({
        id: 12345,
        name: 'Release Bus base canary',
        display_title: 'Base canary',
        status: 'completed',
        conclusion: 'failure',
        head_sha: SHA_A,
        html_url:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
        updated_at: '2099-01-01T00:00:00Z',
        jobs: [
          {
            id: 1,
            name: `${'x'.repeat(600)}\u0000`,
            status: 'completed',
            conclusion: 'failure',
            started_at: null,
            completed_at: '2099-01-01T00:00:00Z',
            html_url: '',
            steps: []
          }
        ]
      });

      expect(progress.failed_job).toHaveLength(500);
      expect(progress.failed_job).not.toContain('\u0000');
      expect(progress.last_progress_at).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('preserves a fresher workflow-reported progress heartbeat', () => {
    const now = Date.parse('2026-07-21T10:10:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const progress = mergeWorkflowProgress(
        {
          gate_report: { phase: 'unit_tests', status: 'RUNNING' },
          last_progress_at: now - 30_000
        },
        {
          id: 12345,
          name: 'Release Bus base canary',
          display_title: 'Base canary',
          status: 'in_progress',
          conclusion: null,
          head_sha: SHA_A,
          html_url:
            'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
          updated_at: '2026-07-21T10:05:00Z'
        }
      );

      expect(progress.last_progress_at).toBe(now - 30_000);
      expect(progress.gate_report).toEqual({
        phase: 'unit_tests',
        status: 'RUNNING'
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('workflow reconciliation contention', () => {
  const operation = {
    id: 'operation-1',
    operation_key: 'train-1:r1:base-canary-frontend',
    train_id: 'train-1',
    revision: 1,
    operation_type: 'base-canary-frontend',
    repository: 'frontend',
    environment: 'orchestration',
    service: null,
    expected_sha: SHA_A,
    artifact_digest: null,
    attempt: 1,
    status: 'RUNNING',
    external_id: '12345',
    request_metadata_json: { workflow: 'release-bus-base-canary.yml' },
    result_metadata_json: {
      gate_report: { phase: 'complete', status: 'SUCCEEDED' }
    },
    started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindWorkflowRun.mockResolvedValue({
      id: 12345,
      name: 'Release Bus base canary',
      display_title: operation.operation_key,
      status: 'completed',
      conclusion: 'success',
      head_sha: SHA_A,
      html_url:
        'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
      updated_at: '2026-07-21T10:05:00Z'
    });
    mockExecuteTransaction.mockImplementation(async (callback) =>
      callback({ transaction: 'test' })
    );
    mockAppendEvent.mockResolvedValue(undefined);
  });

  it('retries a terminal GitHub result after a row-version race', async () => {
    const refreshed = { ...operation, row_version: 2 };
    const completed = {
      ...refreshed,
      status: 'SUCCEEDED',
      row_version: 3
    } as const;
    mockUpdateOperationIfVersion
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockFindOperation
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(completed);

    await expect(reconcile(operation)).resolves.toEqual(completed);

    expect(mockUpdateOperationIfVersion).toHaveBeenNthCalledWith(
      1,
      operation.operation_key,
      1,
      expect.objectContaining({ status: 'SUCCEEDED' }),
      { connection: { transaction: 'test' } }
    );
    expect(mockUpdateOperationIfVersion).toHaveBeenNthCalledWith(
      2,
      operation.operation_key,
      2,
      expect.objectContaining({ status: 'SUCCEEDED' }),
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
  });
});

describe('frontend base canary', () => {
  const frontendCandidate = candidate(
    'candidate-frontend',
    'frontend',
    SHA_A,
    1
  );
  const frozenTrain: ReleaseTrainRecord = {
    id: 'train-1',
    revision: 1,
    target_lane: 'STAGING',
    status: 'FROZEN',
    cutoff_at: 1,
    frontend_base_sha: 'd'.repeat(40),
    backend_base_sha: 'e'.repeat(40),
    frontend_release_branch: null,
    backend_release_branch: null,
    frontend_pr_number: null,
    backend_pr_number: null,
    state_machine_execution_arn: null,
    worker_version: '1',
    failure_reason: null,
    started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
  const workflowSha = 'f'.repeat(40);
  const baseFileContents = Object.fromEntries(
    FRONTEND_GATE_BASE_FILES.map((file) => [
      file,
      file === 'package.json'
        ? JSON.stringify({ packageManager: 'pnpm@10.14.0' })
        : `content:${file}`
    ])
  );
  const workflowFileContent = (file: string): string => {
    if (file === FRONTEND_GATE_WORKFLOW) return 'workflow-content';
    if (file === 'scripts/release-bus-gate-evidence.cjs')
      return `workflow-content:${file}\nBASE_EVIDENCE_CONTRACT_VERSION = 2`;
    return `workflow-content:${file}`;
  };
  const gateContract = buildFrontendGateContract({
    baseSha: frozenTrain.frontend_base_sha as string,
    workflowSha,
    workflowFileContents: Object.fromEntries(
      [
        FRONTEND_GATE_WORKFLOW,
        FRONTEND_PREFLIGHT_WORKFLOW,
        FRONTEND_BASE_IDENTITY_WORKFLOW,
        FRONTEND_STAGING_DEPLOY_WORKFLOW,
        FRONTEND_STAGING_E2E_WORKFLOW,
        ...FRONTEND_GATE_TOOLING_FILES
      ].map((file) => [file, workflowFileContent(file)])
    ),
    baseFileContents,
    gateMode: 'sharded',
    shardCount: 4,
    buildProfileDigest: 'e'.repeat(64)
  });
  const artifactDigest = '9'.repeat(64);
  const reusableSummary = {
    kind: 'base_canary_summary',
    status: 'SUCCEEDED',
    base_sha: gateContract.base_sha,
    environment: gateContract.environment,
    gate_fingerprint: gateContract.gate_fingerprint,
    behavior_digest: gateContract.behavior_digest,
    build_profile_digest: gateContract.build_profile_digest,
    workflow_sha: gateContract.workflow_sha,
    workflow_digest: gateContract.workflow_digest,
    node_version: gateContract.node_version,
    package_manager: gateContract.package_manager,
    gate_mode: gateContract.gate_mode,
    shard_count: gateContract.shard_count,
    summary_artifact_name: 'release-bus-base-canary-summary-123',
    summary_artifact_digest: artifactDigest,
    phase_durations_ms: { total: 100 },
    totals: {
      files: 4,
      test_suites: 4,
      tests: 4,
      failed_test_suites: 0,
      failed_tests: 0,
      skipped_tests: 0,
      skipped_test_suites: 0
    },
    fresh_or_reused: 'fresh',
    shards: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      count: 4,
      coordinate: `${index + 1}/4`,
      status: 'SUCCEEDED',
      duration_ms: 25,
      failed_test_suites: 0,
      failed_tests: 0
    })),
    missing_files: [],
    duplicate_files: [],
    unexpected_files: []
  };
  const successfulIdentityOperation = {
    id: 'operation-base-evidence-identity',
    operation_key: 'train-1:r1:base-evidence-identity-frontend',
    train_id: frozenTrain.id,
    revision: frozenTrain.revision,
    operation_type: 'base-evidence-identity-frontend',
    repository: 'frontend',
    environment: 'orchestration',
    service: null,
    expected_sha: frozenTrain.frontend_base_sha,
    artifact_digest: null,
    attempt: 1,
    status: 'SUCCEEDED',
    external_id: 'identity-run-123',
    request_metadata_json: {
      workflow: 'release-bus-base-evidence-identity.yml'
    },
    result_metadata_json: {
      gate_report: {
        phase: 'complete',
        status: 'SUCCEEDED',
        build_profile_digest: gateContract.build_profile_digest
      }
    },
    started_at: 1,
    completed_at: 2,
    created_at: 1,
    updated_at: 2,
    row_version: 2
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_MODE = 'STAGING';
    mockFindTrain.mockResolvedValue(frozenTrain);
    mockListTrainItems.mockResolvedValue([
      { candidate_id: frontendCandidate.id, sequence: 1 }
    ]);
    mockFindCandidateById.mockResolvedValue(frontendCandidate);
    mockHeartbeatLane.mockResolvedValue(true);
    mockListControls.mockResolvedValue([]);
    mockEnsureCommitStatus.mockResolvedValue(undefined);
    mockReleaseLane.mockResolvedValue(undefined);
    mockSetControl.mockResolvedValue(undefined);
    mockUpdateTrain.mockResolvedValue(undefined);
    mockAdvanceTrainPhase.mockResolvedValue(true);
    mockUpdateOperationIfVersion.mockResolvedValue(true);
    mockUpdateCandidateLifecycle.mockResolvedValue(undefined);
    mockAppendEvent.mockResolvedValue(undefined);
    mockListTrainEvents.mockResolvedValue([]);
    mockExecuteTransaction.mockImplementation(async (callback) =>
      callback({ transaction: 'test' })
    );
    mockAddEvidence.mockResolvedValue(true);
    mockHasTrainEvidence.mockResolvedValue(false);
    mockResolveRef.mockResolvedValue(workflowSha);
    mockUpdateRef.mockResolvedValue(undefined);
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository !== 'frontend') return null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockGetFileContent.mockImplementation(
      async (_repository: string, file: string) =>
        baseFileContents[file] ?? workflowFileContent(file)
    );
  });

  afterEach(() => {
    delete process.env.RELEASE_BUS_MODE;
    delete process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE;
    delete process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW;
    delete process.env.RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS;
  });

  it('dispatches the immutable base canary before composition', async () => {
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation
      .mockImplementationOnce(async (operation) => operation)
      .mockImplementationOnce(async (operation) => ({
        ...operation,
        status: 'DISPATCHED'
      }));
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING',
      wait_reason: {
        code: 'GITHUB_WORKFLOW_RUNNING',
        summary: expect.stringContaining('Candidates have not been tested yet')
      }
    });

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({
        base_sha: frozenTrain.frontend_base_sha,
        expected_sha: frozenTrain.frontend_base_sha
      })
    );
    expect(mockAdvanceTrainPhase).toHaveBeenCalledWith(
      frozenTrain.id,
      'FROZEN',
      frozenTrain.row_version,
      'BASE_CANARY_RUNNING',
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAIN_PHASE_CHANGED' }),
      { connection: { transaction: 'test' } }
    );
  });

  it('does not advance or append an event after the train phase diverges', async () => {
    const advancedTrain = {
      ...frozenTrain,
      status: 'BASE_CANARY_RUNNING' as const,
      row_version: 2
    };
    mockFindTrain
      .mockResolvedValueOnce(frozenTrain)
      .mockResolvedValueOnce(advancedTrain)
      .mockResolvedValueOnce(advancedTrain);
    const completedCanary = {
      id: 'operation-base-canary',
      operation_key: 'train-1:r1:base-canary-frontend',
      train_id: frozenTrain.id,
      revision: frozenTrain.revision,
      operation_type: 'base-canary-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: frozenTrain.frontend_base_sha,
      artifact_digest: null,
      attempt: 1,
      status: 'SUCCEEDED',
      external_id: '12345',
      request_metadata_json: {
        workflow: 'release-bus-base-canary.yml'
      },
      result_metadata_json: {},
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockListTrainOperations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([completedCanary]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });
    mockAdvanceTrainPhase.mockResolvedValue(false);

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      train_id: frozenTrain.id,
      status: 'BASE_CANARY_RUNNING',
      wait_reason: {
        code: 'PHASE_TRANSITION',
        summary: expect.stringContaining('next guarded worker tick')
      },
      current_operation: null
    });

    expect(mockAdvanceTrainPhase).toHaveBeenCalledWith(
      frozenTrain.id,
      'FROZEN',
      frozenTrain.row_version,
      'BASE_CANARY_RUNNING',
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAIN_PHASE_CHANGED' }),
      expect.anything()
    );

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      train_id: frozenTrain.id,
      status: 'COMPOSING'
    });
    expect(mockUpdateTrain).toHaveBeenCalledWith(
      frozenTrain.id,
      expect.objectContaining({ status: 'COMPOSING' }),
      {}
    );
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it('requeues candidates and pauses with evidence when the base fails', async () => {
    mockListTrainOperations.mockResolvedValue([
      {
        operation_type: 'base-canary-frontend',
        repository: 'frontend',
        status: 'FAILED',
        result_metadata_json: {
          url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
        }
      }
    ]);

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'FAILED',
      status: 'FAILED'
    });

    expect(mockUpdateCandidateLifecycle).toHaveBeenCalledWith(
      frontendCandidate.id,
      frontendCandidate.row_version,
      expect.objectContaining({
        status: 'READY_FOR_STAGING',
        currentTrainId: null,
        holdReason: 'BASE_FAILURE_NO_CANDIDATE_BLAMED'
      }),
      {}
    );
    expect(mockSetControl).toHaveBeenCalledWith(
      'STAGING',
      true,
      expect.stringContaining('/actions/runs/12345'),
      'release-bus-worker',
      {}
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TRAIN_FAILED_AND_LANE_PAUSED',
        payload: expect.objectContaining({
          attribution: 'PRE_EXISTING_BASE',
          returned_candidates: [frontendCandidate.id],
          quarantined_candidates: []
        })
      }),
      {}
    );
  });

  it('retries a classified infrastructure failure without pausing the lane', async () => {
    const failedOperation = {
      id: 'operation-base-canary-attempt-1',
      operation_key: 'train-1:r1:base-canary-frontend:attempt-1',
      train_id: frozenTrain.id,
      revision: frozenTrain.revision,
      operation_type: 'base-canary-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: frozenTrain.frontend_base_sha,
      artifact_digest: null,
      attempt: 1,
      status: 'FAILED',
      external_id: '12345',
      request_metadata_json: {
        workflow: 'release-bus-base-canary.yml',
        ref: 'main',
        inputs: {
          base_sha: frozenTrain.frontend_base_sha,
          gate_contract: JSON.stringify(gateContract)
        },
        gate_contract: gateContract
      },
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
        gate_report: {
          phase: 'complete',
          status: 'FAILED',
          failure_class: 'INFRASTRUCTURE_TRANSIENT',
          failure_phase: 'dependency_install',
          retryable: true,
          summary: reusableSummary
        }
      },
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockListTrainOperations.mockResolvedValue([failedOperation]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({
      ...failedOperation,
      attempt: 2,
      status: 'DISPATCHED'
    });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING',
      wait_reason: {
        code: 'INFRASTRUCTURE_RETRY_BACKOFF',
        summary: expect.stringContaining('retry automatically')
      }
    });

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({
        base_sha: frozenTrain.frontend_base_sha,
        expected_sha: frozenTrain.frontend_base_sha,
        operation_key: expect.stringMatching(/:a2$/)
      })
    );
    expect(mockSetControl).not.toHaveBeenCalled();
    expect(mockUpdateCandidateLifecycle).not.toHaveBeenCalled();
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DISPATCHED',
        payload: expect.objectContaining({
          next_attempt: 2,
          lane_paused: false
        })
      }),
      {}
    );
  });

  it('ends the train without pausing after bounded infrastructure retries are exhausted', async () => {
    const failedOperation = {
      id: 'operation-base-canary-attempt-5',
      operation_key: 'train-1:r1:base-canary-frontend:attempt-5',
      train_id: frozenTrain.id,
      revision: frozenTrain.revision,
      operation_type: 'base-canary-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: frozenTrain.frontend_base_sha,
      artifact_digest: null,
      attempt: 5,
      status: 'FAILED',
      external_id: '52345',
      request_metadata_json: {
        workflow: 'release-bus-base-canary.yml',
        ref: 'main',
        inputs: { base_sha: frozenTrain.frontend_base_sha }
      },
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/52345',
        gate_report: {
          phase: 'complete',
          status: 'FAILED',
          failure_class: 'INFRASTRUCTURE_TRANSIENT',
          failure_phase: 'dependency_install',
          retryable: true
        }
      },
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockListTrainOperations.mockResolvedValue([failedOperation]);

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'FAILED',
      status: 'FAILED'
    });

    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
    expect(mockSetControl).not.toHaveBeenCalled();
    expect(mockUpdateCandidateLifecycle).toHaveBeenCalledWith(
      frontendCandidate.id,
      frontendCandidate.row_version,
      expect.objectContaining({
        status: 'READY_FOR_STAGING',
        currentTrainId: null,
        holdReason: 'INFRASTRUCTURE_RETRY_EXHAUSTED:base-canary-frontend'
      }),
      {}
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'TRAIN_INFRASTRUCTURE_RETRIES_EXHAUSTED',
        payload: expect.objectContaining({
          attempt: 5,
          max_attempts: 5,
          lane_paused: false,
          returned_candidates: [frontendCandidate.id]
        })
      }),
      {}
    );
  });

  it('retries classified preflight infrastructure without entering isolation', async () => {
    const preflightTrain = {
      ...frozenTrain,
      status: 'PREFLIGHTING' as const,
      frontend_release_branch: 'release-bus/train-1'
    };
    const failedOperation = {
      id: 'operation-preflight-attempt-1',
      operation_key: 'train-1:r1:preflight-frontend:attempt-1',
      train_id: preflightTrain.id,
      revision: preflightTrain.revision,
      operation_type: 'preflight-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA_B,
      artifact_digest: null,
      attempt: 1,
      status: 'FAILED',
      external_id: '22345',
      request_metadata_json: {
        workflow: 'release-bus-preflight.yml',
        ref: 'main',
        inputs: {
          target_lane: 'STAGING',
          release_branch: 'release-bus/train-1'
        }
      },
      result_metadata_json: {
        gate_report: {
          phase: 'complete',
          status: 'FAILED',
          failure_class: 'INFRASTRUCTURE_TRANSIENT',
          failure_phase: 'dependency_install',
          retryable: true
        }
      },
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockFindTrain.mockResolvedValue(preflightTrain);
    mockListTrainOperations.mockResolvedValue([failedOperation]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({
      ...failedOperation,
      attempt: 2,
      status: 'DISPATCHED'
    });

    await expect(advanceReleaseTrain(preflightTrain.id)).resolves.toMatchObject(
      {
        decision: 'WAIT',
        status: 'PREFLIGHTING',
        wait_reason: {
          code: 'INFRASTRUCTURE_RETRY_BACKOFF',
          summary: expect.stringContaining('preflight')
        }
      }
    );

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-preflight.yml',
      'main',
      expect.objectContaining({
        operation_key: expect.stringMatching(/:a2$/),
        expected_sha: SHA_B,
        target_lane: 'STAGING'
      })
    );
    expect(mockUpdateTrain).not.toHaveBeenCalledWith(
      preflightTrain.id,
      expect.objectContaining({ status: 'ISOLATING_FAILURE' }),
      {}
    );
    expect(mockSetControl).not.toHaveBeenCalled();
  });

  it('retries a GitHub App composition publish failure without blaming candidates', async () => {
    const composingTrain = {
      ...frozenTrain,
      status: 'COMPOSING' as const,
      frontend_release_branch: `release-bus/staging-train-${frozenTrain.id}-r1`
    };
    const failedOperation = {
      id: 'operation-compose-attempt-1',
      operation_key: 'train-1:r1:compose-frontend:a1',
      train_id: composingTrain.id,
      revision: composingTrain.revision,
      operation_type: 'compose-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: composingTrain.frontend_base_sha,
      artifact_digest: null,
      attempt: 1,
      status: 'FAILED',
      external_id: '29926766725',
      request_metadata_json: {
        workflow: 'release-bus-compose.yml',
        ref: 'main',
        inputs: {
          target_lane: 'STAGING',
          base_sha: composingTrain.frontend_base_sha,
          candidate_shas: JSON.stringify([frontendCandidate.head_sha]),
          release_branch: composingTrain.frontend_release_branch
        }
      },
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/29926766725',
        workflow_conclusion: 'failure',
        failed_job: 'publish',
        failed_step: 'Publish release branch'
      },
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockFindTrain.mockResolvedValue(composingTrain);
    mockListTrainOperations.mockResolvedValue([failedOperation]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({
      ...failedOperation,
      operation_key: 'train-1:r1:compose-frontend:a2',
      attempt: 2,
      status: 'DISPATCHED'
    });

    await expect(advanceReleaseTrain(composingTrain.id)).resolves.toMatchObject(
      {
        decision: 'WAIT',
        status: 'COMPOSING',
        wait_reason: {
          code: 'INFRASTRUCTURE_RETRY_BACKOFF',
          summary: expect.stringContaining('retry automatically')
        }
      }
    );

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-compose.yml',
      'main',
      expect.objectContaining({
        composition_artifact_run_id: failedOperation.external_id,
        operation_key: expect.stringMatching(/:a2$/),
        expected_sha: composingTrain.frontend_base_sha
      })
    );
    expect(mockUpdateTrain).not.toHaveBeenCalledWith(
      composingTrain.id,
      expect.objectContaining({ status: 'ISOLATING_FAILURE' }),
      {}
    );
    expect(mockUpdateCandidateLifecycle).not.toHaveBeenCalled();
    expect(mockSetControl).not.toHaveBeenCalled();
  });

  it('keeps the phase retryable when infrastructure retry bookkeeping fails', async () => {
    const preflightTrain = {
      ...frozenTrain,
      status: 'PREFLIGHTING' as const,
      frontend_release_branch: 'release-bus/train-1'
    };
    const failedOperation = {
      id: 'operation-preflight-attempt-1',
      operation_key: 'train-1:r1:preflight-frontend:attempt-1',
      train_id: preflightTrain.id,
      revision: preflightTrain.revision,
      operation_type: 'preflight-frontend',
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA_B,
      artifact_digest: null,
      attempt: 1,
      status: 'FAILED',
      external_id: '32345',
      request_metadata_json: {
        workflow: 'release-bus-preflight.yml',
        ref: 'main',
        inputs: {
          target_lane: 'STAGING',
          release_branch: 'release-bus/train-1'
        }
      },
      result_metadata_json: {
        gate_report: {
          phase: 'complete',
          status: 'FAILED',
          failure_class: 'INFRASTRUCTURE_TRANSIENT',
          failure_phase: 'dependency_install',
          retryable: true
        }
      },
      started_at: 1,
      completed_at: 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    } as const;
    mockFindTrain.mockResolvedValue(preflightTrain);
    mockListTrainOperations.mockResolvedValue([failedOperation]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({
      ...failedOperation,
      attempt: 2,
      status: 'DISPATCHED'
    });
    mockAppendEvent
      .mockRejectedValueOnce(new Error('temporary database write failure'))
      .mockResolvedValue(undefined);

    await expect(advanceReleaseTrain(preflightTrain.id)).resolves.toMatchObject(
      {
        decision: 'WAIT',
        status: 'PREFLIGHTING',
        wait_reason: { code: 'INFRASTRUCTURE_RETRY_BACKOFF' }
      }
    );

    expect(mockSetControl).not.toHaveBeenCalled();
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DEFERRED'
      }),
      {}
    );
  });

  it('records fresh terminal evidence and provenance in one transaction', async () => {
    const freshSummary = {
      ...reusableSummary,
      shards: [{ ...reusableSummary.shards[0], coordinate: { unsafe: true } }]
    };
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository === 'backend')
          return name === 'RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS'
            ? '12'
            : null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockListTrainOperations.mockResolvedValue([
      {
        id: 'operation-base-canary',
        operation_key: 'train-1:r1:base-canary-frontend',
        train_id: frozenTrain.id,
        revision: frozenTrain.revision,
        operation_type: 'base-canary-frontend',
        repository: 'frontend',
        environment: 'orchestration',
        service: null,
        expected_sha: frozenTrain.frontend_base_sha,
        artifact_digest: null,
        attempt: 1,
        status: 'SUCCEEDED',
        external_id: '123',
        request_metadata_json: { gate_contract: gateContract },
        result_metadata_json: {
          url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
          gate_report: { summary: freshSummary, reported_at: 1_500 }
        },
        started_at: 1_000,
        completed_at: 2_000,
        created_at: 1_000,
        updated_at: 2_000,
        row_version: 2
      }
    ]);

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT'
    });

    expect(mockAddEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: 'BASE_CANARY_COMPLETED',
        status: 'SUCCEEDED',
        sourceSha: frozenTrain.frontend_base_sha,
        artifactDigest,
        evidenceUri:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
        metadata: expect.objectContaining({
          contract: gateContract,
          summary: freshSummary,
          source_run_id: '123',
          created_at: 1_500,
          expires_at: 1_500 + 12 * 60 * 60 * 1_000
        })
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BASE_CANARY_EVIDENCE_RECORDED',
        payload: expect.objectContaining({ fresh_or_reused: 'fresh' })
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockPublishReleaseBusMetrics).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          MetricName: 'BaseCanaryShardDurationSeconds',
          Dimensions: expect.arrayContaining([
            { Name: 'Shard', Value: 'unknown' }
          ])
        })
      ])
    );
  });

  it('advances from reusable exact-SHA evidence in one worker cycle', async () => {
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository === 'backend')
          return name === 'RELEASE_BUS_BASE_EVIDENCE_REUSE' ? 'true' : null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockListTrainOperations.mockResolvedValue([successfulIdentityOperation]);
    mockListBaseCanaryEvidenceBySha.mockResolvedValue([
      {
        id: 'source-evidence',
        train_id: 'source-train',
        revision: 3,
        status: 'SUCCEEDED',
        evidence_type: 'BASE_CANARY_COMPLETED',
        source_sha: gateContract.base_sha,
        artifact_digest: artifactDigest,
        evidence_uri:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
        metadata_json: {
          source_kind: 'fresh_base_canary',
          anchored_full_proof: true,
          contract: gateContract,
          summary: reusableSummary,
          gate_stages: [
            { name: 'lint', status: 'SUCCEEDED' },
            { name: 'typecheck', status: 'SUCCEEDED' },
            { name: 'unit_tests', status: 'SUCCEEDED' },
            { name: 'build', status: 'SUCCEEDED' }
          ],
          source_run_id: '123',
          created_at: Date.now() - 1_000,
          expires_at: Date.now() + 60_000
        },
        created_at: Date.now() - 1_000
      }
    ]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'COMPOSING'
    });

    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-compose.yml',
      'main',
      expect.any(Object)
    );
    expect(mockAddEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: 'BASE_CANARY_EVIDENCE_REUSED',
        sourceSha: frozenTrain.frontend_base_sha,
        metadata: expect.objectContaining({
          source_evidence_id: 'source-evidence',
          source_train_id: 'source-train',
          source_run_id: '123'
        })
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BASE_CANARY_EVIDENCE_REUSED',
        payload: expect.objectContaining({ status: 'reused' })
      }),
      { connection: { transaction: 'test' } }
    );
  });

  it('disables evidence reuse from a runtime variable without redeployment', async () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository === 'backend')
          return name === 'RELEASE_BUS_BASE_EVIDENCE_REUSE' ? 'false' : null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockListBaseCanaryEvidenceBySha).not.toHaveBeenCalled();
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({ base_sha: frozenTrain.frontend_base_sha })
    );
    expect(mockDispatchWorkflow.mock.calls[0]?.[3]).not.toHaveProperty(
      'gate_contract'
    );
  });

  it('fails closed to fresh validation when runtime controls are unreadable', async () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    mockGetActionsVariable.mockRejectedValue(new Error('GitHub unavailable'));
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockListBaseCanaryEvidenceBySha).not.toHaveBeenCalled();
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({ base_sha: frozenTrain.frontend_base_sha })
    );
  });

  it('keeps the exact contract while falling back fresh after an evidence lookup error', async () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    mockListBaseCanaryEvidenceBySha.mockRejectedValue(
      new Error('temporary evidence store error')
    );
    mockListTrainOperations.mockResolvedValue([successfulIdentityOperation]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({
        base_sha: frozenTrain.frontend_base_sha,
        expected_sha: frozenTrain.frontend_base_sha
      })
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BASE_CANARY_EVIDENCE_LOOKUP_INVALIDATED',
        payload: expect.objectContaining({ reason: 'lookup_error' })
      }),
      {}
    );
  });

  it('dispatches a fresh canary without resolving a reuse contract in default mode', async () => {
    mockResolveRef.mockRejectedValue(new Error('GitHub unavailable'));
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(mockGetFileContent).not.toHaveBeenCalled();
    const workflowInputs = mockDispatchWorkflow.mock.calls[0]?.[3];
    expect(workflowInputs).toEqual(
      expect.objectContaining({ base_sha: frozenTrain.frontend_base_sha })
    );
    expect(workflowInputs).not.toHaveProperty('gate_contract');
    expect(mockAppendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BASE_CANARY_EVIDENCE_LOOKUP_INVALIDATED'
      }),
      expect.anything()
    );
  });

  it('honors an operator force-fresh choice', async () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    mockFindCandidateById.mockResolvedValue({
      ...frontendCandidate,
      force_fresh_base_canary: true
    });
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockListBaseCanaryEvidenceBySha).not.toHaveBeenCalled();
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({
        base_sha: frozenTrain.frontend_base_sha,
        expected_sha: frozenTrain.frontend_base_sha
      })
    );
    expect(mockDispatchWorkflow.mock.calls[0]?.[3]).not.toHaveProperty(
      'gate_contract'
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BASE_CANARY_EVIDENCE_FORCE_FRESH'
      }),
      {}
    );
  });
  it('records a would-reuse decision but dispatches fresh in shadow mode', async () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW = 'true';
    mockListTrainOperations.mockResolvedValue([successfulIdentityOperation]);
    mockListBaseCanaryEvidenceBySha.mockResolvedValue([
      {
        id: 'shadow-source-evidence',
        train_id: 'shadow-source-train',
        revision: 2,
        status: 'SUCCEEDED',
        evidence_type: 'BASE_CANARY_COMPLETED',
        source_sha: gateContract.base_sha,
        artifact_digest: artifactDigest,
        evidence_uri:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
        metadata_json: {
          source_kind: 'fresh_base_canary',
          anchored_full_proof: true,
          contract: gateContract,
          summary: reusableSummary,
          gate_stages: [
            { name: 'lint', status: 'SUCCEEDED' },
            { name: 'typecheck', status: 'SUCCEEDED' },
            { name: 'unit_tests', status: 'SUCCEEDED' },
            { name: 'build', status: 'SUCCEEDED' }
          ],
          source_run_id: '123',
          created_at: Date.now() - 1_000,
          expires_at: Date.now() + 60_000
        },
        created_at: Date.now() - 1_000
      }
    ]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });

    await expect(advanceReleaseTrain(frozenTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'BASE_CANARY_RUNNING'
    });

    expect(mockAddEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceType: 'BASE_CANARY_EVIDENCE_WOULD_REUSE'
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-base-canary.yml',
      'main',
      expect.objectContaining({ gate_contract: JSON.stringify(gateContract) })
    );
  });

  it('promotes a completed staging train exactly once across worker retries', async () => {
    const finalContract = buildFrontendGateContract({
      baseSha: frontendCandidate.head_sha,
      workflowSha,
      workflowFileContents: Object.fromEntries(
        [
          FRONTEND_GATE_WORKFLOW,
          FRONTEND_PREFLIGHT_WORKFLOW,
          FRONTEND_BASE_IDENTITY_WORKFLOW,
          FRONTEND_STAGING_DEPLOY_WORKFLOW,
          FRONTEND_STAGING_E2E_WORKFLOW,
          ...FRONTEND_GATE_TOOLING_FILES
        ].map((file) => [file, workflowFileContent(file)])
      ),
      baseFileContents,
      gateMode: 'sharded',
      shardCount: 4,
      buildProfileDigest: 'e'.repeat(64)
    });
    const finalSummary = {
      ...reusableSummary,
      kind: 'frontend_preflight_base_evidence_summary',
      base_sha: finalContract.base_sha,
      gate_fingerprint: finalContract.gate_fingerprint,
      behavior_digest: finalContract.behavior_digest,
      build_profile_digest: finalContract.build_profile_digest,
      proof_origin: 'fresh_preflight',
      build_environments: ['staging'],
      build_coverage: {
        authoritative_profile: 'SUCCEEDED',
        compilation_count: 1,
        deployed_artifact_bound: true
      },
      immutable_artifact: {
        artifact_name: `release-bus-frontend-${frozenTrain.id}-r${frozenTrain.revision}-staging`,
        run_id: '101',
        source_sha: finalContract.base_sha,
        environment: 'staging',
        package_digest: '8'.repeat(64),
        upload_digest: '7'.repeat(64),
        build_profile_digest: finalContract.build_profile_digest
      }
    };
    const operation = (
      type: string,
      environment: 'orchestration' | 'staging',
      runId: string,
      digest: string | null,
      extra: Record<string, unknown> = {}
    ) => ({
      id: `operation-${type}`,
      operation_key: `operation:${type}`,
      train_id: frozenTrain.id,
      revision: frozenTrain.revision,
      operation_type: type,
      repository: 'frontend',
      environment,
      service: null,
      expected_sha: finalContract.base_sha,
      artifact_digest: digest,
      attempt: 1,
      status: 'SUCCEEDED',
      external_id: runId,
      request_metadata_json: {},
      result_metadata_json: {
        url: `https://github.com/6529-Collections/6529seize-frontend/actions/runs/${runId}`
      },
      started_at: 1_000,
      completed_at: 2_000,
      created_at: 1_000,
      updated_at: 2_000,
      row_version: 2,
      ...extra
    });
    mockListTrainOperations.mockResolvedValue([
      operation('preflight-frontend', 'orchestration', '101', artifactDigest, {
        request_metadata_json: { gate_contract: finalContract },
        result_metadata_json: {
          url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/101',
          gate_report: {
            summary: finalSummary,
            stages: [
              { name: 'lint', status: 'SUCCEEDED' },
              { name: 'typecheck', status: 'SUCCEEDED' },
              { name: 'unit_tests', status: 'SUCCEEDED' },
              { name: 'build', status: 'SUCCEEDED' }
            ]
          }
        }
      }),
      operation('deploy-frontend-staging', 'staging', '102', '8'.repeat(64)),
      operation('e2e-staging', 'staging', '103', null)
    ]);
    mockResolveRef.mockImplementation(
      async (_repository: string, ref: string) =>
        ref === '1a-staging' ? finalContract.base_sha : workflowSha
    );
    mockAddEvidence.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await promoteSuccessfulStagingBaseEvidence(frozenTrain, [
      frontendCandidate
    ]);
    await promoteSuccessfulStagingBaseEvidence(frozenTrain, [
      frontendCandidate
    ]);

    expect(mockAddEvidence).toHaveBeenCalledTimes(2);
    expect(mockAddEvidence).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(':promoted'),
        evidenceType: 'BASE_EVIDENCE_PROMOTED',
        status: 'SUCCEEDED',
        sourceSha: finalContract.base_sha,
        artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        metadata: expect.objectContaining({
          source_kind: 'staging_train_full_gate_preflight_deploy_e2e',
          anchored_full_proof: true
        })
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'BASE_EVIDENCE_PROMOTED' }),
      { connection: { transaction: 'test' } }
    );
  });

  it('rejects an unowned manual move of staging to the train final SHA', async () => {
    mockResolveRef.mockResolvedValue(frontendCandidate.head_sha);
    mockHasTrainEvidence.mockResolvedValue(false);

    await expect(
      finishStaging(frozenTrain, [frontendCandidate])
    ).rejects.toThrow(
      'UNOWNED_STAGING_REF_UPDATE: 1a-staging moved to train final SHA'
    );

    expect(mockUpdateTrain).not.toHaveBeenCalled();
  });

  it('records durable ref-update intent before advancing staging', async () => {
    mockResolveRef
      .mockResolvedValueOnce(frontendCandidate.head_sha)
      .mockResolvedValueOnce(frozenTrain.frontend_base_sha)
      .mockResolvedValue(frontendCandidate.head_sha);
    mockListTrainOperations.mockResolvedValue([]);
    mockGetLane.mockResolvedValue(null);

    await finishStaging(frozenTrain, [frontendCandidate]);

    expect(mockAddEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringContaining('staging-ref-update-intent:'),
        evidenceType: 'STAGING_REF_UPDATE_INTENT_FRONTEND',
        sourceSha: frontendCandidate.head_sha,
        metadata: {
          repository: 'frontend',
          expected_old_sha: frozenTrain.frontend_base_sha,
          intended_final_sha: frontendCandidate.head_sha
        }
      }),
      {}
    );
    expect(mockUpdateRef).toHaveBeenCalledWith(
      'frontend',
      '1a-staging',
      frozenTrain.frontend_base_sha,
      frontendCandidate.head_sha
    );
    expect(mockAddEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateRef.mock.invocationCallOrder[0]
    );
  });

  it('continues idempotently after its recorded staging ref update survives a worker restart', async () => {
    mockResolveRef.mockResolvedValue(frontendCandidate.head_sha);
    mockHasTrainEvidence.mockResolvedValue(true);
    mockListTrainOperations.mockResolvedValue([]);
    mockGetLane.mockResolvedValue(null);

    await expect(
      finishStaging(frozenTrain, [frontendCandidate])
    ).resolves.toBeUndefined();

    expect(mockHasTrainEvidence).toHaveBeenCalledWith(
      frozenTrain.id,
      frozenTrain.revision,
      'STAGING_REF_UPDATE_INTENT_FRONTEND',
      frontendCandidate.head_sha,
      {}
    );
    expect(mockUpdateTrain).toHaveBeenCalledWith(
      frozenTrain.id,
      expect.objectContaining({ status: 'COMPLETED' }),
      {}
    );
  });
});

describe('staging E2E infrastructure recovery', () => {
  const e2eCandidate = candidate('candidate-e2e', 'backend', SHA_A, 1776);
  const e2eTrain: ReleaseTrainRecord = {
    id: 'train-1',
    revision: 1,
    target_lane: 'STAGING',
    status: 'E2E_RUNNING',
    cutoff_at: 1,
    frontend_base_sha: 'd'.repeat(40),
    backend_base_sha: 'e'.repeat(40),
    frontend_release_branch: null,
    backend_release_branch: 'release-bus/staging-train-train-1-r1',
    frontend_pr_number: null,
    backend_pr_number: null,
    state_machine_execution_arn: null,
    worker_version: '11',
    failure_reason: null,
    started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
  const failedOperation = {
    id: 'operation-e2e-attempt-1',
    operation_key: 'train-1:r1:e2e-staging:a1',
    train_id: e2eTrain.id,
    revision: e2eTrain.revision,
    operation_type: 'e2e-staging',
    repository: 'frontend',
    environment: 'staging',
    service: null,
    expected_sha: SHA_B,
    artifact_digest: null,
    attempt: 1,
    status: 'FAILED',
    external_id: '29920703076',
    request_metadata_json: {
      workflow: 'staging-e2e.yml',
      ref: 'main',
      inputs: { pack: 'all', source_ref: '1a-staging' }
    },
    result_metadata_json: {
      url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/29920703076',
      workflow_conclusion: 'failure',
      failed_job: 'Staging E2E packs',
      failed_step: 'Install Playwright browser'
    },
    started_at: 1,
    completed_at: 2,
    created_at: 1,
    updated_at: 2,
    row_version: 2
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_MODE = 'STAGING';
    mockFindTrain.mockResolvedValue(e2eTrain);
    mockListTrainItems.mockResolvedValue([
      { candidate_id: e2eCandidate.id, sequence: 1 }
    ]);
    mockFindCandidateById.mockResolvedValue(e2eCandidate);
    mockHeartbeatLane.mockResolvedValue(true);
    mockListControls.mockResolvedValue([]);
    mockListTrainOperations.mockResolvedValue([failedOperation]);
    mockListTrainEvents.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({
      ...failedOperation,
      operation_key: 'train-1:r1:e2e-staging:a2',
      attempt: 2,
      status: 'DISPATCHED'
    });
    mockAppendEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.RELEASE_BUS_MODE;
  });

  it('retries a legacy E2E setup failure without redeploying or pausing', async () => {
    await expect(advanceReleaseTrain(e2eTrain.id)).resolves.toMatchObject({
      decision: 'WAIT',
      status: 'E2E_RUNNING',
      wait_reason: {
        code: 'INFRASTRUCTURE_RETRY_BACKOFF',
        summary: expect.stringContaining('retry automatically')
      }
    });

    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'staging-e2e.yml',
      'main',
      expect.objectContaining({
        pack: 'all',
        source_ref: '1a-staging',
        operation_key: expect.stringMatching(/:a2$/)
      })
    );
    expect(mockSetControl).not.toHaveBeenCalled();
    expect(mockUpdateCandidateLifecycle).not.toHaveBeenCalled();
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DISPATCHED',
        payload: expect.objectContaining({
          failed_attempt: 1,
          next_attempt: 2,
          lane_paused: false
        })
      }),
      {}
    );
  });
});

function candidate(
  id: string,
  repository: 'backend' | 'frontend',
  sha: string,
  prNumber: number
): ReleaseCandidateRecord {
  return {
    id,
    repository,
    branch_name: `feature/${id}`,
    head_sha: sha,
    pr_number: prNumber,
    status: 'STAGING_CLAIMED',
    staging_ready_by_github_login: 'developer',
    staging_ready_at: 1,
    production_ready_by_github_login: null,
    production_ready_at: null,
    deploy_plan_json: null,
    force_fresh_base_canary: false,
    metadata_version: 1,
    current_train_id: 'train-1',
    hold_reason: null,
    invalidated_at: null,
    released_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

const train: ReleaseTrainRecord = {
  id: 'train-1',
  revision: 1,
  target_lane: 'STAGING',
  status: 'COMPOSING',
  cutoff_at: 1,
  frontend_base_sha: 'd'.repeat(40),
  backend_base_sha: 'e'.repeat(40),
  frontend_release_branch: 'release-bus/staging-train-train-1-r1',
  backend_release_branch: 'release-bus/staging-train-train-1-r1',
  frontend_pr_number: null,
  backend_pr_number: null,
  state_machine_execution_arn: null,
  worker_version: '1',
  failure_reason: null,
  started_at: 1,
  completed_at: null,
  created_at: 1,
  updated_at: 1,
  row_version: 1
};

describe('backend deployment DAG frontiers', () => {
  const units = [
    'aggregatedActivityLoop',
    'attachmentsOrchestrator',
    'attachmentsProcessor'
  ] as const;
  const backendCandidate = (
    selected: readonly string[],
    edges: ReadonlyArray<readonly [string, string]> = []
  ): ReleaseCandidateRecord => ({
    ...candidate('candidate-backend-deploy', 'backend', SHA_A, 1776),
    deploy_plan_json: { units: [...selected], edges: [...edges] }
  });
  const preflightOperation = {
    id: 'operation-preflight-backend',
    operation_key: 'train-1:r1:preflight-backend',
    train_id: train.id,
    revision: train.revision,
    operation_type: 'preflight-backend',
    repository: 'backend',
    environment: 'orchestration',
    service: null,
    expected_sha: SHA_C,
    artifact_digest: '8'.repeat(64),
    attempt: 1,
    status: 'SUCCEEDED',
    external_id: '29919223502',
    request_metadata_json: { workflow: 'release-bus-preflight.yml' },
    result_metadata_json: {},
    started_at: 1,
    completed_at: 2,
    created_at: 1,
    updated_at: 2,
    row_version: 2
  } as const;
  const deploymentOperation = (
    service: string,
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED',
    resultMetadata: Record<string, unknown> = {}
  ) =>
    ({
      id: `operation-${service}`,
      operation_key: `train-1:r1:deploy-backend-staging-${service}:backend:staging:${service}`,
      train_id: train.id,
      revision: train.revision,
      operation_type: `deploy-backend-staging-${service}`,
      repository: 'backend',
      environment: 'staging',
      service,
      expected_sha: SHA_C,
      artifact_digest: '7'.repeat(64),
      attempt: 1,
      status,
      external_id: `run-${service}`,
      request_metadata_json: {
        workflow: 'deploy.yml',
        ref: 'main',
        inputs: {
          environment: 'staging',
          service,
          artifact_run_id: preflightOperation.external_id
        }
      },
      result_metadata_json: resultMetadata,
      started_at: 1,
      completed_at: status === 'RUNNING' ? null : 2,
      created_at: 1,
      updated_at: 2,
      row_version: 2
    }) as const;

  let deployOperations: Array<ReturnType<typeof deploymentOperation>>;
  let createdOperations: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RELEASE_BUS_BACKEND_DEPLOY_CONCURRENCY;
    deployOperations = [];
    createdOperations = new Map();
    mockListTrainOperations.mockImplementation(async () => [
      preflightOperation,
      ...deployOperations
    ]);
    mockResolveRef.mockResolvedValue(SHA_C);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockAppendEvent.mockResolvedValue(undefined);
    mockGetOrCreateOperation.mockImplementation(async (operation) => {
      const row = {
        id: `created-${String(operation.operation_key)}`,
        ...operation,
        created_at: 1,
        updated_at: 1,
        row_version: 1
      };
      createdOperations.set(String(operation.operation_key), row);
      return row;
    });
    mockUpdateOperation.mockImplementation(async (operationKey, update) => {
      const current = createdOperations.get(operationKey) ?? {};
      createdOperations.set(operationKey, {
        ...current,
        status: update.status ?? current.status,
        external_id: update.externalId ?? current.external_id,
        result_metadata_json:
          update.resultMetadata ?? current.result_metadata_json
      });
    });
    mockFindOperation.mockImplementation(async (operationKey) =>
      createdOperations.get(operationKey)
    );
    mockExecuteTransaction.mockImplementation(async (callback) =>
      callback({ transaction: 'test' })
    );
    mockUpdateOperationIfVersion.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.RELEASE_BUS_BACKEND_DEPLOY_CONCURRENCY;
  });

  it('unions registry and candidate edges into deterministic frontiers', () => {
    const graph = backendDeployGraph([
      backendCandidate(
        ['api', 'dbMigrationsLoop', 'attachmentsProcessor'],
        [['attachmentsProcessor', 'api']]
      )
    ]);

    expect(graph.edges).toEqual([
      ['attachmentsProcessor', 'api'],
      ['dbMigrationsLoop', 'api']
    ]);
    expect(graph.layers).toEqual([
      ['attachmentsProcessor', 'dbMigrationsLoop'],
      ['api']
    ]);
  });

  it('rejects a cycle introduced by the registry and candidate edge union', () => {
    expect(() =>
      backendDeployGraph([
        backendCandidate(
          ['api', 'dbMigrationsLoop'],
          [['api', 'dbMigrationsLoop']]
        )
      ])
    ).toThrow('DAG cycle detected');
  });

  it.each(['staging', 'prod'] as const)(
    'dispatches three independent %s units together',
    async (environment) => {
      const environmentTrain = {
        ...train,
        target_lane: environment === 'prod' ? 'PRODUCTION' : 'STAGING',
        backend_pr_number: environment === 'prod' ? 1800 : null
      } as ReleaseTrainRecord;

      await expect(
        advanceBackendDeploy(
          environmentTrain,
          [backendCandidate(units)],
          environment
        )
      ).resolves.toBe('WAIT');

      expect(mockDispatchWorkflow).toHaveBeenCalledTimes(3);
      expect(
        mockDispatchWorkflow.mock.calls
          .map((call) => call[3].service)
          .sort((a, b) => String(a).localeCompare(String(b)))
      ).toEqual([...units].sort((a, b) => a.localeCompare(b)));
      for (const call of mockDispatchWorkflow.mock.calls) {
        expect(call[3]).toEqual(
          expect.objectContaining({
            environment,
            artifact_run_id: preflightOperation.external_id
          })
        );
        if (environment === 'prod') {
          expect(call[3]).toEqual(
            expect.objectContaining({
              release_pull_request: '1800',
              release_note_publish: 'true',
              release_group_services: [...units]
                .sort((a, b) => a.localeCompare(b))
                .join(',')
            })
          );
        } else {
          expect(call[3]).not.toHaveProperty('release_note_publish');
        }
      }
    }
  );

  it('dispatches A and B together and waits for both before D', async () => {
    const dependent = 'aggregatedActivityLoop';
    const parents = ['attachmentsOrchestrator', 'attachmentsProcessor'];
    const selected = [...parents, dependent];
    const candidateWithBarrier = backendCandidate(selected, [
      [parents[0], dependent],
      [parents[1], dependent]
    ]);

    await expect(
      advanceBackendDeploy(train, [candidateWithBarrier], 'staging')
    ).resolves.toBe('WAIT');
    expect(
      mockDispatchWorkflow.mock.calls.map((call) => call[3].service).sort()
    ).toEqual([...parents].sort());

    deployOperations = parents.map((service) =>
      deploymentOperation(service, 'SUCCEEDED')
    );
    mockDispatchWorkflow.mockClear();
    await expect(
      advanceBackendDeploy(train, [candidateWithBarrier], 'staging')
    ).resolves.toBe('WAIT');
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchWorkflow.mock.calls[0]?.[3].service).toBe(dependent);
  });

  it('settles a running sibling and never unlocks a failed sibling downstream', async () => {
    const dependent = 'aggregatedActivityLoop';
    const parents = ['attachmentsOrchestrator', 'attachmentsProcessor'];
    const candidateWithBarrier = backendCandidate(
      [...parents, dependent],
      parents.map((parent) => [parent, dependent] as const)
    );
    deployOperations = [
      deploymentOperation(parents[0], 'FAILED'),
      deploymentOperation(parents[1], 'RUNNING')
    ];

    await expect(
      advanceBackendDeploy(train, [candidateWithBarrier], 'staging')
    ).resolves.toBe('WAIT');
    expect(mockFindWorkflowRun).toHaveBeenCalledWith(
      'backend',
      'deploy.yml',
      deployOperations[1].operation_key,
      deployOperations[1].external_id
    );
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();

    deployOperations = [
      deploymentOperation(parents[0], 'FAILED'),
      deploymentOperation(parents[1], 'SUCCEEDED')
    ];
    await expect(
      advanceBackendDeploy(train, [candidateWithBarrier], 'staging')
    ).resolves.toBe('FAIL');
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('reconciles successful and running services without duplicate dispatch', async () => {
    deployOperations = [
      deploymentOperation(units[0], 'SUCCEEDED'),
      deploymentOperation(units[1], 'RUNNING')
    ];

    await expect(
      advanceBackendDeploy(train, [backendCandidate(units)], 'staging')
    ).resolves.toBe('WAIT');
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchWorkflow.mock.calls[0]?.[3].service).toBe(units[2]);

    const created = Array.from(createdOperations.values())[0];
    deployOperations.push({
      ...(created as ReturnType<typeof deploymentOperation>),
      status: 'RUNNING'
    });
    mockDispatchWorkflow.mockClear();
    await expect(
      advanceBackendDeploy(train, [backendCandidate(units)], 'staging')
    ).resolves.toBe('WAIT');
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('retries only the failed infrastructure sibling and preserves successes', async () => {
    deployOperations = [
      deploymentOperation(units[0], 'FAILED', {
        gate_report: {
          status: 'FAILED',
          failure_class: 'INFRASTRUCTURE_TRANSIENT',
          failure_phase: 'workflow_runtime',
          retryable: true
        }
      }),
      deploymentOperation(units[1], 'SUCCEEDED'),
      deploymentOperation(units[2], 'SUCCEEDED')
    ];

    await expect(
      advanceBackendDeploy(train, [backendCandidate(units)], 'staging')
    ).resolves.toBe('INFRASTRUCTURE_WAIT');
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchWorkflow.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ service: units[0] })
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OPERATION_INFRASTRUCTURE_RETRY_DISPATCHED',
        payload: expect.objectContaining({ next_attempt: 2 })
      }),
      {}
    );
  });
});

describe('finishIncompleteComposition', () => {
  const composeWorkflow = readFileSync(
    path.join(process.cwd(), '.github/workflows/release-bus-compose.yml'),
    'utf8'
  );
  const candidates = [
    candidate('candidate-a', 'backend', SHA_A, 101),
    candidate('candidate-b', 'frontend', SHA_B, 102),
    candidate('candidate-c', 'backend', SHA_C, 103)
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindCandidateById.mockImplementation(async (id: string) =>
      candidates.find((item) => item.id === id)
    );
    mockGetLane.mockResolvedValue(null);
    mockEnsureCommitStatus.mockResolvedValue(undefined);
    mockCommentOnPullRequest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.RELEASE_BUS_MODE;
  });

  it('guards and integrity-checks a Codex-disabled deferred composition', () => {
    expect(composeWorkflow).toContain(
      'git rev-parse -q --verify MERGE_HEAD >/dev/null'
    );
    expect(composeWorkflow).toContain('Release-Bus-Defer: true');
    expect(composeWorkflow).toContain(
      'Incomplete composition does not contain a strict candidate prefix.'
    );
    expect(composeWorkflow).toContain('test "$missing_seen" = true');
  });

  it('retries backend publication from the original verified composition artifact', () => {
    expect(composeWorkflow).toContain('composition_artifact_run_id');
    expect(composeWorkflow).toContain(
      "if: inputs.composition_artifact_run_id == ''"
    );
    expect(composeWorkflow).toContain(
      'run-id: ${{ inputs.composition_artifact_run_id || github.run_id }}'
    );
    expect(composeWorkflow).toContain('release_branch_publication');
    expect(composeWorkflow).toContain('INFRASTRUCTURE_TRANSIENT');
    expect(composeWorkflow).toContain('403|5[0-9]{2}');
  });

  it('quarantines the first omitted candidate and requeues later unattempted work', async () => {
    mockRefContainsCommit
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const offender = await finishIncompleteComposition(train, candidates);

    expect(offender?.id).toBe('candidate-b');
    expect(mockUpdateCandidateLifecycle).toHaveBeenNthCalledWith(
      1,
      'candidate-a',
      1,
      expect.objectContaining({
        status: 'READY_FOR_STAGING',
        currentTrainId: null
      }),
      {}
    );
    expect(mockUpdateCandidateLifecycle).toHaveBeenNthCalledWith(
      2,
      'candidate-b',
      1,
      expect.objectContaining({
        status: 'QUARANTINED',
        holdReason: 'MERGE_CONFLICT_REQUIRES_DEVELOPER'
      }),
      {}
    );
    expect(mockUpdateCandidateLifecycle).toHaveBeenNthCalledWith(
      3,
      'candidate-c',
      1,
      expect.objectContaining({ status: 'READY_FOR_STAGING' }),
      {}
    );
    expect(mockUpdateTrain).toHaveBeenCalledWith(
      'train-1',
      expect.objectContaining({ status: 'CANCELLED' }),
      {}
    );
    expect(mockCommentOnPullRequest).toHaveBeenCalledWith(
      'frontend',
      102,
      expect.stringContaining('resolve the conflict')
    );
  });

  it('emits an operator metric when the quarantine PR comment fails', async () => {
    mockRefContainsCommit
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockCommentOnPullRequest.mockRejectedValueOnce(new Error('GitHub failed'));

    await finishIncompleteComposition(train, candidates);

    expect(mockPublishReleaseBusMetrics).toHaveBeenCalledWith([
      expect.objectContaining({
        MetricName: 'CandidateNotificationFailure',
        Dimensions: expect.arrayContaining([
          { Name: 'Channel', Value: 'PullRequestComment' }
        ])
      })
    ]);
  });

  it('leaves a complete composition unchanged', async () => {
    mockRefContainsCommit.mockResolvedValue(true);

    await expect(
      finishIncompleteComposition(train, candidates)
    ).resolves.toBeNull();

    expect(mockUpdateCandidateLifecycle).not.toHaveBeenCalled();
    expect(mockUpdateTrain).not.toHaveBeenCalled();
  });

  it('cancels before preflight when a successful compose run published an incomplete branch', async () => {
    process.env.RELEASE_BUS_MODE = 'STAGING';
    mockFindTrain.mockResolvedValue(train);
    mockListTrainItems.mockResolvedValue(
      candidates.map((item, index) => ({
        candidate_id: item.id,
        sequence: index + 1
      }))
    );
    mockHeartbeatLane.mockResolvedValue(true);
    mockListControls.mockResolvedValue([]);
    mockListTrainOperations.mockResolvedValue([
      {
        operation_type: 'compose-frontend',
        status: 'SUCCEEDED'
      }
    ]);
    mockRefContainsCommit.mockResolvedValueOnce(false);

    await expect(advanceReleaseTrain(train.id)).resolves.toMatchObject({
      decision: 'COMPLETE',
      status: 'CANCELLED'
    });

    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('completes shadow evaluation without publishing a GitHub status', async () => {
    process.env.RELEASE_BUS_MODE = 'SHADOW';
    const shadowTrain = { ...train, status: 'FROZEN' as const };
    mockFindTrain.mockResolvedValue(shadowTrain);
    mockListTrainItems.mockResolvedValue([
      { candidate_id: candidates[0].id, sequence: 1 }
    ]);

    await expect(advanceReleaseTrain(shadowTrain.id)).resolves.toMatchObject({
      decision: 'COMPLETE',
      status: 'COMPLETED'
    });

    expect(mockAddEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: candidates[0].id,
        evidenceType: 'CANDIDATE_SHADOW_EVALUATED_STAGING',
        status: 'SUCCEEDED'
      }),
      {}
    );
    expect(mockEnsureCommitStatus).not.toHaveBeenCalled();
  });
});
