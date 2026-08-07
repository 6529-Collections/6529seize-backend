import {
  ReleaseBusV2ProductionAuthorityService,
  type ReleaseBusV2ProductionAuthorityDependencies,
  type ReleaseBusV2ProductionAuthorityCompleteInput,
  type ReleaseBusV2ProductionAuthorityFailureInput
} from '@/releaseBusV2/release-bus-v2.production-authority';
import type { ReleaseBusV2LockRecord } from '@/releaseBusV2/release-bus-v2.repository';
import type { ReleaseBusV2ProductionAuthorityRecord } from '@/releaseBusV2/release-bus-v2.types';
import type { ReleaseBusWorkflowRunIdentity } from '@/releaseBusV2/release-bus-v2.github-app';
import {
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS,
  RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LEASE_TTL_MS
} from '@/releaseBusV2/release-bus-v2.config';

const TARGET_SHA = 'a'.repeat(40);
const SELECTION_DIGEST = 'b'.repeat(64);
const EVIDENCE_DIGEST = 'c'.repeat(64);
const OTHER_EVIDENCE_DIGEST = 'd'.repeat(64);

const DEPLOY_INPUT = {
  operation_id: 'frontend-prod-adversarial-1',
  controller_identity: 'frontend-production-workflow',
  repository: 'frontend' as const,
  environment: 'prod' as const,
  service: 'frontend',
  target_sha: TARGET_SHA,
  selection_digest: null,
  workflow_run_id: '101',
  workflow_run_attempt: 1
};

const COMPLETE_INPUT: ReleaseBusV2ProductionAuthorityCompleteInput = {
  ...DEPLOY_INPUT,
  selection_digest: SELECTION_DIGEST,
  qualifier_workflow_run_id: '202',
  qualifier_workflow_run_attempt: 2,
  evidence_digest: EVIDENCE_DIGEST
};

const BACKEND_DEPLOY_INPUT = {
  operation_id: 'backend-prod-adversarial-1',
  controller_identity: 'backend-production-workflow',
  repository: 'backend' as const,
  environment: 'prod' as const,
  service: 'api',
  target_sha: TARGET_SHA,
  selection_digest: null,
  workflow_run_id: '303',
  workflow_run_attempt: 4
};

const BACKEND_COMPLETE_INPUT: ReleaseBusV2ProductionAuthorityCompleteInput = {
  ...BACKEND_DEPLOY_INPUT,
  selection_digest: SELECTION_DIGEST,
  qualifier_workflow_run_id: BACKEND_DEPLOY_INPUT.workflow_run_id,
  qualifier_workflow_run_attempt: BACKEND_DEPLOY_INPUT.workflow_run_attempt,
  evidence_digest: EVIDENCE_DIGEST
};

function failureInput(
  selection_digest: string | null,
  overrides: Partial<ReleaseBusV2ProductionAuthorityFailureInput> = {}
): ReleaseBusV2ProductionAuthorityFailureInput {
  return {
    ...DEPLOY_INPUT,
    selection_digest,
    qualifier_workflow_run_id: DEPLOY_INPUT.workflow_run_id,
    qualifier_workflow_run_attempt: DEPLOY_INPUT.workflow_run_attempt,
    evidence_digest: EVIDENCE_DIGEST,
    reason_code: 'WORKFLOW_FAILED',
    ...overrides
  };
}

function deployIdentity(
  overrides: Partial<ReleaseBusWorkflowRunIdentity> = {}
): ReleaseBusWorkflowRunIdentity {
  return {
    actor: 'github-actions',
    attempt: DEPLOY_INPUT.workflow_run_attempt,
    conclusion: null,
    event: 'workflow_dispatch',
    repository: '6529-Collections/6529seize-frontend',
    headRepository: '6529-Collections/6529seize-frontend',
    headBranch: 'main',
    headSha: TARGET_SHA,
    // GitHub returns the evaluated run-name in both `name` and display_title.
    name: `Production deploy ${TARGET_SHA} [${DEPLOY_INPUT.operation_id}]`,
    path: '.github/workflows/build-upload-deploy-prod.yml',
    displayTitle: `Production deploy ${TARGET_SHA} [${DEPLOY_INPUT.operation_id}]`,
    status: 'in_progress',
    ...overrides
  };
}

