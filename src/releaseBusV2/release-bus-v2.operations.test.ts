const mockGetWorkflowRunIdentity = jest.fn();
const mockFindWorkflowRun = jest.fn();
const mockDispatchWorkflow = jest.fn();

jest.mock('@/releaseBus/release-bus.github-app', () => {
  class ReleaseBusGitHubInfrastructureError extends Error {
    public constructor(message: string) {
      super(message);
      this.name = 'ReleaseBusGitHubInfrastructureError';
    }
  }
  return {
    ReleaseBusGitHubInfrastructureError,
    releaseBusGitHubApp: {
      getWorkflowRunIdentity: (...args: unknown[]) =>
        mockGetWorkflowRunIdentity(...args),
      findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args),
      dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args)
    }
  };
});

import { ReleaseBusGitHubInfrastructureError } from '@/releaseBus/release-bus.github-app';
import { ReleaseBusV2Operations } from '@/releaseBusV2/release-bus-v2.operations';
import type { ReleaseBusV2OperationRecord } from '@/releaseBusV2/release-bus-v2.types';

function operation(
  overrides: Partial<ReleaseBusV2OperationRecord> = {}
): ReleaseBusV2OperationRecord {
  return {
    id: 'operation-id',
    idempotency_key: 'rb2:train-id:prepare:frontend',
    train_id: 'train-id',
    operation_type: 'PREPARE_ARTIFACT_FRONTEND',
    repository: 'frontend',
    service: null,
    environment: 'orchestration',
    expected_sha: 'a'.repeat(40),
    artifact_digest: null,
    external_id: '12345',
    status: 'RUNNING',
    attempt: 1,
    max_attempts: 3,
    next_retry_at: null,
    failure_class: null,
    failure_message: null,
    request_json: { workflow: 'release-bus-v2-preflight.yml' },
    result_json: null,
    started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1,
    ...overrides
  };
}

function repositoryFor(initial: ReleaseBusV2OperationRecord) {
  let current = initial;
  const updateOperation = jest.fn(
    async (
      _id: string,
      rowVersion: number,
      fields: Record<string, unknown>
    ) => {
      if (current.row_version !== rowVersion) return false;
      current = {
        ...current,
        status:
          (fields.status as ReleaseBusV2OperationRecord['status']) ??
          current.status,
        attempt:
          fields.attempt === undefined
            ? current.attempt
            : (fields.attempt as number),
        external_id:
          fields.externalId === undefined
            ? current.external_id
            : (fields.externalId as string | null),
        artifact_digest:
          fields.artifactDigest === undefined
            ? current.artifact_digest
            : (fields.artifactDigest as string | null),
        result_json:
          fields.result === undefined ? current.result_json : fields.result,
        next_retry_at:
          fields.nextRetryAt === undefined
            ? current.next_retry_at
            : (fields.nextRetryAt as number | null),
        failure_class:
          fields.failureClass === undefined
            ? current.failure_class
            : (fields.failureClass as ReleaseBusV2OperationRecord['failure_class']),
        failure_message:
          fields.failureMessage === undefined
            ? current.failure_message
            : (fields.failureMessage as string | null),
        completed_at:
          fields.completedAt === undefined
            ? current.completed_at
            : (fields.completedAt as number | null),
        row_version: current.row_version + 1
      };
      return true;
    }
  );
  return {
    repository: {
      findOperation: jest.fn(async () => current),
      getOrCreateOperation: jest.fn(async () => current),
      updateOperation
    },
    current: () => current,
    expireRetry: () => {
      current = { ...current, next_retry_at: 0 };
    }
  };
}

