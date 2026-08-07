const mockGetViewer = jest.fn();
const mockAssertRepositoryWriteAccess = jest.fn();
const mockDispatchDeploy = jest.fn();
const mockIsOrganizationOperator = jest.fn();
const mockV2FindCandidateById = jest.fn();
const mockV2ListCandidates = jest.fn();
const mockV2ListControls = jest.fn();
const mockV2ListLocks = jest.fn();
const mockV2GetStagingState = jest.fn();
const mockV2ListDependencies = jest.fn();
const mockV2AppendEvent = jest.fn();
const mockV2ListTrains = jest.fn();
const mockV2FindTrain = jest.fn();
const mockV2FindManifest = jest.fn();
const mockV2ListManifests = jest.fn();
const mockV2ListTrainCandidates = jest.fn();
const mockV2ListOperations = jest.fn();
const mockV2ListEvents = jest.fn();
const mockLambdaSend = jest.fn();
const mockV2MarkReadyForProduction = jest.fn();
const mockV2MarkSelectionReadyForProduction = jest.fn();
const mockV2RevokeProductionReadiness = jest.fn();
const mockV2Cancel = jest.fn();
const mockV2Register = jest.fn();
const mockV2RequestStagingTransition = jest.fn();
const mockV2SetPaused = jest.fn();
const mockV2InvalidateBranch = jest.fn();
const mockV2IsBetaTrainAllowed = jest.fn();
const mockV2Authorize = jest.fn();
const mockV2ReportProgress = jest.fn();
const mockManualDeploymentAuthorize = jest.fn();
const mockManualDispatchReady = jest.fn();
const mockRecoverUnsatisfiableProductionQualifications = jest.fn();
const mockRepairCurrentStagingManifestCandidates = jest.fn();
const mockCandidateDeregistrationPrepare = jest.fn();
const mockCandidateDeregistrationExecute = jest.fn();
const mockBaselineAdoptionExecute = jest.fn();
const mockBaselineAdoptionAutomaticDecision = jest.fn();
const mockBaselineAdoptionBackendEvent = jest.fn();
const mockBaselineAdoptionHandleE2EProgress = jest.fn();
const mockProductionAuthorityPrepare = jest.fn();
const mockProductionAuthorityPrepareAndBind = jest.fn();
const mockProductionAuthorityBind = jest.fn();
const mockProductionAuthorityReauthorize = jest.fn();
const mockProductionAuthorityComplete = jest.fn();
const mockProductionAuthorityFail = jest.fn();

class MockReleaseBusV2ProductionSelectionError extends Error {
  public constructor(
    public readonly code: 'CONFLICT' | 'DISABLED' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2ProductionSelectionError';
  }
}

class MockReleaseBusV2CurrentStagingRepairError extends Error {
  public constructor(
    public readonly code:
      | 'BAD_REQUEST'
      | 'CONFLICT'
      | 'DISABLED'
      | 'NOT_FOUND'
      | 'UNPROCESSABLE',
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2CurrentStagingRepairError';
  }
}

class MockReleaseBusV2ManualDeploymentError extends Error {
  public constructor(
    public readonly code: 'CONFLICT' | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2ManualDeploymentError';
  }
}

class MockReleaseBusV2CandidateDeregistrationError extends Error {
  public constructor(
    public readonly code: 'BAD_REQUEST' | 'CONFLICT' | 'UNAVAILABLE',
    message: string,
    public readonly committed: boolean = false,
    public readonly deregistration_id: string | null = null,
    public readonly physical_staging_presence:
      | 'UNKNOWN_UNCHANGED'
      | 'UNKNOWN_DETACHED' = 'UNKNOWN_UNCHANGED'
  ) {
    super(message);
    this.name = 'ReleaseBusV2CandidateDeregistrationError';
  }
}

class MockReleaseBusV2BaselineAdoptionError extends Error {
  public constructor(
    public readonly code: 'BAD_REQUEST' | 'CONFLICT' | 'UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'ReleaseBusV2BaselineAdoptionError';
  }
}

class MockReleaseBusV2ProductionAuthorityError extends Error {
  public readonly name = 'ReleaseBusV2ProductionAuthorityError';