function e2eIdentity(
  overrides: Partial<ReleaseBusWorkflowRunIdentity> = {}
): ReleaseBusWorkflowRunIdentity {
  return {
    actor: 'github-actions[bot]',
    attempt: COMPLETE_INPUT.qualifier_workflow_run_attempt,
    conclusion: 'success',
    event: 'workflow_dispatch',
    repository: '6529-Collections/6529seize-frontend',
    headRepository: '6529-Collections/6529seize-frontend',
    headBranch: 'main',
    headSha: TARGET_SHA,
    name: `Production E2E automatic ${DEPLOY_INPUT.workflow_run_id}`,
    path: '.github/workflows/production-e2e.yml',
    displayTitle: `Production E2E automatic ${DEPLOY_INPUT.workflow_run_id}`,
    status: 'completed',
    ...overrides
  };
}

function backendIdentity(
  overrides: Partial<ReleaseBusWorkflowRunIdentity> = {}
): ReleaseBusWorkflowRunIdentity {
  return {
    actor: 'github-actions',
    attempt: BACKEND_DEPLOY_INPUT.workflow_run_attempt,
    conclusion: 'success',
    event: 'workflow_dispatch',
    repository: '6529-Collections/6529seize-backend',
    headRepository: '6529-Collections/6529seize-backend',
    headBranch: 'main',
    headSha: TARGET_SHA,
    name: `Deploy ${BACKEND_DEPLOY_INPUT.service} to prod [${BACKEND_DEPLOY_INPUT.operation_id}]`,
    path: '.github/workflows/deploy.yml',
    displayTitle: `Deploy ${BACKEND_DEPLOY_INPUT.service} to prod [${BACKEND_DEPLOY_INPUT.operation_id}]`,
    status: 'completed',
    ...overrides
  };
}

function controlRecords(productionRowVersion = 2) {
  return [
    {
      scope: 'ALL' as const,
      paused: false,
      reason: null,
      github_actor: null,
      updated_at: 1,
      row_version: 1
    },
    {
      scope: 'STAGING' as const,
      paused: false,
      reason: null,
      github_actor: null,
      updated_at: 1,
      row_version: 1
    },
    {
      scope: 'PRODUCTION' as const,
      paused: true,
      reason: 'manual production lane',
      github_actor: null,
      updated_at: 1,
      row_version: productionRowVersion
    }
  ];
}

function clone<T>(value: T): T {
  return value && typeof value === 'object'
    ? ({ ...(value as Record<string, unknown>) } as T)
    : value;
}

