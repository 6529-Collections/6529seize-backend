const mockFindOperation = jest.fn();
const mockGetLane = jest.fn();
const mockBindOperationAuthorization = jest.fn();
const mockUpdateOperation = jest.fn();
const mockAppendEvent = jest.fn();
const mockExecuteTransaction = jest.fn();
const mockFindCandidateById = jest.fn();
const mockGetWorkflowRunIdentity = jest.fn();
const mockIsOrganizationOperator = jest.fn();
const mockPauseForBreakGlass = jest.fn();
const mockMarkReady = jest.fn();
const mockCancel = jest.fn();
const mockGetViewer = jest.fn();
const mockAssertRepositoryWriteAccess = jest.fn();
const mockResolveBranchHead = jest.fn();
const mockFindOpenPullRequest = jest.fn();
const mockCreateCommitStatus = jest.fn();
const mockGetReleaseBusCommitStatusState = jest.fn();
const mockListTrains = jest.fn();
const mockFindTrain = jest.fn();
const mockListTrainItems = jest.fn();
const mockGetReleaseTrainOverview = jest.fn();
const mockListControls = jest.fn();
const mockResetExperimentalHistory = jest.fn();
const mockV2FindCandidateById = jest.fn();
const mockV2ListCandidates = jest.fn();
const mockV2ListControls = jest.fn();
const mockV2ListLocks = jest.fn();
const mockV2ListDependencies = jest.fn();
const mockV2AppendEvent = jest.fn();
const mockV2FindTrain = jest.fn();
const mockV2ListTrainCandidates = jest.fn();
const mockV2ListOperations = jest.fn();
const mockV2ListEvents = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  InvokeCommand: class InvokeCommand {
    public constructor(public readonly input: unknown) {}
  },
  LambdaClient: class LambdaClient {
    public send(...args: unknown[]) {
      return mockLambdaSend(...args);
    }
  }
}));
const mockV2MarkReadyForProduction = jest.fn();
const mockV2Cancel = jest.fn();
const mockV2Register = jest.fn();
const mockV2IsBetaTrainAllowed = jest.fn();
const mockV2Authorize = jest.fn();
const mockV2ReportProgress = jest.fn();
const mockRecoverUnsatisfiableProductionQualifications = jest.fn();

jest.mock('@/releaseBus/release-bus.repository', () => ({
  releaseBusRepository: {
    findOperation: (...args: unknown[]) => mockFindOperation(...args),
    getLane: (...args: unknown[]) => mockGetLane(...args),
    bindOperationAuthorization: (...args: unknown[]) =>
      mockBindOperationAuthorization(...args),
    updateOperation: (...args: unknown[]) => mockUpdateOperation(...args),
    appendEvent: (...args: unknown[]) => mockAppendEvent(...args),
    executeNativeQueriesInTransaction: (...args: unknown[]) =>
      mockExecuteTransaction(...args),
    findCandidateById: (...args: unknown[]) => mockFindCandidateById(...args),
    listTrains: (...args: unknown[]) => mockListTrains(...args),
    findTrain: (...args: unknown[]) => mockFindTrain(...args),
    listTrainItems: (...args: unknown[]) => mockListTrainItems(...args),
    listControls: (...args: unknown[]) => mockListControls(...args)
  }
}));

jest.mock('@/releaseBus/release-bus-status.service', () => ({
  getReleaseTrainOverview: (...args: unknown[]) =>
    mockGetReleaseTrainOverview(...args)
}));

