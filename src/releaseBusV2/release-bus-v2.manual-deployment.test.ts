import {
  ReleaseBusV2ManualDeploymentError,
  ReleaseBusV2ManualDeploymentGuard,
  type ReleaseBusV2ManualDeploymentAuthorizationInput,
  type ReleaseBusV2ManualDeploymentDependencies
} from '@/releaseBusV2/release-bus-v2.manual-deployment';

const SHA = 'a'.repeat(40);

function controls(pausedLane: 'STAGING' | 'PRODUCTION') {
  return [
    { scope: 'ALL', paused: false, reason: null },
    {
      scope: 'STAGING',
      paused: pausedLane === 'STAGING',
      reason: pausedLane === 'STAGING' ? 'manual staging fallback' : null
    },
    {
      scope: 'PRODUCTION',
      paused: pausedLane === 'PRODUCTION',
      reason: pausedLane === 'PRODUCTION' ? 'manual production fallback' : null
    }
  ] as never;
}

function locks(
  held: 'staging-environment' | 'production-environment' | null = null
) {
  return ['scheduler', 'staging-environment', 'production-environment'].map(
    (name) => ({
      name,
      owner_train_id: name === held ? 'other-train' : null,
      lease_owner: name === held ? 'other-owner' : null,
      lease_token: name === held ? 'other-token' : null,
      heartbeat_at: name === held ? 1 : null,
      expires_at: name === held ? Date.now() + 60_000 : null,
      updated_at: 1,
      row_version: 1
    })
  );
}

function input(
  overrides: Partial<ReleaseBusV2ManualDeploymentAuthorizationInput> = {}
): ReleaseBusV2ManualDeploymentAuthorizationInput {
  const environment = overrides.environment ?? 'staging';
  return {
    repository: 'backend',
    environment,
    service: 'api',
    workflow_run_id: '12345',
    workflow_run_attempt: 2,
    source_ref: environment === 'staging' ? '1a-staging' : 'main',
    source_sha: SHA,
    ...overrides
  };
}

function identity(
  value: ReleaseBusV2ManualDeploymentAuthorizationInput = input()
) {
  if (value.repository === 'frontend') {
    const staging = value.environment === 'staging';
    return {
      actor: 'operator',
      attempt: value.workflow_run_attempt,
      conclusion: null,
      event: staging ? 'push' : 'workflow_dispatch',
      headBranch: value.source_ref,
      headSha: value.source_sha,
      name: staging ? 'Web Deploy - STAGING' : 'Web Deploy - PROD',
      path: staging
        ? '.github/workflows/deploy-staging.yml'
        : '.github/workflows/build-upload-deploy-prod.yml',
      displayTitle: staging ? 'Promote exact staging ref' : 'Web Deploy - PROD',
      status: 'in_progress'
    };
  }
  return {
    actor: 'operator',
    attempt: value.workflow_run_attempt,
    conclusion: null,
    event: 'workflow_dispatch',
    headBranch: value.source_ref,
    headSha: value.source_sha,
    name: 'Deploy a service',
    path: '.github/workflows/deploy.yml',
    displayTitle: `Deploy ${value.service} to ${value.environment} [manual]`,
    status: 'in_progress'
  };
}

function setup(pausedLane: 'STAGING' | 'PRODUCTION' = 'STAGING'): {
  readonly guard: ReleaseBusV2ManualDeploymentGuard;
  readonly deps: jest.Mocked<ReleaseBusV2ManualDeploymentDependencies>;
} {
  const deps: jest.Mocked<ReleaseBusV2ManualDeploymentDependencies> = {
    getMode: jest.fn().mockReturnValue('PRODUCTION'),
    listControls: jest.fn().mockResolvedValue(controls(pausedLane)),
    listLocks: jest.fn().mockResolvedValue(locks()),
    listActiveTrains: jest.fn().mockResolvedValue([]),
    listNonterminalOperationsForLanes: jest.fn().mockResolvedValue([]),
    getWorkflowRunIdentity: jest
      .fn()
      .mockImplementation(async () => identity()),
    resolveRef: jest.fn().mockResolvedValue(SHA),
    hasActiveStagingMutationOrE2ERun: jest.fn().mockResolvedValue(false),
    hasActiveProductionMutationOrE2ERun: jest.fn().mockResolvedValue(false)
  };
  return {
    guard: new ReleaseBusV2ManualDeploymentGuard(deps),
    deps
  };
}