function setup() {
  let now = 1_000_000;
  let authority: ReleaseBusV2ProductionAuthorityRecord | null = null;
  let lock: ReleaseBusV2LockRecord = {
    name: 'production-environment',
    owner_train_id: null,
    lease_owner: null,
    lease_token: null,
    heartbeat_at: null,
    expires_at: null,
    updated_at: now,
    row_version: 1
  };
  let nextLockToken = 1;
  let backendRunCompleted = false;
  let productionRowVersion = 2;

  let deployRunIdentity = deployIdentity();
  const deps: ReleaseBusV2ProductionAuthorityDependencies = {
    repository: {
      executeNativeQueriesInTransaction: async (
        callback: (connection: { connection: unknown }) => Promise<unknown>
      ) => callback({ connection: {} }),
      findProductionAuthority: jest.fn(async (operationId: string) =>
        authority?.operation_id === operationId ? clone(authority) : null
      ),
      findProductionAuthorityById: jest.fn(async (id: string) =>
        authority?.id === id ? clone(authority) : null
      ),
      createProductionAuthority: jest.fn(async (input) => {
        authority = {
          ...input,
          created_at: now,
          updated_at: now,
          row_version: 1
        };
        return clone(authority);
      }),
      updateProductionAuthority: jest.fn(async (id, rowVersion, fields) => {
        if (
          !authority ||
          authority.id !== id ||
          authority.row_version !== rowVersion
        )
          return false;
        authority = {
          ...authority,
          ...fields,
          updated_at: now,
          row_version: rowVersion + 1
        };
        return true;
      }),
      acquireLock: jest.fn(async (_name, _ownerTrainId, leaseOwner, ttlMs) => {
        if (lock.lease_token && (lock.expires_at ?? 0) >= now) return null;
        lock = {
          ...lock,
          lease_owner: leaseOwner,
          lease_token: `server-token-${nextLockToken++}`,
          heartbeat_at: now,
          expires_at: now + ttlMs,
          updated_at: now,
          row_version: lock.row_version + 1
        };
        return clone(lock);
      }),
      renewLock: jest.fn(async (_name, leaseOwner, leaseToken, expiresAt) => {
        if (
          lock.lease_owner !== leaseOwner ||
          lock.lease_token !== leaseToken ||
          (lock.expires_at ?? 0) < now
        )
          return null;
        lock = {
          ...lock,
          heartbeat_at: now,
          expires_at: expiresAt,
          updated_at: now,
          row_version: lock.row_version + 1
        };
        return clone(lock);
      }),
      releaseLock: jest.fn(async (_name, leaseToken) => {
        if (lock.lease_token !== leaseToken) return false;
        lock = {
          ...lock,
          lease_owner: null,
          lease_token: null,
          heartbeat_at: null,
          expires_at: null,
          updated_at: now,
          row_version: lock.row_version + 1
        };
        return true;
      }),
      listControls: jest.fn(async () => controlRecords(productionRowVersion)),
      listLocks: jest.fn(async () => [clone(lock)]),
      listActiveTrains: jest.fn(async () => []),
      listNonterminalOperationsForLanes: jest.fn(async () => [])
    } as unknown as ReleaseBusV2ProductionAuthorityDependencies['repository'],
    getMode: () => 'PRODUCTION',
    listControls: jest.fn(async () => controlRecords(productionRowVersion)),
    listLocks: jest.fn(async () => [clone(lock)]),
    listActiveTrains: jest.fn(async () => []),
    listNonterminalOperationsForLanes: jest.fn(async () => []),
    getWorkflowRunIdentity: jest.fn(async (repository, runId) => {
      if (repository === 'backend')
        return backendIdentity(
          backendRunCompleted ? {} : { status: 'in_progress', conclusion: null }
        );
      return runId === COMPLETE_INPUT.qualifier_workflow_run_id
        ? e2eIdentity()
        : deployRunIdentity;
    }),
    getProductionE2EWorkflowRunIdentity: jest.fn(async (repository, runId) => {
      if (repository !== 'frontend')
        throw new Error('Production E2E requires frontend');
      return (deps.getWorkflowRunIdentity as jest.Mock)(repository, runId);
    }),
    resolveRef: jest.fn(async () => TARGET_SHA),
    refContainsCommit: jest.fn(async () => true),
    hasActiveProductionMutationOrE2ERun: jest.fn(async () => false),
    isOrganizationOperator: jest.fn(async () => true),
    now: () => now
  };

  return {
    service: new ReleaseBusV2ProductionAuthorityService(deps),
    deps,
    getAuthority: () => clone(authority),
    getLock: () => clone(lock),
    setNow: (value: number) => {
      now = value;
    },
    setProductionEpoch: (value: number) => {
      productionRowVersion = value;
    },
    setDeployIdentity: (identity: ReleaseBusWorkflowRunIdentity) => {
      deployRunIdentity = identity;
      (deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
        async (repository: string, runId: string) => {
          if (repository === 'backend')
            return backendIdentity(
              backendRunCompleted
                ? {}
                : { status: 'in_progress', conclusion: null }
            );
          return runId === COMPLETE_INPUT.qualifier_workflow_run_id
            ? e2eIdentity()
            : deployRunIdentity;
        }
      );
    },
    setDeployCompleted: () => {
      deployRunIdentity = deployIdentity({
        status: 'completed',
        conclusion: 'success'
      });
    },
    setDeployFailed: (conclusion: 'failure' | 'cancelled' = 'failure') => {
      deployRunIdentity = deployIdentity({
        status: 'completed',
        conclusion
      });
    },
    setBackendCompleted: () => {
      backendRunCompleted = true;
      (deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
        async (repository: string, runId: string) => {
          if (repository === 'backend') return backendIdentity();
          return runId === COMPLETE_INPUT.qualifier_workflow_run_id
            ? e2eIdentity()
            : deployRunIdentity;
        }
      );
    }
  };
}