describe('Release Bus v2 exact operation callbacks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('binds the immutable artifact digest from the structured terminal report', async () => {
    const state = repositoryFor(operation());
    const service = new ReleaseBusV2Operations(state.repository as never);
    const report = {
      train_id: 'train-id',
      operation_key: 'rb2:train-id:prepare:frontend:a1',
      workflow_run_id: '12345',
      phase: 'complete',
      status: 'SUCCEEDED' as const,
      summary: { artifact_digest: 'f'.repeat(64) }
    };

    await expect(service.reportProgress(report)).resolves.toEqual({
      accepted: true,
      reused: false
    });
    expect(state.current().status).toBe('SUCCEEDED');
    expect(state.current().artifact_digest).toBe('f'.repeat(64));

    await expect(service.reportProgress(report)).resolves.toEqual({
      accepted: true,
      reused: true
    });
  });

  it('rejects successful artifact preparation without an exact digest', async () => {
    const state = repositoryFor(operation());
    const service = new ReleaseBusV2Operations(state.repository as never);
    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:frontend:a1',
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: null
      })
    ).rejects.toThrow('requires an exact SHA-256 digest');
    expect(state.current().status).toBe('RUNNING');
  });

  it('retries infrastructure failures without isolating a candidate', async () => {
    const state = repositoryFor(operation());
    const service = new ReleaseBusV2Operations(state.repository as never);
    await service.reportProgress({
      train_id: 'train-id',
      operation_key: 'rb2:train-id:prepare:frontend:a1',
      workflow_run_id: '12345',
      phase: 'download',
      status: 'FAILED',
      failure_class: 'INFRASTRUCTURE',
      retryable: true
    });
    expect(state.current().status).toBe('RETRY_WAIT');
    expect(state.current().failure_class).toBe('INFRASTRUCTURE');
    expect(Number(state.current().next_retry_at)).toBeGreaterThan(Date.now());
  });

  it('retries only the failed idempotent deployment operation', async () => {
    const state = repositoryFor(
      operation({ operation_type: 'DEPLOY_BACKEND_STAGING_API' })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);
    await service.reportProgress({
      train_id: 'train-id',
      operation_key: 'rb2:train-id:prepare:frontend:a1',
      workflow_run_id: '12345',
      phase: 'service_deploy',
      status: 'FAILED',
      failure_class: 'DEPLOYMENT',
      retryable: true
    });
    expect(state.current().status).toBe('RETRY_WAIT');
    expect(state.current().failure_class).toBe('DEPLOYMENT');
    expect(Number(state.current().next_retry_at)).toBeGreaterThan(Date.now());
  });

  it('rejects a workflow whose exact attempt identity is not in its run title', async () => {
    const initial = operation({ external_id: null, status: 'DISPATCHED' });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      event: 'workflow_dispatch',
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight frontend v2 [a different operation]'
    });
    const service = new ReleaseBusV2Operations(state.repository as never);
    await expect(
      service.authorize({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:frontend:a1',
        workflow_run_id: '12345',
        artifact_run_id: null,
        repository: 'frontend',
        environment: 'orchestration',
        service: null,
        expected_sha: 'a'.repeat(40),
        artifact_digest: null
      })
    ).rejects.toThrow('identity');
  });

  it('binds only the exact workflow file and immutable artifact source', async () => {
    const digest = 'f'.repeat(64);
    const initial = operation({
      artifact_digest: digest,
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-deploy-staging.yml',
        inputs: { artifact_run_id: '54321' }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      event: 'workflow_dispatch',
      path: '.github/workflows/release-bus-deploy-staging.yml@refs/heads/main',
      displayTitle: 'Deploy frontend staging [rb2:train-id:prepare:frontend:a1]'
    });
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.authorize({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:frontend:a1',
        workflow_run_id: '12345',
        artifact_run_id: '54321',
        repository: 'frontend',
        environment: 'orchestration',
        service: null,
        expected_sha: 'a'.repeat(40),
        artifact_digest: digest
      })
    ).resolves.toEqual({ authorized: true });
    expect(state.current()).toMatchObject({
      status: 'RUNNING',
      external_id: '12345',
      artifact_digest: digest
    });
  });

  it('rejects a different workflow file or artifact source', async () => {
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        inputs: { artifact_run_id: '54321' }
      }
    });
    const state = repositoryFor(initial);
    const service = new ReleaseBusV2Operations(state.repository as never);
    const input = {
      train_id: 'train-id',
      operation_key: 'rb2:train-id:prepare:frontend:a1',
      workflow_run_id: '12345',
      artifact_run_id: '54321',
      repository: 'frontend' as const,
      environment: 'orchestration',
      service: null,
      expected_sha: 'a'.repeat(40),
      artifact_digest: null
    };
    mockGetWorkflowRunIdentity.mockResolvedValue({
      event: 'workflow_dispatch',
      path: '.github/workflows/another-workflow.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(service.authorize(input)).rejects.toThrow('identity');

    mockGetWorkflowRunIdentity.mockResolvedValue({
      event: 'workflow_dispatch',
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(
      service.authorize({ ...input, artifact_run_id: '99999' })
    ).rejects.toThrow('artifact source');
  });

  it('fails closed when a successful workflow omits its terminal callback', async () => {
    const state = repositoryFor(operation());
    const service = new ReleaseBusV2Operations(state.repository as never);
    mockFindWorkflowRun.mockResolvedValue({
      id: 12345,
      status: 'completed',
      conclusion: 'success'
    });

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend',
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'release-bus-v2/staging-train-train-id-frontend',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {}
    });

    expect(state.current()).toMatchObject({
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE'
    });
  });

  it('rejects authorization after an operation reaches a terminal state', async () => {
    const state = repositoryFor(operation({ status: 'FAILED' }));
    const service = new ReleaseBusV2Operations(state.repository as never);
    await expect(
      service.authorize({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:frontend:a1',
        workflow_run_id: '12345',
        artifact_run_id: null,
        repository: 'frontend',
        environment: 'orchestration',
        service: null,
        expected_sha: 'a'.repeat(40),
        artifact_digest: null
      })
    ).rejects.toThrow('cannot authorize while FAILED');
    expect(mockGetWorkflowRunIdentity).not.toHaveBeenCalled();
  });

  it('discovers an uncertain dispatch before reusing the same attempt key', async () => {
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'PENDING',
        result_json: null
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);
    const spec = {
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend' as const,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'release-bus-v2/staging-train-train-id-frontend',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: { train_id: 'train-id' }
    };
    mockFindWorkflowRun
      .mockRejectedValueOnce(
        new ReleaseBusGitHubInfrastructureError('connection reset')
      )
      .mockResolvedValue(null);

    await service.reconcileWorkflow(spec);
    expect(state.current().status).toBe('RETRY_WAIT');
    expect(state.current().attempt).toBe(1);
    expect(state.current().result_json).toEqual({
      retry_same_attempt: true,
      transport_failures: 1
    });

    state.expireRetry();
    await service.reconcileWorkflow(spec);
    expect(state.current().status).toBe('PENDING');
    expect(state.current().attempt).toBe(1);
    expect(state.current().result_json).toBeNull();
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();

    await service.reconcileWorkflow(spec);
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'frontend',
      'release-bus-v2-preflight.yml',
      'release-bus-v2/staging-train-train-id-frontend',
      expect.objectContaining({
        operation_key: 'rb2:train-id:prepare:frontend:a1'
      })
    );
    expect(state.current().status).toBe('DISPATCHED');
    expect(state.current().attempt).toBe(1);
  });
});
