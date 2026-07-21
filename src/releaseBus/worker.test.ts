const mockFindCandidateById = jest.fn();
const mockUpdateCandidateLifecycle = jest.fn();
const mockAddEvidence = jest.fn();
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

jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    findCandidateById: (...args: unknown[]) => mockFindCandidateById(...args),
    updateCandidateLifecycle: (...args: unknown[]) =>
      mockUpdateCandidateLifecycle(...args),
    addEvidence: (...args: unknown[]) => mockAddEvidence(...args),
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
    dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args)
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
  });

  afterEach(() => {
    delete process.env.RELEASE_BUS_MODE;
  });

  it('dispatches the immutable base canary before composition', async () => {
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
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
      'BASE_CANARY_RUNNING',
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAIN_PHASE_CHANGED' }),
      { connection: { transaction: 'test' } }
    );
  });

  it('does not advance or append an event after the train phase diverges', async () => {
    mockListTrainOperations.mockResolvedValue([]);
    mockGetOrCreateOperation.mockImplementation(async (operation) => operation);
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockResolvedValue(undefined);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockFindOperation.mockResolvedValue({ status: 'DISPATCHED' });
    mockAdvanceTrainPhase.mockResolvedValue(false);

    await expect(advanceReleaseTrain(frozenTrain.id)).rejects.toThrow(
      'Release train train-1 changed concurrently from FROZEN'
    );

    expect(mockAdvanceTrainPhase).toHaveBeenCalledWith(
      frozenTrain.id,
      'FROZEN',
      'BASE_CANARY_RUNNING',
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TRAIN_PHASE_CHANGED' }),
      expect.anything()
    );
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