describe('Release Bus v2 production authority adversarial boundaries', () => {
  it('acquires the shared lane while ignoring only the independently verified self run', async () => {
    const { service, deps, getAuthority, getLock } = setup();

    const result = await service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });

    expect(result).toMatchObject({
      operation_id: DEPLOY_INPUT.operation_id,
      status: 'BOUND',
      bound: true,
      authorized: true
    });
    expect(result).not.toHaveProperty('lease_token');
    expect(deps.hasActiveProductionMutationOrE2ERun).toHaveBeenNthCalledWith(
      1,
      'backend',
      []
    );
    expect(deps.hasActiveProductionMutationOrE2ERun).toHaveBeenNthCalledWith(
      2,
      'frontend',
      [DEPLOY_INPUT.workflow_run_id]
    );
    expect(getAuthority()).toMatchObject({
      status: 'BOUND',
      workflow_run_id: DEPLOY_INPUT.workflow_run_id,
      selection_digest: null,
      lease_token: 'server-token-1'
    });
    expect(getLock()).toMatchObject({ lease_token: 'server-token-1' });
  });

  it('reuses an exact bound acquisition without depending on a fresh GitHub read', async () => {
    const { service, deps } = setup();
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });
    const githubIdentity = deps.getWorkflowRunIdentity as jest.Mock;
    githubIdentity.mockClear();
    githubIdentity.mockRejectedValue(new Error('GitHub unavailable'));

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).resolves.toMatchObject({
      status: 'BOUND',
      authorized: true,
      reused: true
    });
    expect(githubIdentity).not.toHaveBeenCalled();
  });

  it('rejects a foreign workflow instead of granting it an ignored-run hole', async () => {
    const { service, deps, setDeployIdentity, getAuthority } = setup();
    setDeployIdentity(
      deployIdentity({
        path: '.github/workflows/production-e2e.yml',
        name: 'Production E2E foreign run',
        displayTitle: 'Production E2E foreign run'
      })
    );

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(deps.hasActiveProductionMutationOrE2ERun).not.toHaveBeenCalled();
    expect(getAuthority()).toBeNull();
  });

  it('rejects a frontend deploy whose title is not bound to its target and operation', async () => {
    const { service, deps, setDeployIdentity, getAuthority } = setup();
    setDeployIdentity(deployIdentity({ displayTitle: 'Web Deploy - PROD' }));

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(deps.hasActiveProductionMutationOrE2ERun).not.toHaveBeenCalled();
    expect(getAuthority()).toBeNull();
  });

  it('ignores a stale frontend workflow name when path and evaluated title are exact', async () => {
    const { service, setDeployIdentity } = setup();
    const identity = deployIdentity({ name: 'Web Deploy - PROD' });
    expect(identity.name).not.toBe(identity.displayTitle);
    setDeployIdentity(identity);

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).resolves.toMatchObject({
      status: 'BOUND',
      authorized: true,
      workflow_run_id: DEPLOY_INPUT.workflow_run_id
    });
  });

  it('ignores a stale backend workflow name when path and evaluated title are exact', async () => {
    const setupState = setup();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockResolvedValue(
      backendIdentity({
        name: 'Deploy a service',
        status: 'in_progress',
        conclusion: null
      })
    );

    await expect(
      setupState.service.prepareAndBind({
        ...BACKEND_DEPLOY_INPUT,
        selection_digest: null
      })
    ).resolves.toMatchObject({
      status: 'BOUND',
      authorized: true,
      workflow_run_id: BACKEND_DEPLOY_INPUT.workflow_run_id
    });
  });

  it('rejects a deploy actor who is not an organization operator', async () => {
    const { service, deps, getAuthority } = setup();
    (deps.isOrganizationOperator as jest.Mock).mockResolvedValue(false);

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(getAuthority()).toBeNull();
    expect(deps.hasActiveProductionMutationOrE2ERun).not.toHaveBeenCalled();
  });

  it('checks database denials before querying GitHub active-run state', async () => {
    const { service, deps } = setup();
    (deps.listActiveTrains as jest.Mock).mockResolvedValue([
      { lane: 'PRODUCTION' }
    ]);

    await expect(
      service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null })
    ).resolves.toMatchObject({
      status: 'DENIED',
      authorized: false,
      reason_code: 'ACTIVE_TRAIN'
    });
    expect(deps.hasActiveProductionMutationOrE2ERun).not.toHaveBeenCalled();
  });

  it('does not allow prepare or acquire-bind to freeze selection early', async () => {
    const { service } = setup();

    await expect(
      service.prepare({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      } as never)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'SELECTION_DIGEST_MISMATCH'
    });
    await expect(
      service.prepareAndBind({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      } as never)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'SELECTION_DIGEST_MISMATCH'
    });
  });

  it('rejects deploy-only completion before releasing the production lock', async () => {
    const { service, getAuthority, getLock } = setup();
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });
    await service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });

    await expect(
      service.complete({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      } as unknown as ReleaseBusV2ProductionAuthorityCompleteInput)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'EVIDENCE_DIGEST_MISMATCH'
    });
    expect(getAuthority()).toMatchObject({ status: 'BOUND' });
    expect(getLock()).toMatchObject({ lease_token: 'server-token-1' });
  });

  it('denies completion when the control epoch changes inside the terminal transaction', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployCompleted();
    setupState.setProductionEpoch(3);

    await expect(
      setupState.service.complete(COMPLETE_INPUT)
    ).resolves.toMatchObject({
      status: 'DENIED',
      completed: false,
      reason_code: 'CONTROL_EPOCH_CHANGED'
    });
    expect(setupState.getAuthority()).toMatchObject({
      status: 'DENIED',
      denial_code: 'CONTROL_EPOCH_CHANGED',
      lease_token: null
    });
    expect(setupState.getLock()).toMatchObject({ lease_token: null });
  });

  it('allows the owning controller to fail before selection discovery and releases its lease', async () => {
    const setupState = setup();
    const { service, deps, getAuthority, getLock } = setupState;
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });
    setupState.setDeployFailed();

    const result = await service.fail(failureInput(null));

    expect(result).toMatchObject({ status: 'FAILED', failed: true });
    expect(getAuthority()).toMatchObject({
      status: 'FAILED',
      selection_digest: null,
      lease_token: null
    });
    expect(getLock()).toMatchObject({ lease_token: null });
    const githubIdentity = deps.getWorkflowRunIdentity as jest.Mock;
    githubIdentity.mockClear();
    githubIdentity.mockRejectedValue(new Error('GitHub unavailable'));
    await expect(service.fail(failureInput(null))).resolves.toMatchObject({
      status: 'FAILED',
      failed: true,
      reused: true
    });
    expect(githubIdentity).not.toHaveBeenCalled();
  });

  it('accepts the exact candidate digest when reauthorization may have committed ambiguously', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployFailed();

    await expect(
      setupState.service.fail(failureInput(SELECTION_DIGEST))
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
    expect(setupState.getAuthority()).toMatchObject({
      status: 'FAILED',
      selection_digest: null,
      evidence_digest: EVIDENCE_DIGEST
    });
  });

  it('rejects an in-progress failure callback without terminal GitHub evidence', async () => {
    const { service, getAuthority, getLock } = setup();
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });

    await expect(service.fail(failureInput(null))).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(getAuthority()).toMatchObject({ status: 'BOUND' });
    expect(getLock()).toMatchObject({ lease_token: 'server-token-1' });
  });

  it('accepts an exact terminal failed frontend deployment as failure evidence', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployFailed();

    await expect(
      setupState.service.fail(failureInput(null))
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
  });

  it('accepts an exact terminal failed backend deployment as failure evidence', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setBackendCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockResolvedValue(
      backendIdentity({ conclusion: 'failure' })
    );

    await expect(
      setupState.service.fail({
        ...BACKEND_DEPLOY_INPUT,
        selection_digest: null,
        qualifier_workflow_run_id: BACKEND_DEPLOY_INPUT.workflow_run_id,
        qualifier_workflow_run_attempt:
          BACKEND_DEPLOY_INPUT.workflow_run_attempt,
        evidence_digest: EVIDENCE_DIGEST,
        reason_code: 'WORKFLOW_FAILED'
      })
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
  });

  it('accepts a failed automatic frontend E2E only after a successful bound deployment', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ name: 'Production E2E', conclusion: 'failure' })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.fail(
        failureInput(null, {
          qualifier_workflow_run_id: COMPLETE_INPUT.qualifier_workflow_run_id,
          qualifier_workflow_run_attempt:
            COMPLETE_INPUT.qualifier_workflow_run_attempt
        })
      )
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
  });

  it('accepts a failed automatic E2E from a later protected-main SHA', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ conclusion: 'failure', headSha: 'e'.repeat(40) })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.fail(
        failureInput(null, {
          qualifier_workflow_run_id: COMPLETE_INPUT.qualifier_workflow_run_id,
          qualifier_workflow_run_attempt:
            COMPLETE_INPUT.qualifier_workflow_run_attempt
        })
      )
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
  });

  it('rejects a human-dispatched automatic-looking E2E failure', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ actor: 'developer', conclusion: 'failure' })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.fail(
        failureInput(null, {
          qualifier_workflow_run_id: COMPLETE_INPUT.qualifier_workflow_run_id,
          qualifier_workflow_run_attempt:
            COMPLETE_INPUT.qualifier_workflow_run_attempt
        })
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it('rejects a failed automatic E2E when the bound deployment is not successful', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    setupState.setDeployFailed();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ conclusion: 'failure' })
          : deployIdentity({ status: 'completed', conclusion: 'failure' })
    );

    await expect(
      setupState.service.fail(
        failureInput(null, {
          qualifier_workflow_run_id: COMPLETE_INPUT.qualifier_workflow_run_id,
          qualifier_workflow_run_attempt:
            COMPLETE_INPUT.qualifier_workflow_run_attempt
        })
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it('rejects a null failure selection after the selection has been frozen', async () => {
    const setupState = setup();
    const { service, getAuthority, getLock } = setupState;
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });
    await service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployFailed();

    await expect(service.fail(failureInput(null))).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'SELECTION_DIGEST_MISMATCH'
    });
    expect(getAuthority()).toMatchObject({ status: 'BOUND' });
    expect(getLock()).toMatchObject({ lease_token: 'server-token-1' });
  });

  it('rejects a wrong non-null failure selection and accepts the exact selected digest', async () => {
    const wrongSelectionState = setup();
    await wrongSelectionState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await wrongSelectionState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    wrongSelectionState.setDeployFailed();
    await expect(
      wrongSelectionState.service.fail(failureInput(OTHER_EVIDENCE_DIGEST))
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'SELECTION_DIGEST_MISMATCH'
    });

    const exactState = setup();
    await exactState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await exactState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    exactState.setDeployFailed();
    await expect(
      exactState.service.fail(failureInput(SELECTION_DIGEST))
    ).resolves.toMatchObject({ status: 'FAILED', failed: true });
  });

  it('rejects an unrelated owner from failing the bound operation', async () => {
    const { service, getAuthority, getLock } = setup();
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });

    await expect(
      service.fail(failureInput(null, { controller_identity: 'deploy-hub' }))
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'OWNER_MISMATCH'
    });
    expect(getAuthority()).toMatchObject({ status: 'BOUND' });
    expect(getLock()).toMatchObject({ lease_token: 'server-token-1' });
  });

  it('keeps the authority live through the qualification window and expires at the hard cap', async () => {
    const setupState = setup();
    const initial = 1_000_000;
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    expect(setupState.getLock().expires_at).toBe(
      initial + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_LEASE_TTL_MS
    );

    // Reauthorization immediately before AWS follows the 22-minute deploy
    // readiness ceiling. The 130-minute renewal then covers the configured
    // 90-minute Production E2E timeout plus bounded callback headroom.
    setupState.setNow(initial + 22 * 60 * 1000);
    await expect(
      setupState.service.reauthorize({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      })
    ).resolves.toMatchObject({ authorized: true, status: 'BOUND' });
    expect(setupState.getLock().lease_token).toBe('server-token-1');
    expect(setupState.getLock().expires_at).toBe(
      initial + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS
    );

    setupState.setNow(initial + (22 + 90) * 60 * 1000);
    await expect(
      setupState.service.reauthorize({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      })
    ).resolves.toMatchObject({ authorized: true, status: 'BOUND' });
    expect(setupState.getLock().expires_at).toBe(
      initial + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS
    );

    setupState.setNow(
      initial + RELEASE_BUS_V2_PRODUCTION_AUTHORITY_HARD_TTL_MS
    );
    await expect(
      setupState.service.reauthorize({
        ...DEPLOY_INPUT,
        selection_digest: SELECTION_DIGEST
      })
    ).resolves.toMatchObject({
      authorized: false,
      status: 'EXPIRED',
      reason_code: 'HARD_TTL_EXPIRED'
    });
    expect(setupState.getLock().lease_token).toBeNull();
  });

  it.each([
    ['wrong E2E path', { path: '.github/workflows/deploy.yml' }],
    ['wrong E2E attempt', { attempt: 3 }],
    ['human E2E actor', { actor: 'developer' }]
  ] as const)('rejects %s before completion', async (_label, override) => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployCompleted();
    const e2eOverride = override as Partial<ReleaseBusWorkflowRunIdentity>;
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity(e2eOverride)
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.complete(COMPLETE_INPUT)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it('rejects an unrelated successful Production E2E run with a different deploy title', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ displayTitle: 'Production E2E automatic 999' })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.complete(COMPLETE_INPUT)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it('accepts a frontend Production E2E run from a later protected-main SHA', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (repository: string, runId: string) =>
        repository === 'frontend' &&
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ headSha: 'e'.repeat(40) })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    await expect(
      setupState.service.complete(COMPLETE_INPUT)
    ).resolves.toMatchObject({ status: 'COMPLETED', completed: true });
  });

  it('accepts the exact deploy-bound E2E title, persists evidence, and releases the lock', async () => {
    const setupState = setup();
    const { service, deps, getAuthority, getLock } = setupState;
    await service.prepareAndBind({ ...DEPLOY_INPUT, selection_digest: null });
    await service.reauthorize({
      ...DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setDeployCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockImplementation(
      async (_repository: string, runId: string) =>
        runId === COMPLETE_INPUT.qualifier_workflow_run_id
          ? e2eIdentity({ name: 'Production E2E' })
          : deployIdentity({ status: 'completed', conclusion: 'success' })
    );

    const result = await service.complete(COMPLETE_INPUT);
    expect(result).toMatchObject({
      operation_id: DEPLOY_INPUT.operation_id,
      status: 'COMPLETED',
      completed: true
    });
    expect(getAuthority()).toMatchObject({
      status: 'COMPLETED',
      selection_digest: SELECTION_DIGEST,
      qualifier_workflow_run_id: COMPLETE_INPUT.qualifier_workflow_run_id,
      qualifier_workflow_run_attempt:
        COMPLETE_INPUT.qualifier_workflow_run_attempt,
      evidence_digest: EVIDENCE_DIGEST,
      lease_token: null
    });
    expect(getLock()).toMatchObject({ lease_token: null });
    expect(deps.getProductionE2EWorkflowRunIdentity).toHaveBeenCalledWith(
      'frontend',
      COMPLETE_INPUT.qualifier_workflow_run_id
    );

    await expect(
      service.complete({
        ...COMPLETE_INPUT,
        evidence_digest: OTHER_EVIDENCE_DIGEST
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'EVIDENCE_DIGEST_MISMATCH'
    });
    const githubIdentity = deps.getWorkflowRunIdentity as jest.Mock;
    githubIdentity.mockClear();
    githubIdentity.mockRejectedValue(new Error('GitHub unavailable'));
    const retry = await service.complete(COMPLETE_INPUT);
    expect(retry).toMatchObject({
      status: 'COMPLETED',
      completed: true,
      reused: true
    });
    expect(githubIdentity).not.toHaveBeenCalled();
  });

  it('requires backend completion from the exact successful deploy run', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setBackendCompleted();

    await expect(
      setupState.service.complete({
        ...BACKEND_COMPLETE_INPUT,
        qualifier_workflow_run_id: '404'
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'QUALIFIER_WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it.each([
    [
      'wrong backend qualifier title',
      { displayTitle: 'Deploy other to prod [manual]' }
    ],
    ['wrong backend qualifier path', { path: '.github/workflows/other.yml' }],
    [
      'wrong backend qualifier repository',
      { headRepository: '6529-Collections/other' }
    ],
    ['wrong backend qualifier attempt', { attempt: 5 }],
    ['wrong backend qualifier SHA', { headSha: 'f'.repeat(40) }]
  ] as const)('rejects %s', async (_label, override) => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setBackendCompleted();
    (setupState.deps.getWorkflowRunIdentity as jest.Mock).mockResolvedValue(
      backendIdentity(override)
    );

    await expect(
      setupState.service.complete(BACKEND_COMPLETE_INPUT)
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason_code: 'WORKFLOW_IDENTITY_MISMATCH'
    });
    expect(setupState.getAuthority()).toMatchObject({ status: 'BOUND' });
  });

  it('accepts exact backend deploy completion and persists the evidence digest', async () => {
    const setupState = setup();
    await setupState.service.prepareAndBind({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: null
    });
    await setupState.service.reauthorize({
      ...BACKEND_DEPLOY_INPUT,
      selection_digest: SELECTION_DIGEST
    });
    setupState.setBackendCompleted();

    await expect(
      setupState.service.complete(BACKEND_COMPLETE_INPUT)
    ).resolves.toMatchObject({
      operation_id: BACKEND_DEPLOY_INPUT.operation_id,
      status: 'COMPLETED',
      completed: true
    });
    expect(setupState.getAuthority()).toMatchObject({
      status: 'COMPLETED',
      qualifier_workflow_run_id: BACKEND_DEPLOY_INPUT.workflow_run_id,
      qualifier_workflow_run_attempt: BACKEND_DEPLOY_INPUT.workflow_run_attempt,
      evidence_digest: EVIDENCE_DIGEST,
      lease_token: null
    });
    expect(setupState.getLock()).toMatchObject({ lease_token: null });
  });
});
