const mockFindCandidateById = jest.fn();
const mockUpdateCandidateLifecycle = jest.fn();
const mockAddEvidence = jest.fn();
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
    findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args),
    dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args),
    getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
    getActionsVariable: (...args: unknown[]) =>
      mockGetActionsVariable(...args)
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
  FRONTEND_GATE_BASE_FILES
} from '@/releaseBus/release-bus.base-canary-evidence';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  advanceReleaseTrain,
  finishIncompleteComposition,
  mergeWorkflowProgress,
  operationFailureReason,
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
  const gateContract = buildFrontendGateContract({
    baseSha: frozenTrain.frontend_base_sha as string,
    workflowSha,
    workflowContent: 'workflow-content',
    baseFileContents,
    gateMode: 'sharded',
    shardCount: 4
  });
  const artifactDigest = '9'.repeat(64);
  const reusableSummary = {
    base_sha: gateContract.base_sha,
    environment: gateContract.environment,
    gate_fingerprint: gateContract.gate_fingerprint,
    workflow_sha: gateContract.workflow_sha,
    workflow_digest: gateContract.workflow_digest,
    node_version: gateContract.node_version,
    package_manager: gateContract.package_manager,
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
      skipped_tests: 0
    },
    fresh_or_reused: 'fresh',
    shards: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      count: 4,
      coordinate: `${index + 1}/4`,
      status: 'SUCCEEDED',
      duration_ms: 25
    })),
    missing_files: [],
    duplicate_files: []
  };

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
    mockResolveRef.mockResolvedValue(workflowSha);
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository !== 'frontend') return null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockGetFileContent.mockImplementation(
      async (_repository: string, file: string) =>
        file === '.github/workflows/release-bus-base-canary.yml'
          ? 'workflow-content'
          : baseFileContents[file]
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

  it('records fresh terminal evidence and provenance in one transaction', async () => {
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
          gate_report: { summary: reusableSummary, reported_at: 1_500 }
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
          summary: reusableSummary,
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
  });

  it('advances from reusable exact-SHA evidence in one worker cycle', async () => {
    mockGetActionsVariable.mockImplementation(
      async (repository: string, name: string) => {
        if (repository === 'backend')
          return name === 'RELEASE_BUS_BASE_EVIDENCE_REUSE' ? 'true' : null;
        return name === 'RELEASE_BUS_FRONTEND_GATE_MODE' ? 'sharded' : '4';
      }
    );
    mockListTrainOperations.mockResolvedValue([]);
    mockListBaseCanaryEvidenceBySha.mockResolvedValue([
      {
        id: 'source-evidence',
        train_id: 'source-train',
        revision: 3,
        status: 'SUCCEEDED',
        source_sha: gateContract.base_sha,
        artifact_digest: artifactDigest,
        evidence_uri:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
        metadata_json: {
          contract: gateContract,
          summary: reusableSummary,
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
    expect(mockDispatchWorkflow.mock.calls[0]?.[3]).toHaveProperty(
      'gate_contract',
      JSON.stringify(gateContract)
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
        gate_fingerprint: gateContract.gate_fingerprint,
        gate_mode: 'sharded',
        shard_count: '4'
      })
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
    mockListTrainOperations.mockResolvedValue([]);
    mockListBaseCanaryEvidenceBySha.mockResolvedValue([
      {
        id: 'shadow-source-evidence',
        train_id: 'shadow-source-train',
        revision: 2,
        status: 'SUCCEEDED',
        source_sha: gateContract.base_sha,
        artifact_digest: artifactDigest,
        evidence_uri:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/123',
        metadata_json: {
          contract: gateContract,
          summary: reusableSummary,
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
