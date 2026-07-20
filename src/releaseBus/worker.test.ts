const mockFindCandidateById = jest.fn();
const mockUpdateCandidateLifecycle = jest.fn();
const mockAddEvidence = jest.fn();
const mockEnsureCommitStatus = jest.fn();
const mockCommentOnPullRequest = jest.fn();
const mockRefContainsCommit = jest.fn();
const mockUpdateTrain = jest.fn();
const mockGetLane = jest.fn();
const mockReleaseLane = jest.fn();
const mockAppendEvent = jest.fn();
const mockPublishReleaseBusMetrics = jest.fn();
const mockFindTrain = jest.fn();
const mockListTrainItems = jest.fn();
const mockHeartbeatLane = jest.fn();
const mockListControls = jest.fn();
const mockListTrainOperations = jest.fn();
const mockResolveRef = jest.fn();

jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    findCandidateById: (...args: unknown[]) => mockFindCandidateById(...args),
    updateCandidateLifecycle: (...args: unknown[]) =>
      mockUpdateCandidateLifecycle(...args),
    addEvidence: (...args: unknown[]) => mockAddEvidence(...args),
    updateTrain: (...args: unknown[]) => mockUpdateTrain(...args),
    getLane: (...args: unknown[]) => mockGetLane(...args),
    releaseLane: (...args: unknown[]) => mockReleaseLane(...args),
    appendEvent: (...args: unknown[]) => mockAppendEvent(...args),
    findTrain: (...args: unknown[]) => mockFindTrain(...args),
    listTrainItems: (...args: unknown[]) => mockListTrainItems(...args),
    heartbeatLane: (...args: unknown[]) => mockHeartbeatLane(...args),
    listControls: (...args: unknown[]) => mockListControls(...args),
    listTrainOperations: (...args: unknown[]) =>
      mockListTrainOperations(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args),
    commentOnPullRequest: (...args: unknown[]) =>
      mockCommentOnPullRequest(...args),
    refContainsCommit: (...args: unknown[]) => mockRefContainsCommit(...args),
    resolveRef: (...args: unknown[]) => mockResolveRef(...args)
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
  finishIncompleteComposition
} from '@/releaseBus/worker';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

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
