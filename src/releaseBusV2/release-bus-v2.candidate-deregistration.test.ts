const mockResolveRef = jest.fn();
const mockStagingWorkflowScan = jest.fn();
const mockProductionWorkflowScan = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    resolveRef: (...args: unknown[]) => mockResolveRef(...args),
    hasActiveStagingMutationOrE2ERun: (...args: unknown[]) =>
      mockStagingWorkflowScan(...args),
    hasActiveProductionMutationOrE2ERun: (...args: unknown[]) =>
      mockProductionWorkflowScan(...args)
  }
}));

import { ReleaseBusV2CandidateDeregistrationService } from '@/releaseBusV2/release-bus-v2.candidate-deregistration';
import type {
  ReleaseBusV2ControlRecord,
  ReleaseBusV2LockRecord,
  ReleaseBusV2MaintenanceLease
} from '@/releaseBusV2/release-bus-v2.repository';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2StagingStateRecord
} from '@/releaseBusV2/release-bus-v2.types';

const FRONTEND_REF = 'a'.repeat(40);
const BACKEND_REF = 'b'.repeat(40);

function candidate(
  id: string,
  overrides: Partial<ReleaseBusV2CandidateRecord> = {}
): ReleaseBusV2CandidateRecord {
  return {
    id,
    repository: id.endsWith('1') ? 'frontend' : 'backend',
    pr_number: Number(id.replace(/\D/g, '')) || 1,
    branch_name: `feature/${id}`,
    head_sha: id.slice(0, 1).repeat(40),
    requested_by: 'operator',
    status: 'STAGING_VALIDATED',
    deploy_plan_json: null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: `train-${id}`,
    staging_validated_manifest_id: `manifest-${id}`,
    staging_live_state: 'LIVE',
    staging_live_manifest_id: `manifest-${id}`,
    staging_admitted_at: 10,
    staging_live_updated_at: 10,
    staging_transition_request: null,
    staging_transition_requested_at: null,
    staging_transition_requested_by: null,
    staging_transition_reason: null,
    production_requested_at: 20,
    production_requested_by: 'operator',
    production_selection_id: `selection-${id}`,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 20,
    row_version: 7,
    ...overrides
  };
}

function controls(
  overrides: Partial<Record<'ALL' | 'STAGING' | 'PRODUCTION', boolean>> = {}
): ReleaseBusV2ControlRecord[] {
  return [
    {
      scope: 'ALL',
      paused: overrides.ALL ?? false,
      reason: null,
      github_actor: null,
      updated_at: 1,
      row_version: 3
    },
    {
      scope: 'PRODUCTION',
      paused: overrides.PRODUCTION ?? true,
      reason: 'maintenance',
      github_actor: 'operator',
      updated_at: 1,
      row_version: 5
    },
    {
      scope: 'STAGING',
      paused: overrides.STAGING ?? true,
      reason: 'maintenance',
      github_actor: 'operator',
      updated_at: 1,
      row_version: 4
    }
  ];
}

function locks(
  override?: Partial<ReleaseBusV2LockRecord>
): ReleaseBusV2LockRecord[] {
  return ['production-environment', 'scheduler', 'staging-environment'].map(
    (name, index) => ({
      name,
      owner_train_id: null,
      lease_owner: null,
      lease_token: null,
      heartbeat_at: null,
      expires_at: null,
      updated_at: 1,
      row_version: index + 10,
      ...(override && name === 'scheduler' ? override : {})
    })
  );
}

function stagingState(
  overrides: Partial<ReleaseBusV2StagingStateRecord> = {}
): ReleaseBusV2StagingStateRecord {
  return {
    id: 'current',
    status: 'LIVE',
    current_manifest_id: 'manifest-current',
    last_validated_manifest_id: 'manifest-current',
    frontend_sha: FRONTEND_REF,
    backend_sha: BACKEND_REF,
    frontend_staging_ref_sha: FRONTEND_REF,
    backend_staging_ref_sha: BACKEND_REF,
    clean_main: false,
    last_transition_train_id: 'train-current',
    updated_at: 1,
    row_version: 12,
    ...overrides
  };
}

