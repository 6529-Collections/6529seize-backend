const mockGetWorkflowRunIdentity = jest.fn();
const mockGetWorkflowBlobIdentity = jest.fn();
const mockFindWorkflowRun = jest.fn();
const mockDispatchWorkflow = jest.fn();
const mockResolveRef = jest.fn();
const LEGACY_WORKFLOW_COMPATIBILITY_TEST_TIME = Date.UTC(
  2026,
  7,
  31,
  23,
  59,
  58
);

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => {
  class ReleaseBusGitHubInfrastructureError extends Error {
    public constructor(message: string) {
      super(message);
      this.name = 'ReleaseBusGitHubInfrastructureError';
    }
  }
  return {
    ReleaseBusGitHubInfrastructureError,
    releaseBusGitHubApp: {
      getWorkflowBlobIdentity: (...args: unknown[]) =>
        mockGetWorkflowBlobIdentity(...args),
      getWorkflowRunIdentity: (...args: unknown[]) =>
        mockGetWorkflowRunIdentity(...args),
      findWorkflowRun: (...args: unknown[]) => mockFindWorkflowRun(...args),
      dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args),
      resolveRef: (...args: unknown[]) => mockResolveRef(...args)
    }
  };
});

import { ReleaseBusGitHubInfrastructureError } from '@/releaseBusV2/release-bus-v2.github-app';
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
    request_json: {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      workflow_control_sha: 'c'.repeat(40)
    },
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
        updated_at: Date.now(),
        row_version: current.row_version + 1
      };
      return true;
    }
  );
  return {
    repository: {
      appendEvent: jest.fn(async () => undefined),
      findOperation: jest.fn(
        async (
          _key: string,
          _ctx: unknown,
          _forceWrite = false
        ): Promise<ReleaseBusV2OperationRecord | null> => current
      ),
      getOrCreateOperation: jest.fn(async () => current),
      updateOperation
    },
    current: () => current,
    expireRetry: () => {
      current = { ...current, next_retry_at: 0 };
    },
    raceTo: (fields: Partial<ReleaseBusV2OperationRecord>) => {
      current = {
        ...current,
        ...fields,
        row_version: current.row_version + 1
      };
    },
    ageUpdatedAt: (milliseconds: number) => {
      current = { ...current, updated_at: current.updated_at - milliseconds };
    }
  };
}