jest.mock('@/api/deploy/deploy.github.service', () => ({
  gitHubDeployService: {
    getViewer: (...args: unknown[]) => mockGetViewer(...args),
    assertRepositoryWriteAccess: (...args: unknown[]) =>
      mockAssertRepositoryWriteAccess(...args),
    resolveBranchHead: (...args: unknown[]) => mockResolveBranchHead(...args),
    findOpenPullRequest: (...args: unknown[]) =>
      mockFindOpenPullRequest(...args),
    createCommitStatus: (...args: unknown[]) => mockCreateCommitStatus(...args),
    getReleaseBusCommitStatusState: (...args: unknown[]) =>
      mockGetReleaseBusCommitStatusState(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.github-app', () => ({
  releaseBusGitHubApp: {
    getWorkflowRunIdentity: (...args: unknown[]) =>
      mockGetWorkflowRunIdentity(...args),
    isOrganizationOperator: (...args: unknown[]) =>
      mockIsOrganizationOperator(...args)
  }
}));

jest.mock('@/releaseBus/release-bus.service', () => ({
  ...jest.requireActual('@/releaseBus/release-bus.service'),
  releaseBusService: {
    pauseForBreakGlass: (...args: unknown[]) => mockPauseForBreakGlass(...args),
    markReady: (...args: unknown[]) => mockMarkReady(...args),
    cancel: (...args: unknown[]) => mockCancel(...args),
    resetExperimentalHistory: (...args: unknown[]) =>
      mockResetExperimentalHistory(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.repository', () => ({
  releaseBusV2Repository: {
    findCandidateById: (...args: unknown[]) => mockV2FindCandidateById(...args),
    listCandidates: (...args: unknown[]) => mockV2ListCandidates(...args),
    listControls: (...args: unknown[]) => mockV2ListControls(...args),
    listLocks: (...args: unknown[]) => mockV2ListLocks(...args),
    listDependencies: (...args: unknown[]) => mockV2ListDependencies(...args),
    appendEvent: (...args: unknown[]) => mockV2AppendEvent(...args),
    listTrains: jest.fn(async () => []),
    findTrain: (...args: unknown[]) => mockV2FindTrain(...args),
    listManifests: jest.fn(async () => []),
    listTrainCandidates: (...args: unknown[]) =>
      mockV2ListTrainCandidates(...args),
    listOperations: (...args: unknown[]) => mockV2ListOperations(...args),
    listEvents: (...args: unknown[]) => mockV2ListEvents(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.service', () => ({
  releaseBusV2Service: {
    register: (...args: unknown[]) => mockV2Register(...args),
    markReadyForProduction: (...args: unknown[]) =>
      mockV2MarkReadyForProduction(...args),
    revokeProductionReadiness: jest.fn(),
    cancel: (...args: unknown[]) => mockV2Cancel(...args),
    setPaused: jest.fn(),
    invalidateBranch: jest.fn(),
    isBetaTrainAllowed: (...args: unknown[]) =>
      mockV2IsBetaTrainAllowed(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.operations', () => ({
  releaseBusV2Operations: {
    authorize: (...args: unknown[]) => mockV2Authorize(...args),
    reportProgress: (...args: unknown[]) => mockV2ReportProgress(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.reconciler', () => ({
  releaseBusV2Reconciler: {
    recoverUnsatisfiableProductionQualifications: (...args: unknown[]) =>
      mockRecoverUnsatisfiableProductionQualifications(...args)
  }
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import deployRoutes from '@/api/deploy/deploy.routes';
import { ReleaseBusHistoryResetBlockedError } from '@/releaseBus/release-bus.service';

const WORKFLOW_TOKEN = 'release-bus-workflow-token';
const TRAIN_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const RESET_ID = '123e4567-e89b-42d3-a456-426614174001';

function candidate(status: 'READY_FOR_STAGING' | 'CANCELLED') {
  return {
    id: 'candidate-1',
    repository: 'frontend',
    branch_name: 'feature/example',
    head_sha: SHA,
    pr_number: 123,
    status,
    staging_ready_by_github_login: 'developer',
    staging_ready_at: Date.now(),
    production_ready_by_github_login: null,
    production_ready_at: null,
    deploy_plan_json: null,
    force_fresh_base_canary: false,
    metadata_version: 1,
    current_train_id: null,
    hold_reason: null,
    invalidated_at: null,
    released_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    row_version: 1
  } as const;
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/deploy', deployRoutes);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiCompliantException) {
      res.status(err.getStatusCode()).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function withServer<T>(
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = createTestApp().listen(0, () =>
      resolve(listeningServer)
    );
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server to listen on a TCP port');
    }
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function post(path: string, body: unknown) {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WORKFLOW_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & {
        error?: string;
      }
    };
  });
}

async function get(path: string) {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${WORKFLOW_TOKEN}` }
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>
    };
  });
}

function authorizeBody() {
  return {
    train_id: TRAIN_ID,
    operation_key: `${TRAIN_ID}:r1:deploy:backend:prod:api`,
    workflow_run_id: '12345',
    artifact_run_id: '54321',
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    artifact_digest: DIGEST
  };
}

function matchingOperation() {
  return {
    train_id: TRAIN_ID,
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    artifact_digest: null,
    status: 'DISPATCHED',
    request_metadata_json: { inputs: { artifact_run_id: '54321' } }
  };
}

function breakGlassBody() {
  return {
    workflow_run_id: '67890',
    repository: 'backend',
    environment: 'prod',
    service: 'api',
    expected_sha: SHA,
    reason: 'Emergency fix forward'
  };
}

function aggregateSummary() {
  return {
    base_sha: SHA,
    environment: 'orchestration',
    gate_fingerprint: `sha256:${'c'.repeat(64)}`,
    workflow_sha: 'd'.repeat(40),
    workflow_digest: 'e'.repeat(64),
    node_version: '24.6.0',
    package_manager: 'npm@11.5.1',
    shard_count: 2,
    summary_artifact_name: 'release-bus/base-canary-summary.json',
    summary_artifact_digest: 'f'.repeat(64),
    phase_durations_ms: { lint: 1000, unit_tests: 2000, total: 3000 },
    totals: {
      files: 500,
      test_suites: 400,
      tests: 5000,
      failed_test_suites: 0,
      failed_tests: 0
    },
    fresh_or_reused: 'fresh',
    shards: [
      {
        index: 0,
        count: 2,
        coordinate: '0/2',
        status: 'SUCCEEDED',
        duration_ms: 1000,
        files: 250,
        test_suites: 200,
        tests: 2500,
        failed_test_suites: 0,
        failed_tests: 0
      },
      {
        index: 1,
        count: 2,
        coordinate: '1/2',
        status: 'SUCCEEDED',
        duration_ms: 1000,
        files: 250,
        test_suites: 200,
        tests: 2500,
        failed_test_suites: 0,
        failed_tests: 0
      }
    ],
    missing_files: [],
    duplicate_files: []
  } as const;
}

function progressBody() {
  return {
    train_id: TRAIN_ID,
    operation_key: `${TRAIN_ID}:r1:base-canary-frontend`,
    workflow_run_id: '12345',
    phase: 'complete',
    status: 'SUCCEEDED',
    stages: [
      { name: 'lint', status: 'SUCCEEDED' },
      { name: 'typecheck', status: 'SUCCEEDED' },
      { name: 'unit_tests', status: 'SUCCEEDED' },
      { name: 'build', status: 'SUCCEEDED' }
    ],
    jest: {
      num_failed_test_suites: 0,
      num_failed_tests: 0,
      failing_suites: [],
      failing_tests: []
    },
    summary: aggregateSummary()
  } as const;
}

function readyBody(targetLane: 'STAGING' | 'PRODUCTION' = 'STAGING') {
  return {
    repository: 'frontend',
    branch: 'feature/example',
    expected_head_sha: SHA,
    target_lane: targetLane,
    dependencies: [],
    deploy_plan: null
  };
}

describe('release-bus readiness routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_MODE = 'OFF';
    mockGetViewer.mockResolvedValue({ login: 'developer' });
    mockAssertRepositoryWriteAccess.mockResolvedValue(undefined);
    mockResolveBranchHead.mockResolvedValue(SHA);
    mockFindOpenPullRequest.mockResolvedValue({ number: 123 });
    mockMarkReady.mockResolvedValue(candidate('READY_FOR_STAGING'));
    mockFindCandidateById.mockResolvedValue(candidate('READY_FOR_STAGING'));
    mockCancel.mockResolvedValue(candidate('CANCELLED'));
    mockCreateCommitStatus.mockResolvedValue(undefined);
    mockGetReleaseBusCommitStatusState.mockResolvedValue('pending');
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_MODE;
  });

  it('rejects readiness while the bus is OFF without touching GitHub', async () => {
    const response = await post(
      '/deploy/release-candidates/ready',
      readyBody()
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Release Bus is OFF');
    expect(mockGetViewer).not.toHaveBeenCalled();
    expect(mockMarkReady).not.toHaveBeenCalled();
    expect(mockCreateCommitStatus).not.toHaveBeenCalled();
  });

  it('records SHADOW readiness without creating a GitHub status', async () => {
    process.env.RELEASE_BUS_MODE = 'SHADOW';

    const response = await post(
      '/deploy/release-candidates/ready',
      readyBody()
    );

    expect(response.status).toBe(202);
    expect(mockMarkReady).toHaveBeenCalled();
    expect(mockCreateCommitStatus).not.toHaveBeenCalled();
  });

  it('rejects production readiness while only staging is enabled', async () => {
    process.env.RELEASE_BUS_MODE = 'STAGING';

    const response = await post(
      '/deploy/release-candidates/ready',
      readyBody('PRODUCTION')
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('disabled in STAGING mode');
    expect(mockGetViewer).not.toHaveBeenCalled();
    expect(mockCreateCommitStatus).not.toHaveBeenCalled();
  });

  it('creates a pending status for an enabled staging submission', async () => {
    process.env.RELEASE_BUS_MODE = 'STAGING';

    const response = await post(
      '/deploy/release-candidates/ready',
      readyBody()
    );

    expect(response.status).toBe(202);
    expect(mockCreateCommitStatus).toHaveBeenCalledWith(
      WORKFLOW_TOKEN,
      'frontend',
      SHA,
      'pending',
      'ready for staging (staging)',
      expect.stringContaining('/deploy/ui/bus')
    );
  });

  it('publishes a terminal status when readiness is cancelled', async () => {
    const response = await post(
      '/deploy/release-candidates/candidate-1/cancel',
      {}
    );

    expect(response.status).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith('candidate-1', 'developer');
    expect(mockCreateCommitStatus).toHaveBeenCalledWith(
      WORKFLOW_TOKEN,
      'frontend',
      SHA,
      'success',
      'release readiness cancelled',
      expect.stringContaining('/deploy/ui/bus')
    );
  });

  it('does not create a status when cancelling a shadow-only candidate', async () => {
    process.env.RELEASE_BUS_MODE = 'SHADOW';
    mockGetReleaseBusCommitStatusState.mockResolvedValue(null);

    const response = await post(
      '/deploy/release-candidates/candidate-1/cancel',
      {}
    );

    expect(response.status).toBe(200);
    expect(mockCreateCommitStatus).not.toHaveBeenCalled();
  });

  it('does not overwrite a terminal Release Bus status during cancellation', async () => {
    mockGetReleaseBusCommitStatusState.mockResolvedValue('failure');

    const response = await post(
      '/deploy/release-candidates/candidate-1/cancel',
      {}
    );

    expect(response.status).toBe(200);
    expect(mockCreateCommitStatus).not.toHaveBeenCalled();
  });
});

describe('release-bus authorization routes', () => {
  beforeEach(() => {
    process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN = WORKFLOW_TOKEN;
    jest.clearAllMocks();
    mockFindOperation.mockResolvedValue(matchingOperation());
    mockGetLane.mockResolvedValue({
      train_id: TRAIN_ID,
      expires_at: Date.now() + 60_000
    });
    mockBindOperationAuthorization.mockResolvedValue(true);
    mockAppendEvent.mockResolvedValue(undefined);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      headSha: SHA,
      event: 'workflow_dispatch',
      name: 'Deploy a service',
      displayTitle: 'Deploy api to prod [manual]',
      actor: 'operator'
    });
    mockIsOrganizationOperator.mockResolvedValue(true);
    mockPauseForBreakGlass.mockResolvedValue(null);
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  });

  it('rejects an authorization request that does not match its operation', async () => {
    mockFindOperation.mockResolvedValue({
      ...matchingOperation(),
      expected_sha: 'c'.repeat(40)
    });

    const response = await post(
      '/deploy/release-bus/authorize',
      authorizeBody()
    );

    expect(response.status).toBe(403);
    expect(mockBindOperationAuthorization).not.toHaveBeenCalled();
  });

  it('authorizes an artifact-free staging validation operation', async () => {
    const operationKey = `rb:${TRAIN_ID}:r1:e2e-staging:${'a'.repeat(32)}:a1`;
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      repository: 'frontend',
      environment: 'staging',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      status: 'DISPATCHED',
      request_metadata_json: { inputs: {} }
    });

    const response = await post('/deploy/release-bus/authorize', {
      train_id: TRAIN_ID,
      operation_key: operationKey,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'staging',
      service: null,
      expected_sha: SHA,
      artifact_digest: null
    });

    expect(response.status).toBe(200);
    expect(mockBindOperationAuthorization).toHaveBeenCalledWith(
      operationKey,
      '12345',
      null,
      {}
    );
  });

  it('rejects an artifact-free production deploy before operation lookup', async () => {
    const response = await post('/deploy/release-bus/authorize', {
      ...authorizeBody(),
      operation_key: `rb:${TRAIN_ID}:r1:deploy-backend-prod-api:${'a'.repeat(32)}:a1`,
      artifact_run_id: null,
      artifact_digest: null
    });

    expect(response.status).toBe(400);
    expect(mockFindOperation).not.toHaveBeenCalled();
    expect(mockBindOperationAuthorization).not.toHaveBeenCalled();
  });

  it('authorizes the exact artifact run and digest for a production deploy', async () => {
    const response = await post(
      '/deploy/release-bus/authorize',
      authorizeBody()
    );

    expect(response.status).toBe(200);
    expect(mockBindOperationAuthorization).toHaveBeenCalledWith(
      authorizeBody().operation_key,
      '12345',
      DIGEST,
      {}
    );
  });

  it('rejects a workflow or digest that loses the atomic claim', async () => {
    mockBindOperationAuthorization.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus/authorize',
      authorizeBody()
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('different workflow run or artifact');
  });

  it('rejects break glass when the exact workflow actor is not an operator', async () => {
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus/authorize-break-glass',
      breakGlassBody()
    );

    expect(response.status).toBe(403);
    expect(mockPauseForBreakGlass).not.toHaveBeenCalled();
  });

  it('does not authorize or audit break glass while a train is active', async () => {
    mockPauseForBreakGlass.mockResolvedValue({ id: 'active-train' });

    const response = await post(
      '/deploy/release-bus/authorize-break-glass',
      breakGlassBody()
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('lane was not paused');
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });
});

describe('release-bus progress reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN = WORKFLOW_TOKEN;
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'base-canary-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      status: 'DISPATCHED',
      row_version: 1,
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
      }
    });
    mockExecuteTransaction.mockImplementation(async (callback) =>
      callback({ transaction: 'test' })
    );
    mockBindOperationAuthorization.mockResolvedValue(true);
    mockUpdateOperation.mockResolvedValue(undefined);
    mockAppendEvent.mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  });

  it('binds the report to the exact operation and workflow run', async () => {
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: null,
      status: 'DISPATCHED'
    });

    const response = await post(
      '/deploy/release-bus/report-progress',
      progressBody()
    );

    expect(response.status).toBe(403);
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('persists a bounded aggregate in operation metadata and the durable event', async () => {
    const response = await post(
      '/deploy/release-bus/report-progress',
      progressBody()
    );

    expect(response.status).toBe(200);
    expect(mockUpdateOperation).toHaveBeenCalledWith(
      progressBody().operation_key,
      expect.objectContaining({
        status: 'DISPATCHED',
        resultMetadata: expect.objectContaining({
          gate_report: expect.objectContaining({
            phase: 'complete',
            summary: expect.objectContaining({
              ...aggregateSummary(),
              totals: expect.objectContaining(aggregateSummary().totals),
              unexpected_files: [],
              kind: 'base_canary_summary'
            })
          }),
          last_progress_at: expect.any(Number)
        })
      }),
      { connection: { transaction: 'test' } }
    );
    expect(mockAppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'OPERATION_GATE_REPORT',
        payload: expect.objectContaining({
          phase: 'complete',
          summary: expect.objectContaining({
            ...aggregateSummary(),
            totals: expect.objectContaining(aggregateSummary().totals),
            unexpected_files: [],
            kind: 'base_canary_summary'
          })
        })
      }),
      { connection: { transaction: 'test' } }
    );
  });

  it('binds an exact preflight base-evidence summary digest to its operation', async () => {
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'preflight-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      artifact_digest: null,
      status: 'DISPATCHED',
      row_version: 1,
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
      }
    });
    const report = progressBody();

    const response = await post('/deploy/release-bus/report-progress', {
      ...report,
      summary: {
        ...report.summary,
        kind: 'frontend_preflight_base_evidence_summary',
        proof_origin: 'fresh_preflight',
        build_environments: ['staging'],
        build_coverage: {
          base_canary_profile: 'SUCCEEDED',
          deploy_artifact_profile: 'SUCCEEDED'
        }
      }
    });

    expect(response.status).toBe(200);
    expect(mockBindOperationAuthorization).toHaveBeenCalledWith(
      report.operation_key,
      report.workflow_run_id,
      'f'.repeat(64),
      { connection: { transaction: 'test' } }
    );
  });

  it('rejects a frontend preflight summary whose kind was omitted and defaulted to base canary', async () => {
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'preflight-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      artifact_digest: null,
      status: 'DISPATCHED',
      row_version: 1,
      result_metadata_json: {
        url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
      }
    });
    const report = progressBody();
    const summary = { ...report.summary } as Record<string, unknown>;
    delete summary.kind;

    const response = await post('/deploy/release-bus/report-progress', {
      ...report,
      summary
    });

    expect(response.status).toBe(403);
    expect(mockBindOperationAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'base SHA',
      operation: { expected_sha: 'b'.repeat(40) }
    },
    {
      name: 'environment',
      operation: { environment: 'prod' }
    },
    {
      name: 'operation type',
      operation: { operation_type: 'preflight-frontend' }
    }
  ])(
    'rejects an aggregate with a mismatched authorized $name',
    async ({ operation }) => {
      mockFindOperation.mockResolvedValue({
        train_id: TRAIN_ID,
        external_id: '12345',
        operation_type: 'base-canary-frontend',
        expected_sha: SHA,
        environment: 'orchestration',
        status: 'DISPATCHED',
        row_version: 1,
        result_metadata_json: {},
        ...operation
      });

      const response = await post(
        '/deploy/release-bus/report-progress',
        progressBody()
      );

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('authorized base canary operation');
      expect(mockUpdateOperation).not.toHaveBeenCalled();
      expect(mockAppendEvent).not.toHaveBeenCalled();
    }
  );

  it('rejects a terminal base canary report without its aggregate summary', async () => {
    const response = await post('/deploy/release-bus/report-progress', {
      ...progressBody(),
      summary: null
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toContain('requires its aggregate summary');
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('rejects failure classification on a successful progress report', async () => {
    const response = await post('/deploy/release-bus/report-progress', {
      ...progressBody(),
      failure_class: 'INFRASTRUCTURE_TRANSIENT',
      failure_phase: 'dependency_install',
      retryable: true
    });

    expect(response.status).toBe(400);
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('accepts an identical pre-classification terminal report idempotently without another event', async () => {
    const report = progressBody();
    const { files, ...totalsRest } = report.summary.totals;
    const [{ index, ...firstShardRest }, ...remainingShards] =
      report.summary.shards;
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'base-canary-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      status: 'SUCCEEDED',
      row_version: 2,
      result_metadata_json: {
        gate_report: {
          phase: report.phase,
          status: report.status,
          stages: report.stages,
          jest: report.jest,
          summary: {
            ...report.summary,
            totals: { ...totalsRest, files },
            shards: [{ ...firstShardRest, index }, ...remainingShards]
          },
          reported_at: 123456
        }
      }
    });

    const response = await post('/deploy/release-bus/report-progress', report);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      idempotent: true,
      reported_at: 123456
    });
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('rejects a conflicting terminal report for the same operation and run', async () => {
    const report = progressBody();
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'base-canary-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      status: 'SUCCEEDED',
      row_version: 2,
      result_metadata_json: {
        gate_report: {
          ...report,
          status: 'FAILED',
          reported_at: 123456
        }
      }
    });

    const response = await post('/deploy/release-bus/report-progress', report);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('different terminal progress report');
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('rejects a late partial report after the terminal report', async () => {
    const report = progressBody();
    mockFindOperation.mockResolvedValue({
      train_id: TRAIN_ID,
      external_id: '12345',
      operation_type: 'base-canary-frontend',
      expected_sha: SHA,
      environment: 'orchestration',
      status: 'SUCCEEDED',
      row_version: 2,
      result_metadata_json: {
        gate_report: { ...report, reported_at: 123456 }
      }
    });

    const response = await post('/deploy/release-bus/report-progress', {
      ...report,
      phase: 'unit_tests',
      status: 'RUNNING',
      summary: null
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('terminal progress report');
    expect(mockUpdateOperation).not.toHaveBeenCalled();
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });
});

describe('release-bus experimental history reset', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetViewer.mockResolvedValue({ login: 'operator' });
    mockIsOrganizationOperator.mockResolvedValue(true);
    mockResetExperimentalHistory.mockResolvedValue({
      reset_at: 123456,
      actor: 'operator',
      reused: false
    });
    mockListControls.mockResolvedValue([
      { scope: 'ALL', paused: 1 },
      { scope: 'STAGING', paused: 1 },
      { scope: 'PRODUCTION', paused: 1 }
    ]);
  });

  it('requires Release Bus operator authorization', async () => {
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(403);
    expect(mockResetExperimentalHistory).not.toHaveBeenCalled();
  });

  it('rejects an inexact destructive confirmation', async () => {
    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'reset',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(400);
    expect(mockResetExperimentalHistory).not.toHaveBeenCalled();
  });

  it('reports a quiescence race as a conflict', async () => {
    mockResetExperimentalHistory.mockRejectedValue(
      new ReleaseBusHistoryResetBlockedError(
        'An active release operation blocks history reset'
      )
    );

    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('active release operation');
    expect(mockListControls).not.toHaveBeenCalled();
  });

  it('returns the deterministic paused controls after a reset', async () => {
    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reset: true,
      reset_at: 123456,
      actor: 'operator',
      reused: false,
      controls: [
        { scope: 'ALL', paused: 1 },
        { scope: 'STAGING', paused: 1 },
        { scope: 'PRODUCTION', paused: 1 }
      ]
    });
    expect(mockResetExperimentalHistory).toHaveBeenCalledWith(
      'Controlled go-live reset after all operations are quiescent',
      'operator',
      RESET_ID
    );
  });

  it('does not invite a retry when the post-reset controls read fails', async () => {
    mockListControls.mockRejectedValue(new Error('database read failed'));

    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      reset: true,
      controls: null,
      controls_status: 'unavailable'
    });
  });

  it('does not mask an unexpected reset failure as a conflict', async () => {
    mockResetExperimentalHistory.mockRejectedValue(
      new Error('database transaction failed')
    );

    const response = await post(
      '/deploy/release-bus/reset-experimental-history',
      {
        reset_id: RESET_ID,
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Controlled go-live reset after all operations are quiescent'
      }
    );

    expect(response.status).toBe(500);
  });
});

describe('release train observability responses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetViewer.mockResolvedValue({ login: 'operator' });
    const train = {
      id: TRAIN_ID,
      status: 'BASE_CANARY_RUNNING',
      target_lane: 'STAGING'
    };
    mockListTrains.mockResolvedValue([train]);
    mockFindTrain.mockResolvedValue(train);
    mockListTrainItems.mockResolvedValue([]);
    mockGetReleaseTrainOverview.mockResolvedValue({
      ...train,
      phase: 'BASE_CANARY_RUNNING',
      phase_state: 'RUNNING',
      wait_reason: {
        code: 'GITHUB_WORKFLOW_RUNNING',
        summary:
          'Frontend base canary running. Candidates have not been tested yet.'
      },
      current_operation: {
        run_id: '12345',
        workflow_url:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345'
      }
    });
  });

  it('returns the enriched active train alongside legacy train records', async () => {
    const response = await get('/deploy/release-trains');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      trains: [{ id: TRAIN_ID }],
      active_train: {
        phase: 'BASE_CANARY_RUNNING',
        phase_state: 'RUNNING',
        current_operation: { run_id: '12345' }
      }
    });
    expect(mockGetReleaseTrainOverview).toHaveBeenCalledWith(
      expect.objectContaining({ id: TRAIN_ID })
    );
  });
});

describe('Release Bus v2 route authorization and exact actions', () => {
  const candidateId = '123e4567-e89b-42d3-a456-426614174099';
  const v2Candidate = {
    id: candidateId,
    repository: 'frontend',
    pr_number: 321,
    branch_name: 'feature/v2',
    head_sha: SHA,
    requested_by: 'developer',
    status: 'STAGING_VALIDATED',
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: TRAIN_ID,
    staging_validated_manifest_id: RESET_ID,
    production_requested_at: null,
    production_requested_by: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 4
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN = WORKFLOW_TOKEN;
    mockGetViewer.mockResolvedValue({ login: 'developer' });
    mockAssertRepositoryWriteAccess.mockResolvedValue(undefined);
    mockV2FindCandidateById.mockResolvedValue(v2Candidate);
    mockV2MarkReadyForProduction.mockResolvedValue({
      ...v2Candidate,
      status: 'READY_FOR_PRODUCTION',
      row_version: 5
    });
    mockV2Cancel.mockResolvedValue({
      ...v2Candidate,
      status: 'CANCELLED',
      row_version: 5
    });
    mockV2Authorize.mockResolvedValue({ authorized: true, reused: false });
    mockV2ListCandidates.mockResolvedValue([v2Candidate]);
    mockV2ListDependencies.mockResolvedValue([
      {
        id: 'dependency-id',
        candidate_id: candidateId,
        prerequisite_candidate_id: '123e4567-e89b-42d3-a456-426614174088',
        environment: 'BOTH',
        created_at: 1
      }
    ]);
    mockIsOrganizationOperator.mockResolvedValue(true);
    mockLambdaSend.mockResolvedValue({ StatusCode: 202 });
    mockV2FindTrain.mockResolvedValue(null);
    mockV2ListTrainCandidates.mockResolvedValue([]);
    mockV2ListOperations.mockResolvedValue([]);
    mockV2ListEvents.mockResolvedValue([]);
    mockV2IsBetaTrainAllowed.mockResolvedValue(true);
    mockRecoverUnsatisfiableProductionQualifications.mockResolvedValue({
      recovered: [
        {
          parent_train_id: TRAIN_ID,
          qualification_train_id: RESET_ID,
          candidate_ids: [candidateId]
        }
      ],
      staging_identity: {
        frontend_sha: SHA,
        backend_sha: 'b'.repeat(40)
      },
      has_more: false
    });
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_V2_MODE;
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    delete process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  });

  it('requires repository write access before explicit production readiness', async () => {
    const response = await post(
      `/deploy/release-bus-v2/candidates/${candidateId}/mark-ready-for-production`,
      { expected_head_sha: SHA, expected_row_version: 4 }
    );

    expect(response.status).toBe(200);
    expect(mockAssertRepositoryWriteAccess).toHaveBeenCalledWith(
      WORKFLOW_TOKEN,
      'frontend'
    );
    expect(mockV2MarkReadyForProduction).toHaveBeenCalledWith(
      candidateId,
      SHA,
      4,
      'developer'
    );
  });

  it('does not expose candidate mutation when the exact candidate is missing', async () => {
    mockV2FindCandidateById.mockResolvedValue(null);
    const response = await post(
      `/deploy/release-bus-v2/candidates/${candidateId}/cancel`,
      { expected_row_version: 4 }
    );

    expect(response.status).toBe(404);
    expect(mockAssertRepositoryWriteAccess).not.toHaveBeenCalled();
    expect(mockV2Cancel).not.toHaveBeenCalled();
  });

  it('accepts the exact artifact-free compose and preflight authorization payload', async () => {
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:frontend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null
    };
    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(200);
    expect(mockV2Authorize).toHaveBeenCalledWith(body);
    expect(response.body).toMatchObject({
      authorized: true,
      train_id: TRAIN_ID,
      operation_key: body.operation_key
    });
  });

  it('returns readable dependency edges with each candidate', async () => {
    const response = await get('/deploy/release-bus-v2/candidates');
    const body = response.body as {
      readonly candidates: ReadonlyArray<{
        readonly dependencies: readonly unknown[];
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.candidates[0]?.dependencies).toEqual([
      expect.objectContaining({
        candidate_id: candidateId,
        environment: 'BOTH'
      })
    ]);
  });

  it('allows an operator to request one audited reconciliation', async () => {
    const response = await post('/deploy/release-bus-v2/reconcile', {});

    expect(response.status).toBe(202);
    expect(mockV2AppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'MANUAL_RECONCILE_REQUESTED',
        actor: 'developer'
      }),
      {}
    );
    expect(mockLambdaSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          FunctionName: 'releaseBusV2Reconciler',
          InvocationType: 'Event'
        })
      })
    );
  });

  it('allows an operator to recover stalled qualifications through the audited maintenance action', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'STAGING';

    const response = await post(
      '/deploy/release-bus-v2/maintenance/recover-stalled-qualifications',
      {}
    );

    expect(response.status).toBe(200);
    expect(
      mockRecoverUnsatisfiableProductionQualifications
    ).toHaveBeenCalledWith('developer');
    expect(response.body).toMatchObject({
      mode: 'STAGING',
      recovered_by: 'developer',
      recovered: [
        {
          parent_train_id: TRAIN_ID,
          qualification_train_id: RESET_ID,
          candidate_ids: [candidateId]
        }
      ]
    });
  });

  it('returns conflict when the audited maintenance recovery safety fence rejects', async () => {
    mockRecoverUnsatisfiableProductionQualifications.mockRejectedValue(
      new Error('PRODUCTION must remain paused')
    );

    const response = await post(
      '/deploy/release-bus-v2/maintenance/recover-stalled-qualifications',
      {}
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'PRODUCTION must remain paused'
    });
  });

  it('keeps ordinary candidate registration disabled while global mode is OFF', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post('/deploy/release-bus-v2/candidates', {
      candidate_id: candidateId,
      repository: 'frontend',
      pr_number: 321,
      branch_name: 'agent/rb2-beta-frontend-one',
      expected_head_sha: SHA,
      deploy_plan: null,
      dependencies: []
    });

    expect(response.status).toBe(403);
    expect(mockV2Register).not.toHaveBeenCalled();
    expect(mockAssertRepositoryWriteAccess).not.toHaveBeenCalled();
  });

  it('queues an operator-only beta reconciliation while reporting global OFF', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'frontend-only-1',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-beta-frontend-one',
        operator: 'developer',
        lanes: ['STAGING']
      }
    ]);

    const response = await post('/deploy/release-bus-v2/reconcile', {});

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      accepted: true,
      mode: 'OFF',
      execution: 'queued_operator_beta'
    });
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  it('rejects an allowlisted beta actor who is no longer an org operator', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'frontend-only-1',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-beta-frontend-one',
        operator: 'developer',
        lanes: ['STAGING']
      }
    ]);
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post('/deploy/release-bus-v2/reconcile', {});

    expect(response.status).toBe(403);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('fails closed when an OFF workflow train is not beta-allowlisted', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    process.env.RELEASE_BUS_V2_BETA_ALLOWLIST = JSON.stringify([
      {
        test_id: 'frontend-only-1',
        candidate_id: candidateId,
        repository: 'frontend',
        branch_name: 'agent/rb2-beta-frontend-one',
        operator: 'developer',
        lanes: ['STAGING']
      }
    ]);
    mockV2FindTrain.mockResolvedValue({ id: TRAIN_ID, lane: 'STAGING' });
    mockV2IsBetaTrainAllowed.mockResolvedValue(false);
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:frontend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(403);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('returns a uniform 403 when an OFF workflow train lookup fails', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    mockV2FindTrain.mockRejectedValue(new Error('database unavailable'));
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:frontend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(403);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('reports a reconciliation dispatch failure without claiming it was queued', async () => {
    mockLambdaSend.mockRejectedValueOnce(new Error('lambda throttled'));

    const response = await post('/deploy/release-bus-v2/reconcile', {});

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      accepted: false,
      mode: 'PRODUCTION',
      execution: 'dispatch_failed'
    });
    expect(response.body.error).toContain('was not queued');
    expect(mockV2AppendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'MANUAL_RECONCILE_DISPATCH_FAILED',
        actor: 'developer',
        payload: expect.objectContaining({ message: 'lambda throttled' })
      }),
      {}
    );
  });

  it('degrades gracefully when stored workflow request JSON is malformed', async () => {
    mockV2FindTrain.mockResolvedValue({ id: TRAIN_ID, status: 'PREFLIGHTING' });
    mockV2ListOperations.mockResolvedValue([
      {
        id: 'operation-id',
        status: 'RUNNING',
        repository: 'backend',
        external_id: '12345',
        request_json: '{not-json'
      }
    ]);

    const response = await get(`/deploy/release-bus-v2/trains/${TRAIN_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.operations).toEqual([
      expect.objectContaining({ id: 'operation-id', status: 'RUNNING' })
    ]);
  });
});