function harness() {
  const rows = [candidate('candidate-1'), candidate('candidate-2')];
  const controlRows = controls();
  const lockRows = locks();
  const state = stagingState();
  const leases: ReleaseBusV2MaintenanceLease[] = lockRows.map((lock) => ({
    name: lock.name,
    lease_owner: 'maintenance-owner',
    lease_token: `token-${lock.name}`,
    expires_at: Date.now() + 60_000,
    row_version: lock.row_version + 1
  }));
  const repository = {
    listControls: jest.fn().mockResolvedValue(controlRows),
    listLocks: jest.fn().mockResolvedValue(lockRows),
    listActiveTrains: jest.fn().mockResolvedValue([]),
    listNonterminalOperationsForLanes: jest.fn().mockResolvedValue([]),
    listCandidateDeregistrationTargets: jest.fn().mockResolvedValue(rows),
    getStagingState: jest.fn().mockResolvedValue(state),
    acquireExactFreeMaintenanceLocks: jest.fn().mockResolvedValue(leases),
    commitAllCandidateDeregistration: jest
      .fn()
      .mockResolvedValue({ candidateCount: rows.length }),
    releaseExactMaintenanceLocks: jest.fn().mockResolvedValue(undefined),
    appendEvent: jest.fn().mockResolvedValue(undefined)
  };
  const deps = {
    getMode: jest.fn().mockReturnValue('PRODUCTION'),
    resolveStagingRefs: jest
      .fn()
      .mockResolvedValue({ frontend: FRONTEND_REF, backend: BACKEND_REF }),
    hasActiveWorkflow: jest.fn().mockResolvedValue(false)
  };
  return {
    rows,
    controlRows,
    lockRows,
    state,
    leases,
    repository,
    deps,
    service: new ReleaseBusV2CandidateDeregistrationService(
      repository as never,
      deps as never
    )
  };
}

function executeInput(
  plan: Awaited<
    ReturnType<ReleaseBusV2CandidateDeregistrationService['prepare']>
  >
) {
  return {
    reason: 'Retire the audited candidate inventory',
    expected_plan_sha256: plan.plan_sha256,
    expected_inventory_sha256: plan.inventory_sha256,
    expected_candidates: plan.candidates,
    expected_controls: plan.controls,
    expected_locks: plan.locks,
    expected_staging_state_row_version: plan.staging_state_row_version,
    expected_staging_refs: plan.staging_refs
  };
}