describe('ReleaseBusV2ManualDeploymentGuard', () => {
  it.each([
    ['api', 'staging', 'PRODUCTION'],
    ['releaseBus', 'prod', 'STAGING']
  ] as const)(
    'rejects manual %s deployment while the lane is ON without exemptions',
    async (service, environment, pausedLane) => {
      const { guard, deps } = setup(pausedLane);
      deps.getWorkflowRunIdentity.mockResolvedValue(
        identity(input({ service, environment }))
      );

      await expect(
        guard.authorizeWorkflow(input({ service, environment }))
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringContaining(
          `independently paused ${
            environment === 'staging' ? 'STAGING' : 'PRODUCTION'
          } lane`
        )
      });
      expect(deps.listLocks).not.toHaveBeenCalled();
      expect(deps.listNonterminalOperationsForLanes).not.toHaveBeenCalled();
    }
  );

  it('authorizes an exact backend run only for an OFF and changeable lane', async () => {
    const { guard, deps } = setup('STAGING');

    await expect(guard.authorizeWorkflow(input())).resolves.toEqual({
      ready: true,
      mode: 'manual',
      lane: 'STAGING',
      ...input()
    });
    expect(deps.getWorkflowRunIdentity).toHaveBeenCalledWith(
      'backend',
      '12345'
    );
    expect(deps.resolveRef).toHaveBeenCalledWith('backend', '1a-staging');
    expect(deps.hasActiveStagingMutationOrE2ERun).toHaveBeenCalledWith(
      'backend',
      ['12345']
    );
    expect(deps.hasActiveStagingMutationOrE2ERun).toHaveBeenCalledWith(
      'frontend',
      []
    );
  });

  it('keeps inverse staging and production manual fallback decisions independent', async () => {
    const stagingOn = setup('PRODUCTION');
    const productionFallback = input({ environment: 'prod' });
    stagingOn.deps.getWorkflowRunIdentity.mockResolvedValue(
      identity(productionFallback)
    );
    await expect(
      stagingOn.guard.authorizeWorkflow(productionFallback)
    ).resolves.toMatchObject({ ready: true, lane: 'PRODUCTION' });

    stagingOn.deps.getWorkflowRunIdentity.mockResolvedValue(identity());
    await expect(
      stagingOn.guard.authorizeWorkflow(input())
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const productionOn = setup('STAGING');
    await expect(
      productionOn.guard.authorizeWorkflow(input())
    ).resolves.toMatchObject({ ready: true, lane: 'STAGING' });
    const productionRequest = input({ environment: 'prod' });
    productionOn.deps.getWorkflowRunIdentity.mockResolvedValue(
      identity(productionRequest)
    );
    await expect(
      productionOn.guard.authorizeWorkflow(productionRequest)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('treats raw OFF and the ALL control as hidden hard-stop fences', async () => {
    const rawOff = setup('STAGING');
    rawOff.deps.getMode.mockReturnValue('OFF');
    await expect(rawOff.guard.authorizeWorkflow(input())).rejects.toMatchObject(
      { code: 'CONFLICT' }
    );

    const allPaused = setup('STAGING');
    allPaused.deps.listControls.mockResolvedValue([
      { scope: 'ALL', paused: true, reason: 'hard stop' },
      { scope: 'STAGING', paused: true, reason: 'manual fallback' },
      { scope: 'PRODUCTION', paused: false, reason: null }
    ] as never);
    await expect(
      allPaused.guard.authorizeWorkflow(input())
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('drains the target environment across repositories and all target-lane operations', async () => {
    const activeFrontend = setup('STAGING');
    activeFrontend.deps.hasActiveStagingMutationOrE2ERun.mockImplementation(
      async (repository) => repository === 'frontend'
    );
    await expect(
      activeFrontend.guard.authorizeWorkflow(input())
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('active mutation or E2E')
    });

    const activeOperation = setup('STAGING');
    activeOperation.deps.listNonterminalOperationsForLanes.mockResolvedValue([
      { id: 'operation' }
    ] as never);
    await expect(
      activeOperation.guard.authorizeWorkflow(input())
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('nonterminal operation')
    });
    expect(
      activeOperation.deps.listNonterminalOperationsForLanes
    ).toHaveBeenCalledWith(['STAGING', 'PRODUCTION_QUALIFICATION']);

    const heldLock = setup('STAGING');
    heldLock.deps.listLocks.mockResolvedValue(locks('staging-environment'));
    await expect(
      heldLock.guard.authorizeWorkflow(input())
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('environment lock is held')
    });
  });

  it('does not let production state block or rewrite staging readiness', async () => {
    const { guard, deps } = setup('STAGING');
    deps.listLocks.mockResolvedValue(locks('production-environment'));
    deps.listActiveTrains.mockResolvedValue([
      { id: 'production-train', lane: 'PRODUCTION' }
    ] as never);

    await expect(guard.authorizeWorkflow(input())).resolves.toMatchObject({
      ready: true,
      lane: 'STAGING'
    });
    expect(deps.hasActiveProductionMutationOrE2ERun).not.toHaveBeenCalled();
  });

  it('does not let staging state block or rewrite production readiness', async () => {
    const productionInput = input({
      environment: 'prod',
      source_ref: 'main'
    });
    const { guard, deps } = setup('PRODUCTION');
    deps.getWorkflowRunIdentity.mockResolvedValue(identity(productionInput));
    deps.listLocks.mockResolvedValue(locks('staging-environment'));
    deps.listActiveTrains.mockResolvedValue([
      { id: 'staging-train', lane: 'STAGING' }
    ] as never);

    await expect(
      guard.authorizeWorkflow(productionInput)
    ).resolves.toMatchObject({
      ready: true,
      lane: 'PRODUCTION'
    });
    expect(deps.hasActiveStagingMutationOrE2ERun).not.toHaveBeenCalled();
    expect(deps.listNonterminalOperationsForLanes).toHaveBeenCalledWith([
      'PRODUCTION'
    ]);
  });

  it('accepts exact frontend staging and production workflow identities', async () => {
    for (const frontendInput of [
      input({
        repository: 'frontend',
        environment: 'staging',
        service: 'frontend',
        source_ref: '1a-staging'
      }),
      input({
        repository: 'frontend',
        environment: 'prod',
        service: 'frontend',
        source_ref: 'main'
      })
    ]) {
      const pausedLane =
        frontendInput.environment === 'staging' ? 'STAGING' : 'PRODUCTION';
      const { guard, deps } = setup(pausedLane);
      deps.getWorkflowRunIdentity.mockResolvedValue(identity(frontendInput));
      await expect(
        guard.authorizeWorkflow(frontendInput)
      ).resolves.toMatchObject({
        ready: true,
        repository: 'frontend',
        environment: frontendInput.environment
      });
    }
  });

  it('rejects a mismatched current attempt before excluding the run', async () => {
    const { guard, deps } = setup('STAGING');
    deps.getWorkflowRunIdentity.mockResolvedValue({
      ...identity(),
      attempt: 3
    });

    await expect(guard.authorizeWorkflow(input())).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('does not match')
    });
    expect(deps.listControls).not.toHaveBeenCalled();
    expect(deps.hasActiveStagingMutationOrE2ERun).not.toHaveBeenCalled();
  });

  it('rejects a stale dispatch SHA before lane or mutation checks', async () => {
    const { guard, deps } = setup('STAGING');
    deps.resolveRef.mockResolvedValue('b'.repeat(40));

    await expect(guard.authorizeWorkflow(input())).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('exact current 1a-staging head')
    });
    expect(deps.listControls).not.toHaveBeenCalled();
    expect(deps.listLocks).not.toHaveBeenCalled();
  });

  it('rejects backend manual dispatches from a non-target ref', async () => {
    const wrongRef = input({ source_ref: 'feature/not-the-target' });
    const { guard, deps } = setup('STAGING');
    deps.getWorkflowRunIdentity.mockResolvedValue(identity(wrongRef));

    await expect(guard.authorizeWorkflow(wrongRef)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('does not match')
    });
    expect(deps.resolveRef).not.toHaveBeenCalled();
    expect(deps.listControls).not.toHaveBeenCalled();
  });

  it('fails closed when controls, locks, GitHub, or operation state is unavailable', async () => {
    const { guard, deps } = setup('STAGING');
    deps.listLocks.mockRejectedValue(new Error('database unavailable'));

    await expect(guard.authorizeWorkflow(input())).rejects.toEqual(
      expect.objectContaining<Partial<ReleaseBusV2ManualDeploymentError>>({
        code: 'UNAVAILABLE',
        message: expect.stringContaining('could not be proven')
      })
    );
  });
});
