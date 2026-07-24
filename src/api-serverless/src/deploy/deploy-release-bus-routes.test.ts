const mockGetViewer = jest.fn();
const mockAssertRepositoryWriteAccess = jest.fn();
const mockIsOrganizationOperator = jest.fn();
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
const mockV2MarkReadyForProduction = jest.fn();
const mockV2Cancel = jest.fn();
const mockV2Register = jest.fn();
const mockV2IsBetaTrainAllowed = jest.fn();
const mockV2Authorize = jest.fn();
const mockV2ReportProgress = jest.fn();
const mockRecoverUnsatisfiableProductionQualifications = jest.fn();

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

jest.mock('@/api/deploy/deploy.github.service', () => ({
  gitHubDeployService: {
    getViewer: (...args: unknown[]) => mockGetViewer(...args),
    assertRepositoryWriteAccess: (...args: unknown[]) =>
      mockAssertRepositoryWriteAccess(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    isOrganizationOperator: (...args: unknown[]) =>
      mockIsOrganizationOperator(...args)
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

const WORKFLOW_TOKEN = 'release-bus-workflow-token';
const TRAIN_ID = '123e4567-e89b-42d3-a456-426614174000';
const RESET_ID = '123e4567-e89b-42d3-a456-426614174001';
const SHA = 'a'.repeat(40);

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

  it('does not expose any unversioned v1 route', async () => {
    await withServer(async (baseUrl) => {
      for (const path of [
        '/deploy/release-candidates',
        '/deploy/release-trains',
        '/deploy/release-bus/controls',
        '/deploy/release-bus/authorize'
      ]) {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${WORKFLOW_TOKEN}` }
        });
        expect(response.status).toBe(404);
      }
    });
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