describe('ReleaseBusV2CandidateDeregistrationService', () => {
  const previousMode = process.env.RELEASE_BUS_V2_MODE;

  afterAll(() => {
    if (previousMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = previousMode;
  });

  it('scans exact staging refs and all four staging/production workflow boundaries', async () => {
    const { repository } = harness();
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    mockResolveRef.mockReset();
    mockResolveRef
      .mockResolvedValueOnce(FRONTEND_REF)
      .mockResolvedValueOnce(BACKEND_REF);
    mockStagingWorkflowScan.mockReset();
    mockStagingWorkflowScan.mockResolvedValue(false);
    mockProductionWorkflowScan.mockReset();
    mockProductionWorkflowScan.mockResolvedValue(false);
    const service = new ReleaseBusV2CandidateDeregistrationService(
      repository as never
    );

    await expect(
      service.prepare('Retire the audited candidate inventory')
    ).resolves.toMatchObject({ phase: 'PREPARE' });
    expect(mockResolveRef.mock.calls).toEqual([
      ['frontend', '1a-staging'],
      ['backend', '1a-staging']
    ]);
    expect(mockStagingWorkflowScan.mock.calls).toEqual([
      ['frontend'],
      ['backend']
    ]);
    expect(mockProductionWorkflowScan.mock.calls).toEqual([
      ['frontend'],
      ['backend']
    ]);
  });

  it('prepares a deterministic exact inventory without mutating state', async () => {
    const { service, repository } = harness();

    const first = await service.prepare(
      'Retire the audited candidate inventory'
    );
    const second = await service.prepare(
      'Retire the audited candidate inventory'
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      phase: 'PREPARE',
      candidate_count: 2,
      candidates: [
        { id: 'candidate-1', row_version: 7 },
        { id: 'candidate-2', row_version: 7 }
      ],
      controls: [
        { scope: 'ALL', paused: false, row_version: 3 },
        { scope: 'PRODUCTION', paused: true, row_version: 5 },
        { scope: 'STAGING', paused: true, row_version: 4 }
      ],
      staging_state_row_version: 12,
      staging_refs: { frontend: FRONTEND_REF, backend: BACKEND_REF },
      mode: 'PRODUCTION',
      executed: false,
      deregistration_id: null,
      physical_staging_presence: 'UNKNOWN_UNCHANGED'
    });
    expect(first.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.inventory_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.acquireExactFreeMaintenanceLocks).not.toHaveBeenCalled();
    expect(repository.commitAllCandidateDeregistration).not.toHaveBeenCalled();
    expect(repository.releaseExactMaintenanceLocks).not.toHaveBeenCalled();
  });

  it('digests only active intent and preserves terminal history outside the plan', async () => {
    const { service, repository, rows } = harness();
    const terminalHistory = [
      candidate('history-1', {
        status: 'PRODUCTION_DEPLOYED',
        row_version: 31
      }),
      candidate('history-2', {
        status: 'SUPERSEDED',
        production_requested_at: null,
        production_requested_by: null,
        production_selection_id: null,
        row_version: 32
      }),
      candidate('history-3', { status: 'CANCELLED', row_version: 33 }),
      candidate('history-4', { status: 'DEREGISTERED', row_version: 34 })
    ];
    const recoverableSuperseded = candidate('recoverable-superseded', {
      status: 'SUPERSEDED',
      superseded_at: 35,
      row_version: 35
    });
    repository.listCandidateDeregistrationTargets.mockResolvedValue([
      rows[1],
      recoverableSuperseded,
      rows[0]
    ]);

    const plan = await service.prepare(
      'Retire only the active candidate intent'
    );

    expect(plan.candidate_count).toBe(3);
    expect(plan.candidates).toEqual([
      { id: 'candidate-1', row_version: 7 },
      { id: 'candidate-2', row_version: 7 },
      { id: 'recoverable-superseded', row_version: 35 }
    ]);
    expect(plan.candidates).not.toEqual(
      expect.arrayContaining(
        terminalHistory.map(({ id, row_version }) => ({ id, row_version }))
      )
    );
  });

  it('returns an explicit zero-target preparation as a safe non-executable no-op', async () => {
    const { service, repository } = harness();
    repository.listCandidateDeregistrationTargets.mockResolvedValue([]);

    const plan = await service.prepare('Confirm no active candidate intent');

    expect(plan).toMatchObject({
      phase: 'PREPARE',
      candidate_count: 0,
      candidates: [],
      executed: false
    });
    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'CONFLICT'
    });
    expect(repository.acquireExactFreeMaintenanceLocks).not.toHaveBeenCalled();
    expect(repository.commitAllCandidateDeregistration).not.toHaveBeenCalled();
  });

  it.each([
    ['ALL paused', controls({ ALL: true }), 'PRODUCTION'],
    ['staging running', controls({ STAGING: false }), 'PRODUCTION'],
    ['production running', controls({ PRODUCTION: false }), 'PRODUCTION'],
    ['hard-stop mode', controls(), 'OFF'],
    ['one-lane mode', controls(), 'STAGING']
  ])(
    'rejects %s without changing either lane control',
    async (_name, rows, mode) => {
      const { service, repository, deps } = harness();
      repository.listControls.mockResolvedValue(rows);
      deps.getMode.mockReturnValue(mode);

      await expect(
        service.prepare('Retire the audited candidate inventory')
      ).rejects.toMatchObject({
        name: 'ReleaseBusV2CandidateDeregistrationError',
        code: 'CONFLICT'
      });
      expect(
        repository.acquireExactFreeMaintenanceLocks
      ).not.toHaveBeenCalled();
      expect(
        repository.commitAllCandidateDeregistration
      ).not.toHaveBeenCalled();
      expect(rows).toEqual(rows);
    }
  );

  it('rejects even an expired non-null lease because exact-free means wholly free', async () => {
    const { service, repository } = harness();
    repository.listLocks.mockResolvedValue(
      locks({
        lease_owner: 'old-owner',
        lease_token: 'expired-token',
        heartbeat_at: 1,
        expires_at: 2
      })
    );

    await expect(
      service.prepare('Retire the audited candidate inventory')
    ).rejects.toMatchObject({
      name: 'ReleaseBusV2CandidateDeregistrationError',
      code: 'CONFLICT'
    });
    expect(repository.acquireExactFreeMaintenanceLocks).not.toHaveBeenCalled();
  });

  it.each([
    ['active train', 'listActiveTrains'],
    [
      'active staging/production/qualification operation',
      'listNonterminalOperationsForLanes'
    ]
  ] as const)(
    'requires full drain when there is an %s',
    async (_name, method) => {
      const { service, repository } = harness();
      repository[method].mockResolvedValue([{ id: 'active' }]);

      await expect(
        service.prepare('Retire the audited candidate inventory')
      ).rejects.toMatchObject({
        name: 'ReleaseBusV2CandidateDeregistrationError',
        code: 'CONFLICT'
      });
      expect(
        repository.acquireExactFreeMaintenanceLocks
      ).not.toHaveBeenCalled();
    }
  );

  it('requires the aggregate staging and production workflow scan to be clear', async () => {
    const { service, repository, deps } = harness();
    deps.hasActiveWorkflow.mockResolvedValue(true);

    await expect(
      service.prepare('Retire the audited candidate inventory')
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(deps.hasActiveWorkflow).toHaveBeenCalledTimes(1);
    expect(repository.acquireExactFreeMaintenanceLocks).not.toHaveBeenCalled();
  });

  it('rejects any stale or incomplete execute inventory before acquiring leases', async () => {
    const { service, repository } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );

    await expect(
      service.execute(
        {
          ...executeInput(plan),
          expected_candidates: plan.candidates.slice(1)
        },
        'operator'
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repository.acquireExactFreeMaintenanceLocks).not.toHaveBeenCalled();
    expect(repository.commitAllCandidateDeregistration).not.toHaveBeenCalled();
  });

  it('commits the exact plan under all three leases and releases them', async () => {
    const { service, repository, leases } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );

    const result = await service.execute(executeInput(plan), 'operator');

    expect(result).toMatchObject({
      phase: 'EXECUTE',
      executed: true,
      physical_staging_presence: 'UNKNOWN_DETACHED'
    });
    expect(result.deregistration_id).toMatch(/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
    expect(repository.acquireExactFreeMaintenanceLocks).toHaveBeenCalledWith(
      plan.locks,
      expect.stringMatching(/^deregister:operator:/),
      expect.any(Number)
    );
    expect(repository.commitAllCandidateDeregistration).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'operator',
        reason: 'Retire the audited candidate inventory',
        expectedControls: plan.controls,
        maintenanceLeases: leases,
        expectedStagingStateRowVersion: plan.staging_state_row_version,
        expectedCandidates: plan.candidates,
        expectedInventorySha256: plan.inventory_sha256,
        observedFrontendStagingSha: FRONTEND_REF,
        observedBackendStagingSha: BACKEND_REF
      })
    );
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledWith(
      leases
    );
  });

  it('rechecks mode, refs, and workflows after acquiring leases and before commit', async () => {
    const { service, repository, deps } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    deps.getMode
      .mockReturnValueOnce('PRODUCTION')
      .mockReturnValueOnce('STAGING');

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      committed: false,
      deregistration_id: null
    });
    expect(repository.commitAllCandidateDeregistration).not.toHaveBeenCalled();
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledTimes(1);
  });

  it('retains detached safe state and reports a changed post-commit fence', async () => {
    const { service, repository, deps } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    deps.hasActiveWorkflow
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      committed: true,
      deregistration_id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9-]{27}$/),
      physical_staging_presence: 'UNKNOWN_DETACHED'
    });
    expect(repository.commitAllCandidateDeregistration).toHaveBeenCalledTimes(
      1
    );
    expect(repository.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CANDIDATE_DEREGISTRATION_POST_FENCE_CHANGED',
        payload: expect.objectContaining({
          workflow_active: true,
          staging_state_retained: 'DETACHED_MANUAL_OWNERSHIP'
        })
      }),
      {}
    );
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledTimes(1);
  });

  it('reports the committed deregistration ID when post-commit ref evidence is unavailable', async () => {
    const { service, repository, deps } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    deps.resolveStagingRefs
      .mockResolvedValueOnce({
        frontend: FRONTEND_REF,
        backend: BACKEND_REF
      })
      .mockResolvedValueOnce({
        frontend: FRONTEND_REF,
        backend: BACKEND_REF
      })
      .mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      committed: true,
      deregistration_id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9-]{27}$/),
      message: expect.stringContaining('was committed as safely detached')
    });
    expect(repository.commitAllCandidateDeregistration).toHaveBeenCalledTimes(
      1
    );
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledTimes(1);
  });

  it('does not let lock-release failure obscure an already committed result', async () => {
    const { service, repository } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    repository.releaseExactMaintenanceLocks.mockRejectedValue(
      new Error('Lock backend unavailable')
    );

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      committed: true,
      deregistration_id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9-]{27}$/),
      message: expect.stringContaining('maintenance lock cleanup failed')
    });
    expect(repository.commitAllCandidateDeregistration).toHaveBeenCalledTimes(
      1
    );
  });

  it('surfaces lock-release failure alongside a pre-commit failure', async () => {
    const { service, repository, deps } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    deps.getMode
      .mockReturnValueOnce('PRODUCTION')
      .mockReturnValueOnce('STAGING');
    repository.releaseExactMaintenanceLocks.mockRejectedValue(
      new Error('Lock backend unavailable')
    );

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      committed: false,
      deregistration_id: null,
      message: expect.stringMatching(
        /maintenance lock cleanup failed after Release Bus mode changed/
      )
    });
    expect(repository.commitAllCandidateDeregistration).not.toHaveBeenCalled();
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledTimes(1);
  });

  it('retains committed-state evidence when supplemental post-fence audit fails', async () => {
    const { service, repository, deps } = harness();
    const plan = await service.prepare(
      'Retire the audited candidate inventory'
    );
    deps.hasActiveWorkflow
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    repository.appendEvent.mockRejectedValue(new Error('Audit unavailable'));

    await expect(
      service.execute(executeInput(plan), 'operator')
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      committed: true,
      deregistration_id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9-]{27}$/),
      message: expect.stringContaining(
        'supplemental post-fence audit event failed'
      )
    });
    expect(repository.releaseExactMaintenanceLocks).toHaveBeenCalledTimes(1);
  });
});