  public constructor(
    public readonly code: 'CONFLICT' | 'UNAVAILABLE',
    message: string,
    public readonly reason_code = 'AUTHORITY_UNAVAILABLE',
    public readonly observed_epoch: unknown = null
  ) {
    super(message);
  }
}

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
      mockAssertRepositoryWriteAccess(...args),
    dispatchDeploy: (...args: unknown[]) => mockDispatchDeploy(...args)
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
    getStagingState: (...args: unknown[]) => mockV2GetStagingState(...args),
    listDependencies: (...args: unknown[]) => mockV2ListDependencies(...args),
    appendEvent: (...args: unknown[]) => mockV2AppendEvent(...args),
    listTrains: (...args: unknown[]) => mockV2ListTrains(...args),
    findTrain: (...args: unknown[]) => mockV2FindTrain(...args),
    findManifest: (...args: unknown[]) => mockV2FindManifest(...args),
    listManifests: (...args: unknown[]) => mockV2ListManifests(...args),
    listTrainCandidates: (...args: unknown[]) =>
      mockV2ListTrainCandidates(...args),
    listOperations: (...args: unknown[]) => mockV2ListOperations(...args),
    listEvents: (...args: unknown[]) => mockV2ListEvents(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.service', () => ({
  ReleaseBusV2CurrentStagingRepairError:
    MockReleaseBusV2CurrentStagingRepairError,
  ReleaseBusV2ProductionSelectionError:
    MockReleaseBusV2ProductionSelectionError,
  ReleaseBusV2StagingTransitionConflictError: class extends Error {},
  releaseBusV2Service: {
    register: (...args: unknown[]) => mockV2Register(...args),
    requestStagingTransition: (...args: unknown[]) =>
      mockV2RequestStagingTransition(...args),
    markReadyForProduction: (...args: unknown[]) =>
      mockV2MarkReadyForProduction(...args),
    markSelectionReadyForProduction: (...args: unknown[]) =>
      mockV2MarkSelectionReadyForProduction(...args),
    revokeProductionReadiness: (...args: unknown[]) =>
      mockV2RevokeProductionReadiness(...args),
    cancel: (...args: unknown[]) => mockV2Cancel(...args),
    setPaused: (...args: unknown[]) => mockV2SetPaused(...args),
    invalidateBranch: (...args: unknown[]) => mockV2InvalidateBranch(...args),
    repairCurrentStagingManifestCandidates: (...args: unknown[]) =>
      mockRepairCurrentStagingManifestCandidates(...args),
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

jest.mock('@/releaseBusV2/release-bus-v2.manual-deployment', () => ({
  ReleaseBusV2ManualDeploymentError: MockReleaseBusV2ManualDeploymentError,
  isReleaseBusV2ManualDeploymentError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'ReleaseBusV2ManualDeploymentError' &&
    ['CONFLICT', 'UNAVAILABLE'].includes(
      String((error as { code?: unknown }).code)
    ),
  releaseBusV2ManualDeploymentGuard: {
    authorizeWorkflow: (...args: unknown[]) =>
      mockManualDeploymentAuthorize(...args),
    assertDispatchReady: (...args: unknown[]) =>
      mockManualDispatchReady(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.production-authority', () => ({
  ReleaseBusV2ProductionAuthorityError:
    MockReleaseBusV2ProductionAuthorityError,
  isReleaseBusV2ProductionAuthorityError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'ReleaseBusV2ProductionAuthorityError',
  releaseBusV2ProductionAuthorityService: {
    prepare: (...args: unknown[]) => mockProductionAuthorityPrepare(...args),
    prepareAndBind: (...args: unknown[]) =>
      mockProductionAuthorityPrepareAndBind(...args),
    bind: (...args: unknown[]) => mockProductionAuthorityBind(...args),
    reauthorize: (...args: unknown[]) =>
      mockProductionAuthorityReauthorize(...args),
    complete: (...args: unknown[]) => mockProductionAuthorityComplete(...args),
    fail: (...args: unknown[]) => mockProductionAuthorityFail(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.reconciler', () => ({
  releaseBusV2Reconciler: {
    recoverUnsatisfiableProductionQualifications: (...args: unknown[]) =>
      mockRecoverUnsatisfiableProductionQualifications(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.candidate-deregistration', () => ({
  isReleaseBusV2CandidateDeregistrationError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'ReleaseBusV2CandidateDeregistrationError' &&
    ['BAD_REQUEST', 'CONFLICT', 'UNAVAILABLE'].includes(
      String((error as { code?: unknown }).code)
    ),
  releaseBusV2CandidateDeregistrationService: {
    prepare: (...args: unknown[]) =>
      mockCandidateDeregistrationPrepare(...args),
    execute: (...args: unknown[]) => mockCandidateDeregistrationExecute(...args)
  }
}));

jest.mock('@/releaseBusV2/release-bus-v2.baseline-adoption', () => ({
  isReleaseBusV2BaselineAdoptionError: (error: unknown) =>
    error instanceof Error &&
    error.name === 'ReleaseBusV2BaselineAdoptionError' &&
    ['BAD_REQUEST', 'CONFLICT', 'UNAVAILABLE'].includes(
      String((error as { code?: unknown }).code)
    ),
  releaseBusV2BaselineAdoptionService: {
    execute: (...args: unknown[]) => mockBaselineAdoptionExecute(...args),
    decideAutomaticE2E: (...args: unknown[]) =>
      mockBaselineAdoptionAutomaticDecision(...args),
    recordBackendDeployment: (...args: unknown[]) =>
      mockBaselineAdoptionBackendEvent(...args),
    handleE2EProgress: (...args: unknown[]) =>
      mockBaselineAdoptionHandleE2EProgress(...args)
  }
}));

import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'node:http';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import deployRoutes from '@/api/deploy/deploy.routes';

const WORKFLOW_TOKEN = 'release-bus-workflow-token';
const TRAIN_ID = '123e4567-e89b-42d3-a456-426614174000';
const RESET_ID = '123e4567-e89b-42d3-a456-426614174001';
const SHA = 'a'.repeat(40);
const BOUND_E2E_RUN_ID = '94000';
const AUTHORITY_BODY = {
  operation_id: 'frontend-prod-one-click-1',
  controller_identity: 'frontend-production-workflow',
  repository: 'frontend',
  environment: 'prod',
  service: 'frontend',
  target_sha: SHA,
  selection_digest: null
} as const;
const AUTHORITY_BIND_BODY = {
  ...AUTHORITY_BODY,
  workflow_run_id: '12345',
  workflow_run_attempt: 1
} as const;
const AUTHORITY_COMPLETE_BODY = {
  ...AUTHORITY_BIND_BODY,
  selection_digest: 'b'.repeat(64),
  qualifier_workflow_run_id: '54321',
  qualifier_workflow_run_attempt: 2,
  evidence_digest: 'c'.repeat(64)
} as const;
const AUTHORITY_FAILURE_BODY = {
  ...AUTHORITY_BIND_BODY,
  qualifier_workflow_run_id: AUTHORITY_BIND_BODY.workflow_run_id,
  qualifier_workflow_run_attempt: AUTHORITY_BIND_BODY.workflow_run_attempt,
  evidence_digest: 'c'.repeat(64),
  reason_code: 'WORKFLOW_FAILED'
} as const;

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

async function requestJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token?: string
) {
  return withServer(async (baseUrl) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: (await response.json()) as Record<string, unknown> & {
        error?: string;
      }
    };
  });
}

async function post(path: string, body: unknown) {
  return requestJson('POST', path, body, WORKFLOW_TOKEN);
}

async function get(path: string) {
  return requestJson('GET', path, undefined, WORKFLOW_TOKEN);
}

function expectNoReleaseMutation(): void {
  for (const mutation of [
    mockDispatchDeploy,
    mockV2Register,
    mockV2MarkReadyForProduction,
    mockV2MarkSelectionReadyForProduction,
    mockV2RevokeProductionReadiness,
    mockV2Cancel,
    mockV2RequestStagingTransition,
    mockV2SetPaused,
    mockV2AppendEvent,
    mockRecoverUnsatisfiableProductionQualifications,
    mockV2Authorize,
    mockV2ReportProgress,
    mockV2InvalidateBranch,
    mockCandidateDeregistrationPrepare,
    mockCandidateDeregistrationExecute,
    mockBaselineAdoptionExecute,
    mockBaselineAdoptionAutomaticDecision,
    mockBaselineAdoptionBackendEvent,
    mockBaselineAdoptionHandleE2EProgress,
    mockProductionAuthorityPrepare,
    mockProductionAuthorityPrepareAndBind,
    mockProductionAuthorityBind,
    mockProductionAuthorityReauthorize,
    mockProductionAuthorityComplete,
    mockProductionAuthorityFail,
    mockLambdaSend
  ]) {
    expect(mutation).not.toHaveBeenCalled();
  }
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
    production_selection_id: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 4
  } as const;
  const releaseMutationAttempts = [
    {
      name: 'manual deployment dispatch',
      path: '/deploy/ui/dispatch',
      body: {
        target: 'backend',
        ref: 'main',
        environment: 'prod',
        services: ['api']
      },
      unrelatedStatus: 403
    },
    {
      name: 'candidate registration',
      path: '/deploy/release-bus-v2/candidates',
      body: {
        repository: 'frontend',
        pr_number: 321,
        branch_name: 'agent/public-read-test',
        expected_head_sha: SHA,
        deploy_plan: null,
        dependencies: []
      },
      unrelatedStatus: 403
    },
    {
      name: 'production selection',
      path: '/deploy/release-bus-v2/production-selections',
      body: {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      },
      unrelatedStatus: 403
    },
    {
      name: 'production readiness',
      path: `/deploy/release-bus-v2/candidates/${candidateId}/mark-ready-for-production`,
      body: { expected_head_sha: SHA, expected_row_version: 4 },
      unrelatedStatus: 403
    },
    {
      name: 'production readiness revocation',
      path: `/deploy/release-bus-v2/candidates/${candidateId}/revoke-production-readiness`,
      body: { expected_row_version: 4 },
      unrelatedStatus: 403
    },
    {
      name: 'candidate cancellation',
      path: `/deploy/release-bus-v2/candidates/${candidateId}/cancel`,
      body: { expected_row_version: 4 },
      unrelatedStatus: 403
    },
    {
      name: 'staging transition',
      path: `/deploy/release-bus-v2/candidates/${candidateId}/staging-transition`,
      body: {
        expected_head_sha: SHA,
        expected_row_version: 4,
        transition: 'REMOVE',
        reason: 'Adversarial authorization test'
      },
      unrelatedStatus: 403
    },
    {
      name: 'global pause',
      path: '/deploy/release-bus-v2/pause',
      body: { scope: 'ALL', reason: 'Adversarial authorization test' },
      unrelatedStatus: 403
    },
    {
      name: 'global resume',
      path: '/deploy/release-bus-v2/resume',
      body: { scope: 'ALL', reason: 'Adversarial authorization test' },
      unrelatedStatus: 403
    },
    {
      name: 'manual reconciliation',
      path: '/deploy/release-bus-v2/reconcile',
      body: {},
      unrelatedStatus: 403
    },
    {
      name: 'stalled-qualification recovery',
      path: '/deploy/release-bus-v2/maintenance/recover-stalled-qualifications',
      body: {},
      unrelatedStatus: 403
    },
    {
      name: 'candidate inventory deregistration',
      path: '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      body: {
        phase: 'PREPARE',
        reason: 'Adversarial authorization test'
      },
      unrelatedStatus: 403
    },
    {
      name: 'exact staging baseline adoption',
      path: '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline',
      body: {
        idempotency_key: '8af60034-9741-4b9d-bb1c-80b483f75455',
        reason: 'Adversarial authorization test',
        expires_at: Date.now() + 30 * 60 * 1000,
        expected_staging_state_row_version: 23,
        expected_frontend_ref: '1a-staging',
        expected_frontend_sha: SHA,
        expected_frontend_runtime_sha: SHA,
        expected_backend_ref: '1a-staging',
        expected_backend_sha: 'b'.repeat(40),
        expected_backend_runtime_sha: 'b'.repeat(40),
        required_backend_units: [
          { service: 'api', expected_sha: 'b'.repeat(40) }
        ],
        candidates: []
      },
      unrelatedStatus: 403
    },
    {
      name: 'workflow authorization',
      path: '/deploy/release-bus-v2/authorize',
      body: {
        train_id: TRAIN_ID,
        operation_key: `rb2:${TRAIN_ID}:prepare:frontend:a1`,
        workflow_run_id: '12345',
        artifact_run_id: null,
        repository: 'frontend',
        environment: 'orchestration',
        service: null,
        expected_sha: SHA,
        artifact_digest: null
      },
      unrelatedStatus: 401
    },
    {
      name: 'manual workflow readiness',
      path: '/deploy/release-bus-v2/manual-deployment-readiness',
      body: {
        repository: 'backend',
        environment: 'staging',
        service: 'api',
        workflow_run_id: '12345',
        workflow_run_attempt: 1,
        source_ref: 'main',
        source_sha: SHA
      },
      unrelatedStatus: 401
    },
    {
      name: 'production authority prepare',
      path: '/deploy/release-bus-v2/production-authority/prepare',
      body: AUTHORITY_BODY,
      unrelatedStatus: 401
    },
    {
      name: 'production authority acquire-bind',
      path: '/deploy/release-bus-v2/production-authority/acquire-bind',
      body: AUTHORITY_BIND_BODY,
      unrelatedStatus: 401
    },
    {
      name: 'production authority bind',
      path: '/deploy/release-bus-v2/production-authority/bind',
      body: AUTHORITY_BIND_BODY,
      unrelatedStatus: 401
    },
    {
      name: 'production authority reauthorization',
      path: '/deploy/release-bus-v2/production-authority/reauthorize',
      body: AUTHORITY_COMPLETE_BODY,
      unrelatedStatus: 401
    },
    {
      name: 'production authority completion',
      path: '/deploy/release-bus-v2/production-authority/complete',
      body: AUTHORITY_COMPLETE_BODY,
      unrelatedStatus: 401
    },
    {
      name: 'production authority failure',
      path: '/deploy/release-bus-v2/production-authority/fail',
      body: { ...AUTHORITY_COMPLETE_BODY, reason_code: 'WORKFLOW_FAILED' },
      unrelatedStatus: 401
    },
    {
      name: 'workflow progress report',
      path: '/deploy/release-bus-v2/report-progress',
      body: {
        train_id: TRAIN_ID,
        operation_key: `rb2:${TRAIN_ID}:prepare:frontend:a1`,
        workflow_run_id: '12345',
        phase: 'prepare',
        status: 'RUNNING'
      },
      unrelatedStatus: 401
    },
    {
      name: 'GitHub webhook',
      path: '/deploy/github/webhook',
      body: {},
      unrelatedStatus: 401
    }
  ] as const;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN = WORKFLOW_TOKEN;
    mockGetViewer.mockResolvedValue({ login: 'developer' });
    mockAssertRepositoryWriteAccess.mockResolvedValue(undefined);
    mockDispatchDeploy.mockResolvedValue(undefined);
    mockV2FindCandidateById.mockResolvedValue(v2Candidate);
    mockV2MarkReadyForProduction.mockResolvedValue({
      ...v2Candidate,
      status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
      row_version: 5
    });
    mockV2MarkSelectionReadyForProduction.mockResolvedValue([
      {
        ...v2Candidate,
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        production_selection_id: RESET_ID,
        row_version: 5
      }
    ]);
    mockV2Cancel.mockResolvedValue({
      ...v2Candidate,
      status: 'CANCELLED',
      row_version: 5
    });
    mockV2RevokeProductionReadiness.mockResolvedValue({
      ...v2Candidate,
      status: 'STAGING_VALIDATED',
      row_version: 5
    });
    mockV2SetPaused.mockResolvedValue(undefined);
    mockV2InvalidateBranch.mockResolvedValue(undefined);
    mockV2Authorize.mockResolvedValue({ authorized: true, reused: false });
    mockV2ReportProgress.mockResolvedValue({ accepted: true });
    mockManualDeploymentAuthorize.mockImplementation(async (authorization) => ({
      ready: true,
      mode: 'manual',
      lane:
        (authorization as { environment: string }).environment === 'staging'
          ? 'STAGING'
          : 'PRODUCTION',
      ...(authorization as Record<string, unknown>)
    }));
    mockManualDispatchReady.mockResolvedValue(undefined);
    mockProductionAuthorityPrepare.mockResolvedValue({
      ...AUTHORITY_BODY,
      status: 'PREPARED',
      workflow_run_id: null,
      workflow_run_attempt: null,
      lease_expires_at: Date.now() + 300_000,
      hard_expires_at: Date.now() + 7_200_000,
      control_epoch: { all: 1, production: 1, mode: 'PRODUCTION' },
      lock_row_version: 2,
      prepared: true,
      authorized: false,
      reused: false
    });
    const boundAuthorityResponse = {
      ...AUTHORITY_BIND_BODY,
      status: 'BOUND',
      selection_digest: null,
      lease_expires_at: Date.now() + 1_800_000,
      hard_expires_at: Date.now() + 7_200_000,
      control_epoch: { all: 1, production: 1, mode: 'PRODUCTION' },
      lock_row_version: 3,
      bound: true,
      authorized: true,
      reused: false
    };
    mockProductionAuthorityPrepareAndBind.mockResolvedValue(
      boundAuthorityResponse
    );
    mockProductionAuthorityBind.mockResolvedValue(boundAuthorityResponse);
    mockProductionAuthorityReauthorize.mockResolvedValue({
      ...boundAuthorityResponse,
      ...AUTHORITY_COMPLETE_BODY,
      selection_digest: AUTHORITY_COMPLETE_BODY.selection_digest
    });
    mockProductionAuthorityComplete.mockResolvedValue({
      operation_id: AUTHORITY_COMPLETE_BODY.operation_id,
      status: 'COMPLETED',
      completed: true,
      reused: false,
      lock_row_version: 4
    });
    mockProductionAuthorityFail.mockResolvedValue({
      operation_id: AUTHORITY_COMPLETE_BODY.operation_id,
      status: 'FAILED',
      failed: true,
      reused: false,
      lock_row_version: 5
    });
    mockV2ListCandidates.mockResolvedValue([v2Candidate]);
    mockV2ListTrains.mockResolvedValue([]);
    mockV2ListManifests.mockResolvedValue([]);
    mockV2FindManifest.mockResolvedValue({
      id: RESET_ID,
      frontend_sha: SHA,
      backend_sha: 'b'.repeat(40)
    });
    mockV2ListControls.mockResolvedValue([
      { scope: 'ALL', paused: false, reason: null },
      { scope: 'STAGING', paused: false, reason: null },
      { scope: 'PRODUCTION', paused: false, reason: null }
    ]);
    mockV2ListLocks.mockResolvedValue([]);
    mockV2GetStagingState.mockResolvedValue({
      id: 'current',
      status: 'CLEAN_MAIN',
      current_manifest_id: null,
      last_validated_manifest_id: RESET_ID,
      frontend_sha: SHA,
      backend_sha: 'b'.repeat(40),
      frontend_staging_ref_sha: SHA,
      backend_staging_ref_sha: 'b'.repeat(40),
      clean_main: true,
      row_version: 1
    });
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
    mockV2RequestStagingTransition.mockResolvedValue({
      ...v2Candidate,
      staging_live_state: 'LIVE',
      staging_transition_request: 'REMOVE',
      row_version: 5
    });
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
    mockRepairCurrentStagingManifestCandidates.mockResolvedValue({
      manifest_id: RESET_ID,
      train_id: TRAIN_ID,
      dry_run: false,
      discovered: false,
      candidates: [
        {
          candidate_id: v2Candidate.id,
          repository: v2Candidate.repository,
          pr_number: v2Candidate.pr_number,
          head_sha: v2Candidate.head_sha,
          changed: true
        }
      ]
    });
    mockCandidateDeregistrationPrepare.mockResolvedValue({
      phase: 'PREPARE',
      plan_sha256: '1'.repeat(64),
      inventory_sha256: '2'.repeat(64),
      candidate_count: 1,
      candidates: [{ id: candidateId, row_version: 4 }],
      controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      staging_state_row_version: 9,
      staging_refs: {
        frontend: SHA,
        backend: 'b'.repeat(40)
      },
      mode: 'PRODUCTION',
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED'
    });
    mockCandidateDeregistrationExecute.mockResolvedValue({
      phase: 'EXECUTE',
      plan_sha256: '1'.repeat(64),
      inventory_sha256: '2'.repeat(64),
      candidate_count: 1,
      candidates: [{ id: candidateId, row_version: 4 }],
      controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      staging_state_row_version: 9,
      staging_refs: {
        frontend: SHA,
        backend: 'b'.repeat(40)
      },
      mode: 'PRODUCTION',
      executed: true,
      deregistration_id: RESET_ID,
      physical_staging_presence: 'UNKNOWN_DETACHED'
    });
    mockBaselineAdoptionExecute.mockResolvedValue({
      adoption_id: TRAIN_ID,
      manifest_id: RESET_ID,
      manifest_identity_sha256: 'd'.repeat(64),
      operation_key: `rb2:${TRAIN_ID}:baseline-adoption-e2e:staging:a1`,
      operation_id: candidateId,
      workflow_run_id: null,
      status: 'E2E_RUNNING',
      reused: false
    });
    mockBaselineAdoptionAutomaticDecision.mockResolvedValue({
      decision: 'DEFERRED',
      adoption_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:baseline-adoption-e2e:staging:a1`,
      expires_at: Date.now() + 30 * 60 * 1000,
      manifest_ready: false
    });
    mockBaselineAdoptionBackendEvent.mockResolvedValue({
      outcome: 'RECORDED',
      adoption_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:baseline-adoption-e2e:staging:a1`
    });
    mockBaselineAdoptionHandleE2EProgress.mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.RELEASE_BUS_V2_MODE;
    delete process.env.RELEASE_BUS_V2_BETA_ALLOWLIST;
    delete process.env.RELEASE_BUS_WORKFLOW_AUTH_TOKEN;
  });

  it('does not expose any unversioned v1 route', async () => {
    await withServer(async (baseUrl) => {
      for (const [method, path] of [
        ['POST', '/deploy/release-candidates/ready'],
        ['POST', `/deploy/release-candidates/${RESET_ID}/cancel`],
        ['GET', '/deploy/release-candidates'],
        ['GET', '/deploy/release-trains'],
        ['GET', `/deploy/release-trains/${TRAIN_ID}`],
        ['GET', '/deploy/release-bus/controls'],
        ['POST', '/deploy/release-bus/pause'],
        ['POST', '/deploy/release-bus/resume'],
        ['POST', '/deploy/release-bus/reset-experimental-history'],
        ['POST', '/deploy/release-bus/authorize'],
        ['POST', '/deploy/release-bus/report-progress'],
        ['POST', '/deploy/release-bus/authorize-break-glass']
      ]) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${WORKFLOW_TOKEN}`,
            'content-type': 'application/json'
          },
          body: method === 'POST' ? '{}' : undefined
        });
        expect(response.status).toBe(404);
      }
    });
  });

  it.each([
    ['/deploy/release-bus-v2/candidates', 'candidates'],
    ['/deploy/release-bus-v2/trains', 'trains'],
    [`/deploy/release-bus-v2/trains/${TRAIN_ID}`, 'train'],
    ['/deploy/release-bus-v2/manifests', 'manifests'],
    ['/deploy/release-bus-v2/controls', 'controls']
  ] as const)(
    'serves public no-store read-only state from %s',
    async (path, responseKey) => {
      mockV2FindTrain.mockResolvedValue({
        id: TRAIN_ID,
        status: 'STAGING_VALIDATED'
      });

      const response = await requestJson('GET', path);

      expect(response.status).toBe(200);
      expect(response.cacheControl).toContain('no-store');
      expect(response.body).toHaveProperty(responseKey);
      if (responseKey === 'controls') {
        expect(response.body.staging_state).toEqual(
          expect.objectContaining({
            status: 'CLEAN_MAIN',
            last_validated_frontend_sha: SHA,
            last_validated_backend_sha: 'b'.repeat(40),
            row_version: 1
          })
        );
        expect(mockV2FindManifest).toHaveBeenCalledWith(RESET_ID, {});
        expect(response.body.lanes).toEqual([
          {
            lane: 'STAGING',
            status: 'ON',
            changeable: true,
            reason: null
          },
          {
            lane: 'PRODUCTION',
            status: 'ON',
            changeable: true,
            reason: null
          }
        ]);
      }
      expect(mockGetViewer).not.toHaveBeenCalled();
      expectNoReleaseMutation();
    }
  );

  it('returns deterministic committed-state evidence when post-commit verification fails', async () => {
    mockCandidateDeregistrationExecute.mockRejectedValue(
      new MockReleaseBusV2CandidateDeregistrationError(
        'UNAVAILABLE',
        `Candidate inventory was committed as safely detached (deregistration_id=${RESET_ID}), but maintenance lock cleanup failed`,
        true,
        RESET_ID,
        'UNKNOWN_DETACHED'
      )
    );

    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        expected_plan_sha256: '1'.repeat(64),
        expected_inventory_sha256: '2'.repeat(64),
        expected_candidates: [{ id: candidateId, row_version: 4 }],
        expected_controls: [
          { scope: 'ALL', paused: false, row_version: 1 },
          { scope: 'PRODUCTION', paused: true, row_version: 2 },
          { scope: 'STAGING', paused: true, row_version: 3 }
        ],
        expected_locks: [
          { name: 'production-environment', row_version: 1 },
          { name: 'scheduler', row_version: 2 },
          { name: 'staging-environment', row_version: 3 }
        ],
        expected_staging_state_row_version: 9,
        expected_staging_refs: {
          frontend: SHA,
          backend: 'b'.repeat(40)
        }
      }
    );

    expect(response.status).toBe(503);
    expect(response.cacheControl).toContain('no-store');
    expect(response.body).toEqual({
      outcome: 'COMMITTED',
      error: expect.stringContaining(`deregistration_id=${RESET_ID}`),
      committed: true,
      deregistration_id: RESET_ID,
      physical_staging_presence: 'UNKNOWN_DETACHED'
    });
  });

  it.each(releaseMutationAttempts)(
    'rejects anonymous $name without executing a mutation',
    async ({ path, body }) => {
      const response = await requestJson('POST', path, body);

      expect(response.status).toBe(401);
      expectNoReleaseMutation();
    }
  );

  it.each(releaseMutationAttempts)(
    'rejects unrelated authenticated GitHub user for $name',
    async ({ path, body, unrelatedStatus }) => {
      mockGetViewer.mockResolvedValue({ login: 'unrelated-user' });
      mockIsOrganizationOperator.mockResolvedValue(false);
      mockAssertRepositoryWriteAccess.mockRejectedValue(
        new CustomApiCompliantException(
          403,
          'Repository write permission is required'
        )
      );

      const response = await requestJson(
        'POST',
        path,
        body,
        'unrelated-github-token'
      );

      expect(response.status).toBe(unrelatedStatus);
      expectNoReleaseMutation();
    }
  );

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

  it('records an explicit audited staging lifecycle transition', async () => {
    const response = await post(
      `/deploy/release-bus-v2/candidates/${candidateId}/staging-transition`,
      {
        expected_head_sha: SHA,
        expected_row_version: 4,
        transition: 'REMOVE',
        reason: 'Operator retirement'
      }
    );

    expect(response.status).toBe(202);
    expect(mockV2RequestStagingTransition).toHaveBeenCalledWith({
      candidateId,
      expectedHeadSha: SHA,
      expectedRowVersion: 4,
      transition: 'REMOVE',
      reason: 'Operator retirement',
      actor: 'developer'
    });
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  it('keeps an accepted transition successful when the best-effort reconciler wake-up fails', async () => {
    mockLambdaSend.mockRejectedValueOnce(
      new Error('temporary Lambda invoke failure')
    );

    const response = await post(
      `/deploy/release-bus-v2/candidates/${candidateId}/staging-transition`,
      {
        expected_head_sha: SHA,
        expected_row_version: 4,
        transition: 'REMOVE',
        reason: 'Operator retirement'
      }
    );

    expect(response.status).toBe(202);
    expect(mockV2AppendEvent).toHaveBeenCalledWith(
      {
        candidateId,
        eventType: 'STAGING_TRANSITION_RECONCILER_WAKEUP_FAILED',
        actor: 'developer',
        payload: { scheduled_reconciliation_will_retry: true }
      },
      {}
    );
  });

  it('does not expose an unexpected staging-transition repository failure', async () => {
    mockV2RequestStagingTransition.mockRejectedValueOnce(
      new Error('mysql connection secret detail')
    );

    const response = await post(
      `/deploy/release-bus-v2/candidates/${candidateId}/staging-transition`,
      {
        expected_head_sha: SHA,
        expected_row_version: 4,
        transition: 'REMOVE',
        reason: 'Operator retirement'
      }
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).toContain(
      'Release Bus v2 staging transition failed'
    );
    expect(JSON.stringify(response.body)).not.toContain(
      'mysql connection secret detail'
    );
  });

  it('records an explicit atomic candidate-evidence production selection', async () => {
    const response = await post(
      '/deploy/release-bus-v2/production-selections',
      {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        production_selection_id: RESET_ID,
        qualification_policy: 'CANDIDATE_STAGING_EVIDENCE_V1'
      })
    );
    expect(mockV2MarkSelectionReadyForProduction).toHaveBeenCalledWith(
      [
        {
          candidateId,
          expectedHeadSha: SHA,
          expectedRowVersion: 4
        }
      ],
      'developer'
    );
  });

  it('canonicalizes one non-empty actor across an atomic production selection', async () => {
    const secondCandidateId = '123e4567-e89b-42d3-a456-426614174098';
    mockGetViewer.mockResolvedValue({ login: 'DeVeLoPeR' });
    mockV2MarkSelectionReadyForProduction.mockResolvedValue([
      {
        ...v2Candidate,
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        production_selection_id: RESET_ID,
        row_version: 5
      },
      {
        ...v2Candidate,
        id: secondCandidateId,
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        production_selection_id: RESET_ID,
        row_version: 5
      }
    ]);

    const response = await post(
      '/deploy/release-bus-v2/production-selections',
      {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          },
          {
            candidate_id: secondCandidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(mockV2MarkSelectionReadyForProduction).toHaveBeenCalledWith(
      expect.any(Array),
      'developer'
    );
  });

  it('rejects an empty production-selection actor before mutation', async () => {
    mockGetViewer.mockResolvedValue({ login: '   ' });

    const response = await post(
      '/deploy/release-bus-v2/production-selections',
      {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      }
    );

    expect(response.status).toBe(403);
    expect(mockV2MarkSelectionReadyForProduction).not.toHaveBeenCalled();
  });

  it.each([
    ['DISABLED', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409]
  ] as const)(
    'maps the %s production-selection service result to HTTP %i',
    async (code, expectedStatus) => {
      mockV2MarkSelectionReadyForProduction.mockRejectedValueOnce(
        new MockReleaseBusV2ProductionSelectionError(
          code,
          'Selection rejected safely'
        )
      );

      const response = await post(
        '/deploy/release-bus-v2/production-selections',
        {
          candidates: [
            {
              candidate_id: candidateId,
              expected_head_sha: SHA,
              expected_row_version: 4
            }
          ]
        }
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.body).toEqual({ error: 'Selection rejected safely' });
    }
  );

  it('does not expose an unexpected production-selection failure', async () => {
    mockV2MarkSelectionReadyForProduction.mockRejectedValueOnce(
      new Error('database credential detail')
    );

    const response = await post(
      '/deploy/release-bus-v2/production-selections',
      {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      }
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Release Bus v2 production selection failed'
    });
  });

  it('fails closed on inconsistent returned production selection identities', async () => {
    mockV2MarkSelectionReadyForProduction.mockResolvedValue([
      {
        ...v2Candidate,
        production_selection_id: RESET_ID
      },
      {
        ...v2Candidate,
        id: '123e4567-e89b-42d3-a456-426614174099',
        production_selection_id: '123e4567-e89b-42d3-a456-426614174098'
      }
    ]);

    const response = await post(
      '/deploy/release-bus-v2/production-selections',
      {
        candidates: [
          {
            candidate_id: candidateId,
            expected_head_sha: SHA,
            expected_row_version: 4
          }
        ]
      }
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Release Bus v2 production selection failed'
    });
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
    expect(mockV2Authorize).toHaveBeenCalledWith({
      ...body,
      source_ref: null,
      candidate_evidence_mode: null,
      aggregate_candidate_evidence_digest: null,
      reuse_artifact_run_id: null,
      reuse_artifact_name: null,
      reuse_artifact_digest: null
    });
    expect(response.body).toMatchObject({
      authorized: true,
      train_id: TRAIN_ID,
      operation_key: body.operation_key
    });
    expect(mockManualDeploymentAuthorize).not.toHaveBeenCalled();
  });

  it('accepts an exact artifact-free leased staging-ref authorization payload', async () => {
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:advance-staging:release:backend:a1`,
      workflow_run_id: '30510086016',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'staging',
      service: null,
      expected_sha: SHA,
      artifact_digest: null
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(200);
    expect(mockV2Authorize).toHaveBeenCalledWith({
      ...body,
      source_ref: null,
      candidate_evidence_mode: null,
      aggregate_candidate_evidence_digest: null,
      reuse_artifact_run_id: null,
      reuse_artifact_name: null,
      reuse_artifact_digest: null
    });
  });

  it('accepts only a complete strict aggregate for an orchestration authorization', async () => {
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:backend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      source_ref: 'release-bus-v2/train-id/backend',
      candidate_evidence_mode: 'strict-aggregate',
      aggregate_candidate_evidence_digest: 'b'.repeat(64)
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(200);
    expect(mockV2Authorize).toHaveBeenCalledWith({
      ...body,
      reuse_artifact_run_id: null,
      reuse_artifact_name: null,
      reuse_artifact_digest: null
    });
  });

  it('allows only the exact adoption operation callback to finish while normal OFF automation stays disabled', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    mockV2IsBetaTrainAllowed.mockResolvedValue(false);
    mockV2FindTrain.mockResolvedValue({
      id: TRAIN_ID,
      staging_policy: 'ADOPT_EXACT_DEPLOYED_BASELINE_V1'
    });
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:baseline-adoption-e2e:staging:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'staging',
      service: null,
      expected_sha: SHA,
      artifact_digest: 'd'.repeat(64)
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(200);
    expect(mockV2Authorize).toHaveBeenCalledWith(expect.objectContaining(body));
    expect(mockV2IsBetaTrainAllowed).not.toHaveBeenCalled();
  });

  it('advances baseline adoption only after the exact bound progress callback is persisted', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    mockV2FindTrain.mockResolvedValue({
      id: TRAIN_ID,
      staging_policy: 'ADOPT_EXACT_DEPLOYED_BASELINE_V1'
    });
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:baseline-adoption-e2e:staging:a1`,
      workflow_run_id: BOUND_E2E_RUN_ID,
      phase: 'staging-e2e',
      status: 'SUCCEEDED'
    };

    const response = await post('/deploy/release-bus-v2/report-progress', body);

    expect(response.status).toBe(200);
    expect(mockV2ReportProgress).toHaveBeenCalledWith(
      expect.objectContaining(body)
    );
    expect(mockBaselineAdoptionHandleE2EProgress).toHaveBeenCalledWith(
      TRAIN_ID
    );
    expect(mockV2ReportProgress.mock.invocationCallOrder[0]).toBeLessThan(
      mockBaselineAdoptionHandleE2EProgress.mock.invocationCallOrder[0]
    );
  });

  it('does not invoke adoption handling for an ordinary OFF-mode train progress callback', async () => {
    process.env.RELEASE_BUS_V2_MODE = 'OFF';
    mockV2IsBetaTrainAllowed.mockResolvedValue(true);
    mockV2FindTrain.mockResolvedValue({
      id: TRAIN_ID,
      staging_policy: 'CUMULATIVE'
    });
    mockBaselineAdoptionHandleE2EProgress.mockRejectedValue(
      new Error('adoption subsystem unavailable')
    );
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:e2e:staging:a1`,
      workflow_run_id: BOUND_E2E_RUN_ID,
      phase: 'staging-e2e',
      status: 'SUCCEEDED'
    };

    const response = await post('/deploy/release-bus-v2/report-progress', body);

    expect(response.status).toBe(200);
    expect(mockV2ReportProgress).toHaveBeenCalledWith(
      expect.objectContaining(body)
    );
    expect(mockBaselineAdoptionHandleE2EProgress).not.toHaveBeenCalled();
  });

  it('accepts only a complete strict-single evidence identity for orchestration', async () => {
    const body = {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:backend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      source_ref: 'release-bus-v2/staging-train-train-id-backend',
      candidate_evidence_mode: 'strict-single',
      aggregate_candidate_evidence_digest: null,
      reuse_artifact_run_id: '54321',
      reuse_artifact_name: `release-bus-v2-pr-${SHA}`,
      reuse_artifact_digest: 'c'.repeat(64)
    };

    const response = await post('/deploy/release-bus-v2/authorize', body);

    expect(response.status).toBe(200);
    expect(mockV2Authorize).toHaveBeenCalledWith(body);
  });

  it('rejects a partial strict-single evidence identity before operation lookup', async () => {
    const response = await post('/deploy/release-bus-v2/authorize', {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:backend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      source_ref: 'release-bus-v2/staging-train-train-id-backend',
      candidate_evidence_mode: 'strict-single',
      aggregate_candidate_evidence_digest: null,
      reuse_artifact_run_id: '54321',
      reuse_artifact_name: `release-bus-v2-pr-${SHA}`
    });

    expect(response.status).toBe(400);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('rejects an incomplete strict aggregate before operation lookup', async () => {
    const response = await post('/deploy/release-bus-v2/authorize', {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:backend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      source_ref: 'release-bus-v2/train-id/backend',
      candidate_evidence_mode: 'strict-aggregate'
    });

    expect(response.status).toBe(400);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('rejects a strict orchestration authorization without an exact source ref', async () => {
    const response = await post('/deploy/release-bus-v2/authorize', {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:prepare:backend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'orchestration',
      service: null,
      expected_sha: SHA,
      artifact_digest: null,
      candidate_evidence_mode: 'strict-aggregate',
      aggregate_candidate_evidence_digest: 'b'.repeat(64)
    });

    expect(response.status).toBe(400);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('rejects candidate evidence fields on a deployment authorization', async () => {
    const response = await post('/deploy/release-bus-v2/authorize', {
      train_id: TRAIN_ID,
      operation_key: `rb2:${TRAIN_ID}:deploy:staging:backend:api:a1`,
      workflow_run_id: '12345',
      artifact_run_id: '54321',
      repository: 'backend',
      environment: 'staging',
      service: 'api',
      expected_sha: SHA,
      artifact_digest: 'c'.repeat(64),
      candidate_evidence_mode: 'strict-single',
      aggregate_candidate_evidence_digest: null
    });

    expect(response.status).toBe(400);
    expect(mockV2Authorize).not.toHaveBeenCalled();
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

  it('starts an operator-authenticated exact staging baseline adoption', async () => {
    const body = {
      idempotency_key: '8af60034-9741-4b9d-bb1c-80b483f75455',
      reason: 'Adopt the exact deployed staging pair',
      expires_at: Date.now() + 30 * 60 * 1000,
      expected_staging_state_row_version: 23,
      expected_frontend_ref: '1a-staging',
      expected_frontend_sha: SHA,
      expected_frontend_runtime_sha: SHA,
      expected_backend_ref: '1a-staging',
      expected_backend_sha: 'b'.repeat(40),
      expected_backend_runtime_sha: 'b'.repeat(40),
      required_backend_units: [
        { service: 'api', expected_sha: 'b'.repeat(40) }
      ],
      candidates: [
        {
          candidate_id: candidateId,
          repository: 'frontend',
          pr_number: 321,
          head_sha: SHA,
          row_version: 4
        }
      ]
    };
    const response = await post(
      '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline',
      body
    );

    expect(response.status).toBe(200);
    expect(response.cacheControl).toContain('no-store');
    expect(mockBaselineAdoptionExecute).toHaveBeenCalledWith(body, 'developer');
    expect(response.body).toMatchObject({
      adoption_id: TRAIN_ID,
      manifest_id: RESET_ID,
      status: 'E2E_RUNNING',
      reused: false
    });
  });

  it('authenticates the automatic frontend decision and exact backend deployment event with the workflow credential', async () => {
    const automatic = {
      e2e_workflow_run_id: '91000',
      deploy_workflow_run_id: '92000',
      deployed_ref: '1a-staging',
      deployed_sha: SHA
    };
    const automaticResponse = await post(
      '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline/automatic-e2e-decision',
      automatic
    );
    expect(automaticResponse.status).toBe(200);
    expect(mockBaselineAdoptionAutomaticDecision).toHaveBeenCalledWith(
      automatic
    );
    expect(automaticResponse.body).toMatchObject({
      decision: 'DEFERRED',
      manifest_ready: false
    });

    const backend = {
      environment: 'staging',
      service: 'api',
      workflow_run_id: '93000',
      workflow_run_attempt: 1,
      source_ref: '1a-staging',
      source_sha: 'b'.repeat(40),
      status: 'SUCCEEDED'
    };
    const backendResponse = await post(
      '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline/backend-deployment-event',
      backend
    );
    expect(backendResponse.status).toBe(200);
    expect(mockBaselineAdoptionBackendEvent).toHaveBeenCalledWith(backend);
    expect(backendResponse.body).toMatchObject({ outcome: 'RECORDED' });

    for (const [path, body] of [
      [
        '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline/automatic-e2e-decision',
        automatic
      ],
      [
        '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline/backend-deployment-event',
        backend
      ]
    ] as const) {
      const unauthorized = await requestJson('POST', path, body);
      expect(unauthorized.status).toBe(401);
    }
  });

  it.each([
    ['BAD_REQUEST', 400],
    ['CONFLICT', 409],
    ['UNAVAILABLE', 503]
  ] as const)(
    'maps baseline adoption %s failures without exposing an untyped mutation',
    async (code, expectedStatus) => {
      mockBaselineAdoptionExecute.mockRejectedValue(
        new MockReleaseBusV2BaselineAdoptionError(
          code,
          'Exact adoption safety fence failed'
        )
      );
      const response = await post(
        '/deploy/release-bus-v2/maintenance/adopt-exact-staging-baseline',
        {
          idempotency_key: '8af60034-9741-4b9d-bb1c-80b483f75455',
          reason: 'Adopt the exact deployed staging pair',
          expires_at: Date.now() + 30 * 60 * 1000,
          expected_staging_state_row_version: 23,
          expected_frontend_ref: '1a-staging',
          expected_frontend_sha: SHA,
          expected_frontend_runtime_sha: SHA,
          expected_backend_ref: '1a-staging',
          expected_backend_sha: 'b'.repeat(40),
          expected_backend_runtime_sha: 'b'.repeat(40),
          required_backend_units: [
            { service: 'api', expected_sha: 'b'.repeat(40) }
          ],
          candidates: []
        }
      );
      expect(response.status).toBe(expectedStatus);
      expect(response.body).toMatchObject({
        error: 'Exact adoption safety fence failed'
      });
    }
  );

  it('prepares a read-only exact candidate deregistration inventory for an operator', async () => {
    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'PREPARE',
        reason: 'Retire the audited candidate inventory'
      }
    );

    expect(response.status).toBe(200);
    expect(response.cacheControl).toContain('no-store');
    expect(mockCandidateDeregistrationPrepare).toHaveBeenCalledWith(
      'Retire the audited candidate inventory'
    );
    expect(mockCandidateDeregistrationExecute).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      phase: 'PREPARE',
      candidate_count: 1,
      mode: 'PRODUCTION',
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED',
      requested_by: 'developer'
    });
  });

  it('returns an explicit successful zero-target exact preparation', async () => {
    mockCandidateDeregistrationPrepare.mockResolvedValue({
      phase: 'PREPARE',
      plan_sha256: '1'.repeat(64),
      inventory_sha256: '2'.repeat(64),
      candidate_count: 0,
      candidates: [],
      controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      staging_state_row_version: 9,
      staging_refs: {
        frontend: SHA,
        backend: 'b'.repeat(40)
      },
      mode: 'PRODUCTION',
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED'
    });

    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'PREPARE',
        reason: 'Confirm no active candidate intent'
      }
    );

    expect(response.status).toBe(200);
    expect(response.cacheControl).toContain('no-store');
    expect(response.body).toMatchObject({
      phase: 'PREPARE',
      candidate_count: 0,
      candidates: [],
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED',
      requested_by: 'developer'
    });
    expect(mockCandidateDeregistrationExecute).not.toHaveBeenCalled();
  });

  it('executes a complete strict zero-target control/lock/state/ref CAS plan', async () => {
    const expected = {
      expected_plan_sha256: '1'.repeat(64),
      expected_inventory_sha256: '2'.repeat(64),
      expected_candidates: [],
      expected_controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      expected_locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      expected_staging_state_row_version: 9,
      expected_staging_refs: {
        frontend: SHA,
        backend: 'b'.repeat(40)
      }
    };
    mockCandidateDeregistrationExecute.mockResolvedValue({
      phase: 'EXECUTE',
      plan_sha256: expected.expected_plan_sha256,
      inventory_sha256: expected.expected_inventory_sha256,
      candidate_count: 0,
      candidates: [],
      controls: expected.expected_controls,
      locks: expected.expected_locks,
      staging_state_row_version: expected.expected_staging_state_row_version,
      staging_refs: expected.expected_staging_refs,
      mode: 'PRODUCTION',
      executed: true,
      deregistration_id: RESET_ID,
      physical_staging_presence: 'UNKNOWN_DETACHED'
    });

    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'EXECUTE',
        reason: 'Detach the exact empty candidate inventory',
        ...expected
      }
    );

    expect(response.status).toBe(200);
    expect(mockCandidateDeregistrationExecute).toHaveBeenCalledWith(
      {
        reason: 'Detach the exact empty candidate inventory',
        ...expected
      },
      'developer'
    );
    expect(response.body).toMatchObject({
      phase: 'EXECUTE',
      candidate_count: 0,
      candidates: [],
      executed: true,
      deregistration_id: RESET_ID,
      physical_staging_presence: 'UNKNOWN_DETACHED',
      requested_by: 'developer'
    });
  });

  it('executes only a complete strict candidate/control/lock/state/ref CAS plan', async () => {
    const expected = {
      expected_plan_sha256: '1'.repeat(64),
      expected_inventory_sha256: '2'.repeat(64),
      expected_candidates: [{ id: candidateId, row_version: 4 }],
      expected_controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      expected_locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      expected_staging_state_row_version: 9,
      expected_staging_refs: {
        frontend: SHA,
        backend: 'b'.repeat(40)
      }
    };
    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...expected
      }
    );

    expect(response.status).toBe(200);
    expect(mockCandidateDeregistrationExecute).toHaveBeenCalledWith(
      {
        reason: 'Retire the audited candidate inventory',
        ...expected
      },
      'developer'
    );
    expect(response.body).toMatchObject({
      phase: 'EXECUTE',
      executed: true,
      deregistration_id: RESET_ID,
      physical_staging_presence: 'UNKNOWN_DETACHED',
      requested_by: 'developer'
    });
  });

  it('rejects incomplete execute input before invoking deregistration', async () => {
    const response = await post(
      '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        expected_plan_sha256: '1'.repeat(64)
      }
    );

    expect(response.status).toBe(400);
    expect(mockCandidateDeregistrationPrepare).not.toHaveBeenCalled();
    expect(mockCandidateDeregistrationExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['BAD_REQUEST', 400],
    ['CONFLICT', 409],
    ['UNAVAILABLE', 503]
  ] as const)(
    'maps candidate deregistration %s failures without another mutation',
    async (code, status) => {
      mockCandidateDeregistrationPrepare.mockRejectedValue(
        new MockReleaseBusV2CandidateDeregistrationError(
          code,
          'Candidate deregistration remains blocked'
        )
      );

      const response = await post(
        '/deploy/release-bus-v2/maintenance/deregister-all-candidates',
        {
          phase: 'PREPARE',
          reason: 'Retire the audited candidate inventory'
        }
      );

      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        outcome: 'NOT_COMMITTED',
        error: 'Candidate deregistration remains blocked',
        committed: false,
        physical_staging_presence: 'UNKNOWN_UNCHANGED'
      });
      expect(response.cacheControl).toContain('no-store');
      expect(mockCandidateDeregistrationExecute).not.toHaveBeenCalled();
    }
  );

  it('repairs only exact identities derived from the current staging manifest', async () => {
    const body = {
      candidates: [
        {
          repository: 'frontend',
          pr_number: v2Candidate.pr_number,
          head_sha: v2Candidate.head_sha
        }
      ]
    };

    const response = await post(
      '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
      body
    );

    expect(response.status).toBe(200);
    expect(mockRepairCurrentStagingManifestCandidates).toHaveBeenCalledWith(
      body.candidates,
      'developer',
      false
    );
    expect(response.body).toMatchObject({
      mode: 'PRODUCTION',
      repaired_by: 'developer',
      manifest_id: RESET_ID,
      train_id: TRAIN_ID
    });
  });

  it('discovers exact current-manifest mismatches in dry-run mode without a supplied candidate list', async () => {
    mockRepairCurrentStagingManifestCandidates.mockResolvedValue({
      manifest_id: RESET_ID,
      train_id: TRAIN_ID,
      dry_run: true,
      discovered: true,
      candidates: [
        {
          candidate_id: v2Candidate.id,
          repository: v2Candidate.repository,
          pr_number: v2Candidate.pr_number,
          head_sha: v2Candidate.head_sha,
          previous_status: 'SUPERSEDED',
          would_change: true,
          changed: false
        }
      ]
    });

    const response = await post(
      '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
      { dry_run: true }
    );

    expect(response.status).toBe(200);
    expect(mockRepairCurrentStagingManifestCandidates).toHaveBeenCalledWith(
      null,
      'developer',
      true
    );
    expect(response.body).toMatchObject({
      dry_run: true,
      discovered: true,
      candidates: [
        {
          repository: 'frontend',
          pr_number: v2Candidate.pr_number,
          head_sha: v2Candidate.head_sha,
          changed: false
        }
      ]
    });
  });

  it('rejects duplicate exact identities before current staging repair', async () => {
    const identity = {
      repository: 'frontend',
      pr_number: v2Candidate.pr_number,
      head_sha: v2Candidate.head_sha
    };

    const response = await post(
      '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
      { candidates: [identity, identity] }
    );

    expect(response.status).toBe(400);
    expect(mockRepairCurrentStagingManifestCandidates).not.toHaveBeenCalled();
  });

  it('rejects repair execution without an explicit exact candidate list', async () => {
    const response = await post(
      '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
      {}
    );

    expect(response.status).toBe(400);
    expect(mockRepairCurrentStagingManifestCandidates).not.toHaveBeenCalled();
  });

  it('requires operator authorization before current staging repair', async () => {
    mockIsOrganizationOperator.mockResolvedValue(false);

    const response = await post(
      '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
      { dry_run: true }
    );

    expect(response.status).toBe(403);
    expect(mockRepairCurrentStagingManifestCandidates).not.toHaveBeenCalled();
  });

  it.each([
    ['BAD_REQUEST', 400],
    ['CONFLICT', 409],
    ['DISABLED', 403],
    ['NOT_FOUND', 404],
    ['UNPROCESSABLE', 422]
  ] as const)(
    'maps current staging repair %s failures to %i',
    async (code, status) => {
      mockRepairCurrentStagingManifestCandidates.mockRejectedValue(
        new MockReleaseBusV2CurrentStagingRepairError(
          code,
          `repair ${code.toLowerCase()}`
        )
      );

      const response = await post(
        '/deploy/release-bus-v2/maintenance/repair-current-staging-candidates',
        { dry_run: true }
      );

      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({
        error: `repair ${code.toLowerCase()}`
      });
    }
  );

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

  it('returns exact manual readiness evidence without using operation authorization', async () => {
    const body = {
      repository: 'backend',
      environment: 'staging',
      service: 'api',
      workflow_run_id: '12345',
      workflow_run_attempt: 2,
      source_ref: 'main',
      source_sha: SHA
    };

    const response = await post(
      '/deploy/release-bus-v2/manual-deployment-readiness',
      body
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ready: true,
      mode: 'manual',
      lane: 'STAGING',
      ...body
    });
    expect(mockManualDeploymentAuthorize).toHaveBeenCalledWith(body);
    expect(mockV2Authorize).not.toHaveBeenCalled();
  });

  it('keeps selection absent at prepare and delegates the atomic acquire-bind path', async () => {
    const prepareResponse = await post(
      '/deploy/release-bus-v2/production-authority/prepare',
      AUTHORITY_BODY
    );
    expect(prepareResponse.status).toBe(200);
    expect(mockProductionAuthorityPrepare).toHaveBeenCalledWith(AUTHORITY_BODY);
    expect(prepareResponse.body).not.toHaveProperty('lease_token');

    const acquireResponse = await post(
      '/deploy/release-bus-v2/production-authority/acquire-bind',
      AUTHORITY_BIND_BODY
    );
    expect(acquireResponse.status).toBe(200);
    expect(mockProductionAuthorityPrepareAndBind).toHaveBeenCalledWith(
      AUTHORITY_BIND_BODY
    );
    expect(acquireResponse.body).not.toHaveProperty('lease_token');
  });

  it('requires selected and isolated evidence for completion', async () => {
    const response = await post(
      '/deploy/release-bus-v2/production-authority/complete',
      AUTHORITY_BIND_BODY
    );

    expect(response.status).toBe(400);
    expect(mockProductionAuthorityComplete).not.toHaveBeenCalled();
  });

  it('passes the immutable selection and E2E evidence identity to completion', async () => {
    const response = await post(
      '/deploy/release-bus-v2/production-authority/complete',
      AUTHORITY_COMPLETE_BODY
    );

    expect(response.status).toBe(200);
    expect(mockProductionAuthorityComplete).toHaveBeenCalledWith(
      AUTHORITY_COMPLETE_BODY
    );
    expect(response.body).not.toHaveProperty('lease_token');
  });

  it('allows a preselection failure to release without inventing a selection digest', async () => {
    const response = await post(
      '/deploy/release-bus-v2/production-authority/fail',
      AUTHORITY_FAILURE_BODY
    );

    expect(response.status).toBe(200);
    expect(mockProductionAuthorityFail).toHaveBeenCalledWith(
      AUTHORITY_FAILURE_BODY
    );
  });

  it('returns an unavailable authority as a 503 machine-readable denial', async () => {
    mockProductionAuthorityPrepare.mockRejectedValue(
      new MockReleaseBusV2ProductionAuthorityError(
        'UNAVAILABLE',
        'The authority store is unavailable',
        'AUTHORITY_UNAVAILABLE'
      )
    );
    const response = await post(
      '/deploy/release-bus-v2/production-authority/prepare',
      AUTHORITY_BODY
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      authorized: false,
      operation_id: AUTHORITY_BODY.operation_id,
      reason_code: 'AUTHORITY_UNAVAILABLE'
    });
  });

  it('returns the full persisted denial record with HTTP 409', async () => {
    const denied = {
      ...AUTHORITY_BODY,
      status: 'DENIED',
      workflow_run_id: null,
      workflow_run_attempt: null,
      selection_digest: null,
      lease_expires_at: null,
      hard_expires_at: null,
      control_epoch: { all: 4, production: 7, mode: 'PRODUCTION' },
      lock_row_version: 8,
      prepared: false,
      authorized: false,
      reused: false,
      reason_code: 'ACTIVE_TRAIN',
      observed_epoch: { all: 4, production: 7, mode: 'PRODUCTION' }
    };
    mockProductionAuthorityPrepare.mockResolvedValue(denied);

    const response = await post(
      '/deploy/release-bus-v2/production-authority/prepare',
      AUTHORITY_BODY
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual(denied);
  });

  it('returns persisted machine-readable authority denials', async () => {
    mockProductionAuthorityPrepare.mockRejectedValue(
      new MockReleaseBusV2ProductionAuthorityError(
        'CONFLICT',
        'The production lane is unavailable',
        'ACTIVE_WORKFLOW',
        { all: 4, production: 7, mode: 'PRODUCTION' }
      )
    );
    const response = await post(
      '/deploy/release-bus-v2/production-authority/prepare',
      AUTHORITY_BODY
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      authorized: false,
      operation_id: AUTHORITY_BODY.operation_id,
      reason_code: 'ACTIVE_WORKFLOW',
      observed_epoch: { all: 4, production: 7, mode: 'PRODUCTION' }
    });
  });

  it.each([
    ['CONFLICT', 409],
    ['UNAVAILABLE', 503]
  ] as const)(
    'maps manual readiness %s failures without dispatching',
    async (code, status) => {
      mockManualDeploymentAuthorize.mockRejectedValue(
        new MockReleaseBusV2ManualDeploymentError(
          code,
          'Manual deployment remains blocked'
        )
      );

      const response = await post(
        '/deploy/release-bus-v2/manual-deployment-readiness',
        {
          repository: 'frontend',
          environment: 'prod',
          service: 'frontend',
          workflow_run_id: '12345',
          workflow_run_attempt: 1,
          source_ref: 'main',
          source_sha: SHA
        }
      );

      expect(response.status).toBe(status);
      expect(mockDispatchDeploy).not.toHaveBeenCalled();
      expect(mockV2Authorize).not.toHaveBeenCalled();
    }
  );

  it('rejects malformed manual readiness identity before consulting the guard', async () => {
    const response = await post(
      '/deploy/release-bus-v2/manual-deployment-readiness',
      {
        repository: 'backend',
        environment: 'staging',
        service: 'api',
        workflow_run_id: '12345',
        workflow_run_attempt: 0,
        source_ref: 'main',
        source_sha: SHA
      }
    );

    expect(response.status).toBe(400);
    expect(mockManualDeploymentAuthorize).not.toHaveBeenCalled();
  });

  it('keeps root manual backend dispatch serialized to one service', async () => {
    const response = await post('/deploy/ui/dispatch', {
      target: 'backend',
      ref: 'main',
      environment: 'staging',
      services: ['api', 'tdhLoop']
    });

    expect(response.status).toBe(400);
    expect(mockManualDispatchReady).not.toHaveBeenCalled();
    expect(mockDispatchDeploy).not.toHaveBeenCalled();
  });

  it('checks authoritative lane readiness before a root manual dispatch', async () => {
    const response = await post('/deploy/ui/dispatch', {
      target: 'backend',
      ref: 'main',
      environment: 'staging',
      services: ['api']
    });

    expect(response.status).toBe(200);
    expect(mockManualDispatchReady).toHaveBeenCalledWith('staging');
    expect(mockDispatchDeploy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['staging', 'prod'],
    ['prod', 'staging']
  ] as const)(
    'routes %s ON and %s OFF independently without an ALL-level rejection',
    async (blockedEnvironment, allowedEnvironment) => {
      mockManualDispatchReady.mockImplementation(async (environment) => {
        if (environment === blockedEnvironment)
          throw new MockReleaseBusV2ManualDeploymentError(
            'CONFLICT',
            `${blockedEnvironment} lane is ON`
          );
      });

      const allowed = await post('/deploy/ui/dispatch', {
        target: 'backend',
        ref: 'main',
        environment: allowedEnvironment,
        services: ['api']
      });
      const blocked = await post('/deploy/ui/dispatch', {
        target: 'backend',
        ref: 'main',
        environment: blockedEnvironment,
        services: ['api']
      });

      expect(allowed.status).toBe(200);
      expect(blocked.status).toBe(409);
      expect(mockDispatchDeploy).toHaveBeenCalledTimes(1);
      expect(mockManualDispatchReady).toHaveBeenCalledWith(allowedEnvironment);
      expect(mockManualDispatchReady).toHaveBeenCalledWith(blockedEnvironment);
      expect(mockV2SetPaused).not.toHaveBeenCalled();
      expect(mockV2AppendEvent).not.toHaveBeenCalled();
    }
  );

  it('does not dispatch when authoritative manual readiness is unavailable', async () => {
    mockManualDispatchReady.mockRejectedValue(
      new MockReleaseBusV2ManualDeploymentError(
        'UNAVAILABLE',
        'Manual deployment remains blocked'
      )
    );

    const response = await post('/deploy/ui/dispatch', {
      target: 'backend',
      ref: 'main',
      environment: 'prod',
      services: ['api']
    });

    expect(response.status).toBe(503);
    expect(mockDispatchDeploy).not.toHaveBeenCalled();
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