describe('Release Bus v2 exact operation callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkflowBlobIdentity.mockReset();
    mockGetWorkflowBlobIdentity.mockResolvedValue(
      'c4d7c0a7a2e9d10ddb82eec7feff7d8523e25b9f'
    );
    mockGetWorkflowRunIdentity.mockReset();
    mockFindWorkflowRun.mockReset();
    mockDispatchWorkflow.mockReset();
    mockResolveRef.mockReset();
    mockResolveRef.mockResolvedValue('f'.repeat(40));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('injects one transparent beta infrastructure retry before dispatch', async () => {
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'PENDING',
        idempotency_key: 'rb2:train-id:prepare:backend',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        repository: 'backend'
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);
    const spec = {
      idempotencyKey: 'rb2:train-id:prepare:backend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_BACKEND',
      repository: 'backend' as const,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {},
      betaInfrastructureFailureInjection: {
        candidateId: '11111111-1111-4111-8111-111111111111',
        testId: 'infrastructure-retry-1'
      }
    };

    await service.reconcileWorkflow(spec);
    expect(state.current()).toMatchObject({
      status: 'RETRY_WAIT',
      attempt: 1,
      external_id: null,
      failure_class: 'INFRASTRUCTURE',
      failure_message:
        'Injected operator beta infrastructure failure before dispatch'
    });
    expect(state.repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: '11111111-1111-4111-8111-111111111111',
        eventType: 'BETA_INFRASTRUCTURE_FAILURE_INJECTED',
        trainId: 'train-id'
      }),
      {}
    );
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();

    state.expireRetry();
    mockFindWorkflowRun.mockResolvedValue(null);
    await service.reconcileWorkflow(spec);
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'backend',
      'release-bus-v2-preflight.yml',
      'main',
      expect.objectContaining({
        operation_key: 'rb2:train-id:prepare:backend:a2'
      })
    );
    expect(state.current()).toMatchObject({
      status: 'DISPATCHED',
      attempt: 2,
      external_id: null,
      failure_class: null
    });
    expect(state.repository.appendEvent).toHaveBeenCalledTimes(1);
  });

  it('returns the writer-reserved dispatch when the read replica is stale', async () => {
    const staleReplica = operation({
      external_id: null,
      status: 'PENDING',
      idempotency_key: 'rb2:train-id:e2e:staging',
      operation_type: 'E2E_STAGING',
      repository: 'frontend',
      environment: 'staging'
    });
    const state = repositoryFor(staleReplica);
    state.repository.findOperation.mockImplementation(
      async (_key: string, _ctx: unknown, forceWrite = false) =>
        forceWrite ? state.current() : staleReplica
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);

    const reconciled = await service.reconcileWorkflow({
      idempotencyKey: staleReplica.idempotency_key,
      trainId: staleReplica.train_id,
      operationType: staleReplica.operation_type,
      repository: 'frontend',
      workflow: 'staging-e2e.yml',
      ref: '1a-staging',
      environment: 'staging',
      service: null,
      expectedSha: staleReplica.expected_sha!,
      artifactDigest: null,
      inputs: {}
    });

    expect(reconciled.status).toBe('DISPATCHED');
    expect(state.repository.findOperation).toHaveBeenCalledWith(
      staleReplica.idempotency_key,
      {},
      true
    );
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    'PENDING',
    'RUNNING',
    'RETRY_WAIT',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  ] as const)(
    'does not dispatch when the writer has advanced the reservation to %s',
    async (writerStatus) => {
      const staleReplica = operation({
        external_id: null,
        status: 'PENDING'
      });
      const state = repositoryFor(staleReplica);
      state.repository.findOperation.mockImplementation(
        async (_key: string, _ctx: unknown, forceWrite = false) =>
          forceWrite
            ? operation({
                ...state.current(),
                status: writerStatus,
                row_version: state.current().row_version + 1
              })
            : staleReplica
      );
      mockFindWorkflowRun.mockResolvedValue(null);
      const service = new ReleaseBusV2Operations(state.repository as never);

      const reconciled = await service.reconcileWorkflow({
        idempotencyKey: staleReplica.idempotency_key,
        trainId: staleReplica.train_id,
        operationType: staleReplica.operation_type,
        repository: 'frontend',
        workflow: 'staging-e2e.yml',
        ref: '1a-staging',
        environment: 'staging',
        service: null,
        expectedSha: staleReplica.expected_sha!,
        artifactDigest: null,
        inputs: {}
      });

      expect(reconciled.status).toBe(writerStatus);
      expect(mockDispatchWorkflow).not.toHaveBeenCalled();
    }
  );

  it('fails closed when the writer cannot see the dispatch reservation', async () => {
    const pending = operation({ external_id: null, status: 'PENDING' });
    const state = repositoryFor(pending);
    state.repository.findOperation.mockImplementation(
      async (_key: string, _ctx: unknown, forceWrite = false) =>
        forceWrite ? null : pending
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reconcileWorkflow({
        idempotencyKey: pending.idempotency_key,
        trainId: pending.train_id,
        operationType: pending.operation_type,
        repository: 'frontend',
        workflow: 'staging-e2e.yml',
        ref: '1a-staging',
        environment: 'staging',
        service: null,
        expectedSha: pending.expected_sha!,
        artifactDigest: null,
        inputs: {}
      })
    ).rejects.toThrow(
      'Release Bus v2 dispatch reservation was not visible on the writer'
    );
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('continues an old-producer preflight with its immutable stored request after the reconciler upgrade', async () => {
    const oldInputs = {
      release_train_id: 'train-id',
      release_train_revision: '1',
      operation_key: 'replaced-by-reconciler',
      source_ref: 'feature/old-producer-candidate',
      expected_sha: 'a'.repeat(40),
      deploy_units: '["api"]',
      reuse_artifact_run_id: '456',
      reuse_artifact_name: `release-bus-v2-pr-${'a'.repeat(40)}`,
      reuse_artifact_digest: 'd'.repeat(64)
    };
    const oldRequest = {
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      inputs: oldInputs,
      beta_infrastructure_failure_injection: null
    };
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'PENDING',
        idempotency_key: 'rb2:train-id:prepare:backend',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        repository: 'backend',
        request_json: oldRequest
      })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:prepare:backend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_BACKEND',
      repository: 'backend',
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {
        ...oldInputs,
        source_ref: 'release-bus-v2/staging-train-train-id-backend',
        deploy_layers: '[["api"]]',
        artifact_environment: 'staging',
        artifact_contract_version: 'environment-bound-v3',
        candidate_evidence_mode: 'strict-single',
        aggregate_candidate_evidence_digest: ''
      }
    });

    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(state.repository.getOrCreateOperation).toHaveBeenCalledWith(
      expect.objectContaining({ request: oldRequest }),
      {}
    );
    expect(mockDispatchWorkflow).toHaveBeenCalledWith(
      'backend',
      'release-bus-v2-preflight.yml',
      'main',
      {
        ...oldInputs,
        operation_key: 'rb2:train-id:prepare:backend:a1'
      }
    );
  });

  it.each([
    {
      operationType: 'DEPLOY_BACKEND_STAGING_releaseBus',
      workflow: 'deploy.yml',
      environment: 'staging',
      service: 'releaseBus',
      oldInputs: {
        environment: 'staging',
        service: 'releaseBus',
        operation_key: 'replaced-by-reconciler',
        artifact_run_id: '456',
        artifact_digest: 'd'.repeat(64)
      },
      addedInputs: {
        artifact_environment: '',
        artifact_contract_version: 'legacy-v2'
      }
    },
    {
      operationType: 'E2E_STAGING',
      workflow: 'staging-e2e.yml',
      environment: 'staging',
      service: null,
      oldInputs: {
        operation_key: 'replaced-by-reconciler',
        release_manifest_id: 'manifest-id',
        expected_sha: 'a'.repeat(40)
      },
      addedInputs: {}
    }
  ])(
    'continues an old-producer $operationType operation without rewriting its dispatch',
    async ({
      operationType,
      workflow,
      environment,
      service: operationService,
      oldInputs,
      addedInputs
    }) => {
      const oldRequest = {
        workflow,
        ref: 'main',
        inputs: oldInputs,
        beta_infrastructure_failure_injection: null
      };
      const state = repositoryFor(
        operation({
          external_id: null,
          status: 'PENDING',
          idempotency_key: `rb2:train-id:${operationType}`,
          operation_type: operationType,
          repository: 'backend',
          environment,
          service: operationService,
          artifact_digest: 'd'.repeat(64),
          request_json: oldRequest
        })
      );
      mockFindWorkflowRun.mockResolvedValue(null);
      const service = new ReleaseBusV2Operations(state.repository as never);

      await service.reconcileWorkflow({
        idempotencyKey: `rb2:train-id:${operationType}`,
        trainId: 'train-id',
        operationType,
        repository: 'backend',
        workflow,
        ref: 'main',
        environment,
        service: operationService,
        expectedSha: 'a'.repeat(40),
        artifactDigest: 'd'.repeat(64),
        inputs: {
          ...oldInputs,
          ...addedInputs
        } as unknown as Readonly<Record<string, string>>
      });

      expect(state.repository.getOrCreateOperation).toHaveBeenCalledWith(
        expect.objectContaining({ request: oldRequest }),
        {}
      );
      expect(mockDispatchWorkflow).toHaveBeenCalledWith(
        'backend',
        workflow,
        'main',
        {
          ...oldInputs,
          operation_key: `rb2:train-id:${operationType}:a1`
        }
      );
    }
  );

  it('rejects unrelated input drift instead of treating it as an old-producer migration', async () => {
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'PENDING',
        request_json: {
          workflow: 'deploy.yml',
          ref: 'main',
          inputs: {
            environment: 'staging',
            service: 'api',
            operation_key: 'replaced-by-reconciler'
          },
          beta_infrastructure_failure_injection: null
        }
      })
    );
    state.repository.getOrCreateOperation.mockRejectedValueOnce(
      new Error(
        'Release Bus v2 idempotency key was reused with a different immutable operation identity'
      )
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reconcileWorkflow({
        idempotencyKey: 'rb2:train-id:prepare:frontend',
        trainId: 'train-id',
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        repository: 'frontend',
        workflow: 'deploy.yml',
        ref: 'main',
        environment: 'orchestration',
        service: null,
        expectedSha: 'a'.repeat(40),
        artifactDigest: null,
        inputs: {
          environment: 'prod',
          service: 'api',
          operation_key: 'replaced-by-reconciler'
        }
      })
    ).rejects.toThrow('different immutable operation identity');

    expect(mockResolveRef).toHaveBeenCalledWith('frontend', 'main');
    expect(state.repository.getOrCreateOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          workflow_control_sha: 'f'.repeat(40),
          inputs: expect.objectContaining({ environment: 'prod' })
        })
      }),
      {}
    );
  });

  it.each([
    ['artifact_contract_version', 'legacy-v2', 'environment-bound-v3'],
    ['artifact_environment', 'staging', 'production']
  ])(
    'does not ignore a present-but-different migrated %s',
    async (field, storedValue, requestedValue) => {
      const state = repositoryFor(
        operation({
          external_id: null,
          status: 'PENDING',
          request_json: {
            workflow: 'deploy.yml',
            ref: 'main',
            inputs: {
              operation_key: 'replaced-by-reconciler',
              [field]: storedValue
            },
            beta_infrastructure_failure_injection: null
          }
        })
      );
      state.repository.getOrCreateOperation.mockRejectedValueOnce(
        new Error('different immutable operation identity')
      );
      const service = new ReleaseBusV2Operations(state.repository as never);

      await expect(
        service.reconcileWorkflow({
          idempotencyKey: 'rb2:train-id:prepare:frontend',
          trainId: 'train-id',
          operationType: 'PREPARE_ARTIFACT_FRONTEND',
          repository: 'frontend',
          workflow: 'deploy.yml',
          ref: 'main',
          environment: 'orchestration',
          service: null,
          expectedSha: 'a'.repeat(40),
          artifactDigest: null,
          inputs: {
            operation_key: 'replaced-by-reconciler',
            [field]: requestedValue
          }
        })
      ).rejects.toThrow('different immutable operation identity');
      expect(mockResolveRef).toHaveBeenCalledWith('frontend', 'main');
      expect(state.repository.getOrCreateOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            workflow_control_sha: 'f'.repeat(40),
            inputs: expect.objectContaining({ [field]: requestedValue })
          })
        }),
        {}
      );
    }
  );

  it('observes the winning workflow callback when reconciles overlap', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    state.repository.updateOperation.mockImplementationOnce(async () => {
      state.raceTo({ external_id: '12345', status: 'RUNNING' });
      return false;
    });
    mockFindWorkflowRun.mockResolvedValue({
      id: 12345,
      status: 'in_progress',
      conclusion: null
    });
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reconcileWorkflow({
        idempotencyKey: 'rb2:train-id:prepare:frontend',
        trainId: 'train-id',
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        repository: 'frontend',
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        environment: 'orchestration',
        service: null,
        expectedSha: 'a'.repeat(40),
        artifactDigest: null,
        inputs: {}
      })
    ).resolves.toMatchObject({
      external_id: '12345',
      status: 'RUNNING'
    });
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('allows only one dispatch while an exact attempt is not yet discoverable', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);
    const spec = {
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend' as const,
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {}
    };

    await expect(
      Promise.all([
        service.reconcileWorkflow(spec),
        service.reconcileWorkflow(spec)
      ])
    ).resolves.toEqual([
      expect.objectContaining({ status: 'DISPATCHED' }),
      expect.objectContaining({ status: 'DISPATCHED' })
    ]);
    expect(mockDispatchWorkflow).toHaveBeenCalledTimes(1);
    expect(state.current()).toMatchObject({
      external_id: null,
      status: 'DISPATCHED',
      attempt: 1
    });

    state.ageUpdatedAt(31_000);
    await service.reconcileWorkflow(spec);
    expect(state.current()).toMatchObject({
      status: 'RETRY_WAIT',
      attempt: 1,
      result_json: { retry_same_attempt: true, transport_failures: 1 }
    });
  });

  it('exits before dispatch when another reconciler wins the reservation', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    state.repository.updateOperation.mockImplementationOnce(async () => {
      state.raceTo({ status: 'DISPATCHED' });
      return false;
    });
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reconcileWorkflow({
        idempotencyKey: 'rb2:train-id:prepare:frontend',
        trainId: 'train-id',
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        repository: 'frontend',
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        environment: 'orchestration',
        service: null,
        expectedSha: 'a'.repeat(40),
        artifactDigest: null,
        inputs: {}
      })
    ).resolves.toMatchObject({ status: 'DISPATCHED' });
    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
  });

  it('preserves a hard dispatch rejection as a control-plane failure', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockRejectedValueOnce(
      new Error('HTTP 422 workflow input rejected')
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reconcileWorkflow({
        idempotencyKey: 'rb2:train-id:prepare:frontend',
        trainId: 'train-id',
        operationType: 'PREPARE_ARTIFACT_FRONTEND',
        repository: 'frontend',
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        environment: 'orchestration',
        service: null,
        expectedSha: 'a'.repeat(40),
        artifactDigest: null,
        inputs: {}
      })
    ).rejects.toThrow('HTTP 422 workflow input rejected');
    expect(state.current()).toMatchObject({
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      failure_message:
        'GitHub workflow dispatch was rejected before creation: HTTP 422 workflow input rejected'
    });
  });

  it('retries an unwrapped transient dispatch error with the same attempt key', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockRejectedValueOnce(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend',
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {}
    });

    expect(state.current()).toMatchObject({
      status: 'RETRY_WAIT',
      attempt: 1,
      failure_class: 'INFRASTRUCTURE',
      result_json: { retry_same_attempt: true, transport_failures: 1 }
    });
  });

  it('retries a raw secondary-rate-limit 403 with the same attempt key', async () => {
    const state = repositoryFor(
      operation({ external_id: null, status: 'PENDING' })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    mockDispatchWorkflow.mockRejectedValueOnce(
      Object.assign(new Error('secondary rate limit'), {
        status: 403,
        retryAfter: '30'
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend',
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {}
    });

    expect(state.current()).toMatchObject({
      status: 'RETRY_WAIT',
      attempt: 1,
      failure_class: 'INFRASTRUCTURE',
      result_json: { retry_same_attempt: true, transport_failures: 1 }
    });
  });

  it('recovers a stale dispatch reservation without changing its attempt key', async () => {
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'DISPATCHED',
        updated_at: Date.now() - 31_000
      })
    );
    mockFindWorkflowRun.mockResolvedValue(null);
    const service = new ReleaseBusV2Operations(state.repository as never);

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:prepare:frontend',
      trainId: 'train-id',
      operationType: 'PREPARE_ARTIFACT_FRONTEND',
      repository: 'frontend',
      workflow: 'release-bus-v2-preflight.yml',
      ref: 'main',
      environment: 'orchestration',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: null,
      inputs: {}
    });

    expect(mockDispatchWorkflow).not.toHaveBeenCalled();
    expect(state.current()).toMatchObject({
      status: 'RETRY_WAIT',
      attempt: 1,
      result_json: { retry_same_attempt: true, transport_failures: 1 }
    });
  });

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

  it('binds every selected unit and environment for a v3 backend artifact', async () => {
    const state = repositoryFor(
      operation({
        idempotency_key: 'rb2:train-id:prepare:backend',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        repository: 'backend',
        request_json: {
          workflow: 'release-bus-v2-preflight.yml',
          inputs: {
            artifact_contract_version: 'environment-bound-v3',
            artifact_environment: 'production',
            deploy_units: '["api","releaseBus"]',
            deploy_layers: '[["api"],["releaseBus"]]',
            candidate_evidence_mode: 'strict-aggregate',
            aggregate_candidate_evidence_digest: '9'.repeat(64),
            reuse_artifact_run_id: '',
            reuse_artifact_name: '',
            reuse_artifact_digest: ''
          }
        }
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:backend:a1',
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          artifact_digest: 'f'.repeat(64),
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_contract_version: 'environment-bound-v3',
          repository: 'backend',
          source_sha: 'a'.repeat(40),
          environment: 'production',
          source_evidence_reused: true,
          artifact_bytes_reused: false,
          ci_evidence: {
            mode: 'strict-aggregate',
            artifact_run_id: null,
            artifact_name: null,
            artifact_digest: null,
            aggregate_candidate_evidence_digest: '9'.repeat(64)
          },
          units: ['api', 'releaseBus'],
          layers: [['api'], ['releaseBus']],
          package_digests: {
            api: 'b'.repeat(64),
            releaseBus: 'c'.repeat(64)
          }
        }
      })
    ).resolves.toEqual({ accepted: true, reused: false });
  });

  it.each([
    {
      label: 'schema v2',
      patch: { schema_version: 2 }
    },
    {
      label: 'wrong environment',
      patch: { environment: 'staging' }
    },
    {
      label: 'reused staging artifact bytes',
      patch: { artifact_bytes_reused: true }
    },
    {
      label: 'missing selected unit digest',
      patch: { package_digests: { api: 'b'.repeat(64) } }
    },
    {
      label: 'flattened dependency frontiers',
      patch: { layers: [['api', 'releaseBus']] }
    }
  ])('rejects $label evidence for a v3 backend artifact', async ({ patch }) => {
    const state = repositoryFor(
      operation({
        idempotency_key: 'rb2:train-id:prepare:backend',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        repository: 'backend',
        request_json: {
          workflow: 'release-bus-v2-preflight.yml',
          inputs: {
            artifact_contract_version: 'environment-bound-v3',
            artifact_environment: 'production',
            deploy_units: '["api","releaseBus"]',
            deploy_layers: '[["api"],["releaseBus"]]',
            candidate_evidence_mode: 'strict-aggregate',
            aggregate_candidate_evidence_digest: '9'.repeat(64),
            reuse_artifact_run_id: '',
            reuse_artifact_name: '',
            reuse_artifact_digest: ''
          }
        }
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);
    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:backend:a1',
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          artifact_digest: 'f'.repeat(64),
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_contract_version: 'environment-bound-v3',
          repository: 'backend',
          source_sha: 'a'.repeat(40),
          environment: 'production',
          source_evidence_reused: true,
          artifact_bytes_reused: false,
          ci_evidence: {
            mode: 'strict-aggregate',
            artifact_run_id: null,
            artifact_name: null,
            artifact_digest: null,
            aggregate_candidate_evidence_digest: '9'.repeat(64)
          },
          units: ['api', 'releaseBus'],
          layers: [['api'], ['releaseBus']],
          package_digests: {
            api: 'b'.repeat(64),
            releaseBus: 'c'.repeat(64)
          },
          ...patch
        }
      })
    ).rejects.toThrow(/environment-bound/i);
    expect(state.current().status).toBe('RUNNING');
  });

  it('binds a successful backend deployment report to its exact v3 artifact', async () => {
    const artifactDigest = 'd'.repeat(64);
    const operationKey = 'rb2:train-id:deploy:staging:backend:api';
    const state = repositoryFor(
      operation({
        idempotency_key: operationKey,
        operation_type: 'DEPLOY_BACKEND_STAGING_api',
        repository: 'backend',
        service: 'api',
        environment: 'staging',
        expected_sha: 'a'.repeat(40),
        artifact_digest: artifactDigest,
        request_json: {
          workflow: 'deploy.yml',
          inputs: {
            artifact_contract_version: 'environment-bound-v3',
            artifact_environment: 'staging',
            artifact_digest: artifactDigest,
            artifact_run_id: '54321',
            artifact_train_id: 'train-id'
          }
        }
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: `${operationKey}:a1`,
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_digest: artifactDigest,
          artifact_contract_version: 'environment-bound-v3',
          environment: 'staging',
          repository: 'backend',
          source_sha: 'a'.repeat(40),
          service: 'api',
          artifact_run_id: '54321',
          artifact_train_id: 'train-id',
          package_digest: 'e'.repeat(64),
          consumed_preflight_artifact: true,
          rebuilt: false
        }
      })
    ).resolves.toEqual({ accepted: true, reused: false });
    expect(state.current().status).toBe('SUCCEEDED');
  });

  it('binds a successful frontend deployment report to the same cross-repository v3 contract', async () => {
    const artifactDigest = 'd'.repeat(64);
    const operationKey = 'rb2:train-id:deploy:staging:frontend';
    const state = repositoryFor(
      operation({
        idempotency_key: operationKey,
        operation_type: 'DEPLOY_FRONTEND_STAGING',
        repository: 'frontend',
        service: null,
        environment: 'staging',
        expected_sha: 'a'.repeat(40),
        artifact_digest: artifactDigest,
        request_json: {
          workflow: 'release-bus-deploy-staging.yml',
          inputs: {
            artifact_contract_version: 'environment-bound-v3',
            artifact_environment: 'staging',
            artifact_digest: artifactDigest,
            artifact_run_id: '54321',
            artifact_train_id: 'train-id'
          }
        }
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: `${operationKey}:a1`,
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_contract_version: 'environment-bound-v3',
          repository: 'frontend',
          source_sha: 'a'.repeat(40),
          environment: 'staging',
          service: null,
          artifact_run_id: '54321',
          artifact_train_id: 'train-id',
          artifact_digest: artifactDigest,
          package_digest: 'e'.repeat(64),
          consumed_preflight_artifact: true,
          rebuilt: false
        }
      })
    ).resolves.toEqual({ accepted: true, reused: false });
  });

  it('accepts only a coherent legacy preflight-to-same-train deploy terminal chain', async () => {
    const artifactDigest = 'd'.repeat(64);
    const preflightState = repositoryFor(
      operation({
        idempotency_key: 'rb2:train-id:prepare:backend',
        operation_type: 'PREPARE_ARTIFACT_BACKEND',
        repository: 'backend',
        service: null,
        environment: 'orchestration',
        artifact_digest: null,
        request_json: {
          workflow: 'release-bus-v2-preflight.yml',
          inputs: {
            artifact_contract_version: 'legacy-v2'
          }
        }
      })
    );
    const preflight = new ReleaseBusV2Operations(
      preflightState.repository as never
    );
    await expect(
      preflight.reportProgress({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:backend:a1',
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          schema_version: 2,
          artifact_contract: 'legacy-v2',
          artifact_contract_version: 'legacy-v2',
          artifact_digest: artifactDigest
        }
      })
    ).resolves.toEqual({ accepted: true, reused: false });
    expect(preflightState.current().artifact_digest).toBe(artifactDigest);

    const operationKey = 'rb2:train-id:deploy:staging:backend:api';
    const deployState = repositoryFor(
      operation({
        idempotency_key: operationKey,
        operation_type: 'DEPLOY_BACKEND_STAGING_api',
        repository: 'backend',
        service: 'api',
        environment: 'staging',
        expected_sha: 'a'.repeat(40),
        artifact_digest: preflightState.current().artifact_digest,
        request_json: {
          workflow: 'deploy.yml',
          inputs: {
            artifact_contract_version: 'legacy-v2',
            artifact_environment: '',
            artifact_digest: artifactDigest,
            artifact_run_id: '12345',
            artifact_train_id: 'train-id'
          }
        }
      })
    );
    const deploy = new ReleaseBusV2Operations(deployState.repository as never);
    const summary = {
      schema_version: 2,
      artifact_contract: 'legacy-v2',
      artifact_contract_version: 'legacy-v2',
      repository: 'backend',
      source_sha: 'a'.repeat(40),
      environment: 'portable',
      deployment_environment: 'staging',
      service: 'api',
      artifact_run_id: '12345',
      artifact_train_id: 'train-id',
      artifact_digest: artifactDigest,
      package_digest: 'e'.repeat(64),
      consumed_preflight_artifact: true,
      rebuilt: false
    };
    await expect(
      deploy.reportProgress({
        train_id: 'train-id',
        operation_key: `${operationKey}:a1`,
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary
      })
    ).resolves.toEqual({ accepted: true, reused: false });

    const hybridState = repositoryFor({
      ...deployState.current(),
      id: 'hybrid-operation',
      status: 'RUNNING',
      result_json: null,
      completed_at: null,
      row_version: 1
    });
    const hybrid = new ReleaseBusV2Operations(hybridState.repository as never);
    await expect(
      hybrid.reportProgress({
        train_id: 'train-id',
        operation_key: `${operationKey}:a1`,
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: {
          ...summary,
          schema_version: 3,
          artifact_contract: 'environment-bound-v1'
        }
      })
    ).rejects.toThrow(/legacy deployment evidence/i);
  });

  it.each([
    ['missing summary', null],
    [
      'wrong environment',
      {
        schema_version: 3,
        artifact_contract: 'environment-bound-v1',
        artifact_digest: 'd'.repeat(64),
        artifact_contract_version: 'environment-bound-v3',
        environment: 'production',
        repository: 'backend',
        source_sha: 'a'.repeat(40),
        service: 'api',
        artifact_run_id: '54321',
        artifact_train_id: 'train-id',
        package_digest: 'e'.repeat(64),
        consumed_preflight_artifact: true,
        rebuilt: false
      }
    ],
    [
      'wrong package digest',
      {
        schema_version: 3,
        artifact_contract: 'environment-bound-v1',
        artifact_digest: 'd'.repeat(64),
        artifact_contract_version: 'environment-bound-v3',
        environment: 'staging',
        repository: 'backend',
        source_sha: 'a'.repeat(40),
        service: 'api',
        artifact_run_id: '54321',
        artifact_train_id: 'train-id',
        package_digest: 'not-a-digest',
        consumed_preflight_artifact: true,
        rebuilt: false
      }
    ]
  ])(
    'rejects backend deployment evidence with $label',
    async (_label, summary) => {
      const artifactDigest = 'd'.repeat(64);
      const operationKey = 'rb2:train-id:deploy:staging:backend:api';
      const state = repositoryFor(
        operation({
          idempotency_key: operationKey,
          operation_type: 'DEPLOY_BACKEND_STAGING_api',
          repository: 'backend',
          service: 'api',
          environment: 'staging',
          expected_sha: 'a'.repeat(40),
          artifact_digest: artifactDigest,
          request_json: {
            workflow: 'deploy.yml',
            inputs: {
              artifact_contract_version: 'environment-bound-v3',
              artifact_environment: 'staging',
              artifact_digest: artifactDigest,
              artifact_run_id: '54321',
              artifact_train_id: 'train-id'
            }
          }
        })
      );
      const service = new ReleaseBusV2Operations(state.repository as never);

      await expect(
        service.reportProgress({
          train_id: 'train-id',
          operation_key: `${operationKey}:a1`,
          workflow_run_id: '12345',
          phase: 'complete',
          status: 'SUCCEEDED',
          summary
        })
      ).rejects.toThrow(/deployment/i);
      expect(state.current().status).toBe('RUNNING');
    }
  );

  it('requires the same immutable terminal evidence for rollback deploys', async () => {
    const artifactDigest = 'd'.repeat(64);
    const operationKey = 'rb2:train-id:rollback:deploy:staging:backend:api';
    const state = repositoryFor(
      operation({
        idempotency_key: operationKey,
        operation_type: 'ROLLBACK_DEPLOY_BACKEND_STAGING_api',
        repository: 'backend',
        service: 'api',
        environment: 'staging',
        artifact_digest: artifactDigest,
        request_json: {
          workflow: 'deploy.yml',
          inputs: {
            artifact_contract_version: 'environment-bound-v3',
            artifact_environment: 'staging',
            artifact_digest: artifactDigest,
            artifact_run_id: '54321',
            artifact_train_id: 'train-id'
          }
        }
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);

    await expect(
      service.reportProgress({
        train_id: 'train-id',
        operation_key: `${operationKey}:a1`,
        workflow_run_id: '12345',
        phase: 'complete',
        status: 'SUCCEEDED',
        summary: null
      })
    ).rejects.toThrow(/deployment/i);
    expect(state.current().status).toBe('RUNNING');
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
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
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
        ref: 'main',
        workflow_control_sha: 'c'.repeat(40),
        inputs: { artifact_run_id: '54321' }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
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
        artifact_digest: digest,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).resolves.toEqual({ authorized: true });
    expect(state.current()).toMatchObject({
      status: 'RUNNING',
      external_id: '12345',
      artifact_digest: digest
    });
  });

  it('normalizes an old-producer preflight authorization to legacy evidence', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(LEGACY_WORKFLOW_COMPATIBILITY_TEST_TIME);
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {
          source_ref: 'release-bus-v2/train-id/backend'
        }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
        artifact_digest: null,
        source_ref: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).resolves.toEqual({ authorized: true });
    expect(mockGetWorkflowBlobIdentity).toHaveBeenCalledWith(
      'frontend',
      'release-bus-v2-preflight.yml',
      'c'.repeat(40)
    );
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('binds an old-producer authorization to its exact run after main moves', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(LEGACY_WORKFLOW_COMPATIBILITY_TEST_TIME);
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {}
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    mockResolveRef.mockResolvedValue('d'.repeat(40));
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).resolves.toEqual({ authorized: true });
    expect(mockResolveRef).not.toHaveBeenCalled();
    expect(state.current().external_id).toBe('12345');
  });

  it('accepts an old-producer operation only through the exact new-consumer workflow blob', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(LEGACY_WORKFLOW_COMPATIBILITY_TEST_TIME);
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {}
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    mockGetWorkflowBlobIdentity.mockResolvedValue(
      'c2f54b2bc7558f48830bc9c3ada7b6725b80ebdb'
    );
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).resolves.toEqual({ authorized: true });
  });

  it('rejects an old-producer operation when its exact workflow blob is not allowlisted', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(LEGACY_WORKFLOW_COMPATIBILITY_TEST_TIME);
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {}
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    mockGetWorkflowBlobIdentity.mockResolvedValue('f'.repeat(40));
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).rejects.toThrow('workflow content is not exactly allowlisted');
    expect(state.current().external_id).toBeNull();
  });

  it('fails closed when an old-producer run does not prove its stored dispatch ref', async () => {
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {}
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'another-ref',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).rejects.toThrow('workflow control identity');
    expect(state.current().external_id).toBeNull();
  });

  it('does not extend the missing-control-SHA bridge to strict operations', async () => {
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        inputs: {
          source_ref: 'release-bus-v2/staging-train-train-id-frontend',
          candidate_evidence_mode: 'strict-aggregate',
          aggregate_candidate_evidence_digest: '9'.repeat(64)
        }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headBranch: 'main',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
        artifact_digest: null,
        source_ref: 'release-bus-v2/staging-train-train-id-frontend',
        candidate_evidence_mode: 'strict-aggregate',
        aggregate_candidate_evidence_digest: '9'.repeat(64)
      })
    ).rejects.toThrow('workflow control identity');
    expect(mockResolveRef).not.toHaveBeenCalled();
  });

  it('binds strict preflight authorization to the exact dispatched source ref', async () => {
    const sourceRef = 'release-bus-v2/train-id/backend';
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        workflow_control_sha: 'c'.repeat(40),
        inputs: {
          source_ref: sourceRef,
          candidate_evidence_mode: 'strict-aggregate',
          aggregate_candidate_evidence_digest: '9'.repeat(64)
        }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    const service = new ReleaseBusV2Operations(state.repository as never);
    const input = {
      train_id: 'train-id',
      operation_key: 'rb2:train-id:prepare:frontend:a1',
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend' as const,
      environment: 'orchestration',
      service: null,
      expected_sha: 'a'.repeat(40),
      artifact_digest: null,
      source_ref: sourceRef,
      candidate_evidence_mode: 'strict-aggregate' as const,
      aggregate_candidate_evidence_digest: '9'.repeat(64)
    };

    await expect(
      service.authorize({ ...input, source_ref: 'main' })
    ).rejects.toThrow('source ref');
    await expect(
      service.authorize({ ...input, source_ref: null })
    ).rejects.toThrow('requires an exact source ref');
    await expect(service.authorize(input)).resolves.toEqual({
      authorized: true
    });
  });

  it('rejects a strict aggregate digest that is not the one stored by the control plane', async () => {
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        workflow_control_sha: 'c'.repeat(40),
        inputs: {
          candidate_evidence_mode: 'strict-aggregate',
          aggregate_candidate_evidence_digest: '9'.repeat(64)
        }
      }
    });
    const state = repositoryFor(initial);
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
        artifact_digest: null,
        candidate_evidence_mode: 'strict-aggregate',
        aggregate_candidate_evidence_digest: '8'.repeat(64)
      })
    ).rejects.toThrow('candidate evidence');
    expect(state.current().external_id).toBeNull();
  });

  it('binds strict-single authorization to the exact stored evidence artifact identity', async () => {
    const sourceRef = 'release-bus-v2/train-id/backend';
    const reuseArtifact = {
      runId: '54321',
      name: `release-bus-v2-pr-${'a'.repeat(40)}`,
      digest: '9'.repeat(64)
    };
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'DISPATCHED',
        request_json: {
          workflow: 'release-bus-v2-preflight.yml',
          ref: 'main',
          workflow_control_sha: 'c'.repeat(40),
          inputs: {
            source_ref: sourceRef,
            candidate_evidence_mode: 'strict-single',
            reuse_artifact_run_id: reuseArtifact.runId,
            reuse_artifact_name: reuseArtifact.name,
            reuse_artifact_digest: reuseArtifact.digest
          }
        }
      })
    );
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
        artifact_digest: null,
        source_ref: sourceRef,
        reuse_artifact_run_id: reuseArtifact.runId,
        reuse_artifact_name: reuseArtifact.name,
        reuse_artifact_digest: reuseArtifact.digest,
        candidate_evidence_mode: 'strict-single',
        aggregate_candidate_evidence_digest: null
      })
    ).resolves.toEqual({ authorized: true });
  });

  it.each([
    ['run ID', { reuse_artifact_run_id: '54322' }],
    ['name', { reuse_artifact_name: `release-bus-v2-pr-${'b'.repeat(40)}` }],
    ['digest', { reuse_artifact_digest: '8'.repeat(64) }]
  ])(
    'rejects a strict-single evidence artifact with a mismatched %s',
    async (_label, mismatch) => {
      const sourceRef = 'release-bus-v2/train-id/backend';
      const reuseArtifact = {
        runId: '54321',
        name: `release-bus-v2-pr-${'a'.repeat(40)}`,
        digest: '9'.repeat(64)
      };
      const state = repositoryFor(
        operation({
          external_id: null,
          status: 'DISPATCHED',
          request_json: {
            workflow: 'release-bus-v2-preflight.yml',
            ref: 'main',
            workflow_control_sha: 'c'.repeat(40),
            inputs: {
              source_ref: sourceRef,
              candidate_evidence_mode: 'strict-single',
              reuse_artifact_run_id: reuseArtifact.runId,
              reuse_artifact_name: reuseArtifact.name,
              reuse_artifact_digest: reuseArtifact.digest
            }
          }
        })
      );
      mockGetWorkflowRunIdentity.mockResolvedValue({
        actor: '6529-release-bus[bot]',
        event: 'workflow_dispatch',
        headSha: 'c'.repeat(40),
        path: '.github/workflows/release-bus-v2-preflight.yml',
        displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
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
          artifact_digest: null,
          source_ref: sourceRef,
          reuse_artifact_run_id: reuseArtifact.runId,
          reuse_artifact_name: reuseArtifact.name,
          reuse_artifact_digest: reuseArtifact.digest,
          candidate_evidence_mode: 'strict-single',
          aggregate_candidate_evidence_digest: null,
          ...mismatch
        })
      ).rejects.toThrow(/strict single authorization/i);
      expect(state.current().external_id).toBeNull();
    }
  );

  it('rejects a different workflow file or artifact source', async () => {
    const initial = operation({
      external_id: null,
      status: 'DISPATCHED',
      request_json: {
        workflow: 'release-bus-v2-preflight.yml',
        ref: 'main',
        workflow_control_sha: 'c'.repeat(40),
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
      artifact_digest: null,
      candidate_evidence_mode: null,
      aggregate_candidate_evidence_digest: null
    };
    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/another-workflow.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(service.authorize(input)).rejects.toThrow('identity');

    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: 'human-operator',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(service.authorize(input)).rejects.toThrow('identity');

    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml@refs/heads/old-main',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(service.authorize(input)).rejects.toThrow('identity');

    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'd'.repeat(40),
      path: '.github/workflows/release-bus-v2-preflight.yml@refs/heads/main',
      displayTitle: 'Preflight [rb2:train-id:prepare:frontend:a1]'
    });
    await expect(service.authorize(input)).rejects.toThrow('identity');

    mockGetWorkflowRunIdentity.mockResolvedValue({
      actor: '6529-release-bus[bot]',
      event: 'workflow_dispatch',
      headSha: 'c'.repeat(40),
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

  it('bounded-retries a failed artifact preparation whose terminal callback was not stored', async () => {
    const state = repositoryFor(operation());
    const service = new ReleaseBusV2Operations(state.repository as never);
    mockFindWorkflowRun.mockResolvedValue({
      id: 12345,
      status: 'completed',
      conclusion: 'failure'
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
      status: 'RETRY_WAIT',
      attempt: 1,
      external_id: '12345',
      failure_class: 'INFRASTRUCTURE',
      failure_message:
        'GitHub workflow concluded failure without a structured terminal callback',
      completed_at: null
    });
  });

  it('still fails closed when a mutating workflow omits its terminal callback', async () => {
    const state = repositoryFor(
      operation({
        idempotency_key: 'rb2:train-id:deploy:frontend',
        operation_type: 'DEPLOY_FRONTEND',
        environment: 'staging'
      })
    );
    const service = new ReleaseBusV2Operations(state.repository as never);
    mockFindWorkflowRun.mockResolvedValue({
      id: 12345,
      status: 'completed',
      conclusion: 'failure'
    });

    await service.reconcileWorkflow({
      idempotencyKey: 'rb2:train-id:deploy:frontend',
      trainId: 'train-id',
      operationType: 'DEPLOY_FRONTEND',
      repository: 'frontend',
      workflow: 'deploy-release-bus-v2.yml',
      ref: 'main',
      environment: 'staging',
      service: null,
      expectedSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
      inputs: {}
    });

    expect(state.current()).toMatchObject({
      status: 'FAILED',
      failure_class: 'CONTROL_PLANE',
      completed_at: expect.any(Number)
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
        artifact_digest: null,
        candidate_evidence_mode: null,
        aggregate_candidate_evidence_digest: null
      })
    ).rejects.toThrow('cannot authorize while FAILED');
    expect(mockGetWorkflowRunIdentity).not.toHaveBeenCalled();
  });

  it('discovers an uncertain dispatch before reusing the same attempt key', async () => {
    const state = repositoryFor(
      operation({
        external_id: null,
        status: 'PENDING',
        result_json: null,
        request_json: {
          workflow: 'release-bus-v2-preflight.yml',
          ref: 'release-bus-v2/staging-train-train-id-frontend',
          workflow_control_sha: 'c'.repeat(40),
          inputs: { train_id: 'train-id' },
          beta_infrastructure_failure_injection: null
        }
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
