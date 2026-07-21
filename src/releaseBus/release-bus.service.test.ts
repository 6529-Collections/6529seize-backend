import { ReleaseBusService } from '@/releaseBus/release-bus.service';
import type { ReleaseCandidateRecord } from '@/releaseBus/release-bus.types';
import type { ReleaseBusRepository } from '@/releaseBus/release-bus.repository';

const SHA = 'a'.repeat(40);

function candidate(status: ReleaseCandidateRecord['status']) {
  return {
    id: 'candidate-1',
    repository: 'frontend',
    branch_name: 'feature/example',
    head_sha: SHA,
    pr_number: 123,
    status,
    staging_ready_by_github_login: null,
    staging_ready_at: null,
    production_ready_by_github_login: null,
    production_ready_at: null,
    deploy_plan_json: null,
    metadata_version: 1,
    current_train_id: null,
    hold_reason: null,
    invalidated_at: null,
    released_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  } satisfies ReleaseCandidateRecord;
}

describe('ReleaseBusService readiness', () => {
  it('rejects production readiness without exact staging evidence', async () => {
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      findCandidateByIdentity: async () => candidate('DRAFT'),
      hasCandidateEvidence: async () => false
    } as unknown as ReleaseBusRepository;
    const service = new ReleaseBusService(repository);

    await expect(
      service.markReady({
        repository: 'frontend',
        branch: 'feature/example',
        expected_head_sha: SHA,
        target_lane: 'PRODUCTION',
        dependencies: [],
        deploy_plan: null,
        actor: 'developer',
        prNumber: 123,
        resolvedDependencies: []
      })
    ).rejects.toThrow('exact candidate SHA has not passed staging');
  });

  it('rejects backend candidates that require frontend-first deployment', async () => {
    const service = new ReleaseBusService({} as ReleaseBusRepository);
    await expect(
      service.markReady({
        repository: 'backend',
        branch: 'feature/api',
        expected_head_sha: SHA,
        target_lane: 'STAGING',
        dependencies: [],
        deploy_plan: { units: ['api'], edges: [] },
        actor: 'developer',
        prNumber: 124,
        resolvedDependencies: [
          {
            repository: 'frontend',
            branch: 'feature/ui',
            headSha: 'b'.repeat(40),
            prNumber: 125
          }
        ]
      })
    ).rejects.toThrow('Backend candidates cannot depend on frontend-first');
  });

  it('fills the deploy plan when a dependency placeholder is marked ready', async () => {
    let row: ReleaseCandidateRecord = {
      ...candidate('DRAFT'),
      repository: 'backend',
      pr_number: null,
      deploy_plan_json: null
    };
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      findCandidateByIdentity: async () => row,
      updateCandidateMetadata: async (
        _id: string,
        _version: number,
        fields: {
          prNumber: number | null;
          deployPlan: ReleaseCandidateRecord['deploy_plan_json'];
        }
      ) => {
        row = {
          ...row,
          pr_number: fields.prNumber,
          deploy_plan_json: fields.deployPlan,
          row_version: row.row_version + 1
        };
      },
      findCandidateById: async () => row,
      replaceDependencies: async () => undefined,
      listCandidates: async () => [row],
      listDependencies: async () => [],
      updateCandidateLifecycle: async () => {
        row = {
          ...row,
          status: 'READY_FOR_STAGING',
          row_version: row.row_version + 1
        };
      },
      appendEvent: async () => undefined
    } as unknown as ReleaseBusRepository;

    const result = await new ReleaseBusService(repository).markReady({
      repository: 'backend',
      branch: row.branch_name,
      expected_head_sha: SHA,
      target_lane: 'STAGING',
      dependencies: [],
      deploy_plan: { units: ['api'], edges: [] },
      actor: 'developer',
      prNumber: 321,
      resolvedDependencies: []
    });

    expect(result.deploy_plan_json).toEqual({ units: ['api'], edges: [] });
    expect(result.pr_number).toBe(321);
    expect(result.status).toBe('READY_FOR_STAGING');
  });

  it('rejects dependency changes after a candidate is ready', async () => {
    const row = candidate('READY_FOR_STAGING');
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      findCandidateByIdentity: async () => row,
      listDependencies: async () => [
        {
          id: 'dependency-edge',
          candidate_id: row.id,
          depends_on_candidate_id: 'old-dependency',
          required_state: 'STAGING_VALIDATED',
          created_at: 1,
          updated_at: 1
        }
      ]
    } as unknown as ReleaseBusRepository;

    await expect(
      new ReleaseBusService(repository).markReady({
        repository: 'frontend',
        branch: row.branch_name,
        expected_head_sha: SHA,
        target_lane: 'STAGING',
        dependencies: [],
        deploy_plan: null,
        actor: 'developer',
        prNumber: row.pr_number,
        resolvedDependencies: []
      })
    ).rejects.toThrow('Dependencies for a ready candidate are immutable');
  });

  it('carries staging dependency identities into production readiness', async () => {
    let row = candidate('STAGING_VALIDATED');
    let requiredState = 'STAGING_VALIDATED';
    const dependency = {
      id: 'dependency-edge',
      candidate_id: row.id,
      depends_on_candidate_id: 'backend-dependency',
      required_state: requiredState,
      created_at: 1,
      updated_at: 1
    };
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      findCandidateByIdentity: async () => row,
      findCandidateById: async () => row,
      listDependencies: async () => [
        { ...dependency, required_state: requiredState }
      ],
      replaceDependencies: async (
        _candidateId: string,
        dependencies: Array<{ requiredState: string }>
      ) => {
        requiredState = dependencies[0].requiredState;
      },
      listCandidates: async () => [row],
      updateCandidateLifecycle: async () => {
        row = {
          ...row,
          status: 'READY_FOR_PRODUCTION',
          row_version: row.row_version + 1
        };
      },
      appendEvent: async () => undefined
    } as unknown as ReleaseBusRepository;

    const result = await new ReleaseBusService(repository).markReady({
      repository: 'frontend',
      branch: row.branch_name,
      expected_head_sha: SHA,
      target_lane: 'PRODUCTION',
      dependencies: [],
      deploy_plan: null,
      actor: 'developer',
      prNumber: row.pr_number,
      resolvedDependencies: []
    });

    expect(requiredState).toBe('PRODUCTION_VALIDATED');
    expect(result.status).toBe('READY_FOR_PRODUCTION');
  });
});

describe('ReleaseBusService shadow dependencies', () => {
  function repositoryWithShadowedDependency() {
    let dependency: ReleaseCandidateRecord = {
      ...candidate('READY_FOR_STAGING'),
      id: 'backend-dependency',
      repository: 'backend',
      branch_name: 'feature/backend',
      head_sha: 'b'.repeat(40),
      staging_ready_at: 1,
      deploy_plan_json: { units: ['api'], edges: [] }
    };
    let dependant: ReleaseCandidateRecord = {
      ...candidate('BLOCKED'),
      id: 'frontend-dependant',
      staging_ready_at: 2,
      hold_reason: 'WAITING_FOR_DEPENDENCY:STAGING'
    };
    const edge = {
      id: 'dependency-edge',
      candidate_id: dependant.id,
      depends_on_candidate_id: dependency.id,
      required_state: 'STAGING_VALIDATED' as const,
      created_at: 1,
      updated_at: 1
    };
    const createdCandidateIds: string[][] = [];
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      listControls: async () => [],
      acquireLane: async () => ({ lease_token: 'lease-token' }),
      releaseLane: async () => true,
      listCandidates: async (
        statuses: ReleaseCandidateRecord['status'][] | null
      ) =>
        [dependency, dependant].filter(
          (item) => !statuses || statuses.includes(item.status)
        ),
      listDependencies: async (candidateIds: readonly string[]) =>
        candidateIds.includes(dependant.id) ? [edge] : [],
      findCandidateById: async (id: string) =>
        [dependency, dependant].find((item) => item.id === id) ?? null,
      hasCandidateEvidence: async (_candidateId: string, type: string) =>
        type === 'CANDIDATE_SHADOW_EVALUATED_STAGING',
      updateCandidateLifecycle: async (
        id: string,
        _version: number,
        fields: {
          status: ReleaseCandidateRecord['status'];
          holdReason?: string | null;
          currentTrainId?: string | null;
        }
      ) => {
        const update = (item: ReleaseCandidateRecord) => ({
          ...item,
          status: fields.status,
          hold_reason:
            fields.holdReason === undefined
              ? item.hold_reason
              : fields.holdReason,
          current_train_id:
            fields.currentTrainId === undefined
              ? item.current_train_id
              : fields.currentTrainId,
          row_version: item.row_version + 1
        });
        if (id === dependency.id) dependency = update(dependency);
        if (id === dependant.id) dependant = update(dependant);
      },
      createTrain: async (_train: unknown, candidateIds: readonly string[]) => {
        createdCandidateIds.push([...candidateIds]);
      },
      appendEvent: async () => undefined
    } as unknown as ReleaseBusRepository;
    return {
      repository,
      createdCandidateIds,
      dependant: () => dependant,
      dependency
    };
  }

  it('releases a shadow hold after the dependency was evaluated in an earlier shadow train', async () => {
    const state = repositoryWithShadowedDependency();

    const train = await new ReleaseBusService(state.repository).freezeNextTrain(
      {
        lane: 'STAGING',
        owner: 'shadow-starter',
        frontendBaseSha: 'c'.repeat(40),
        backendBaseSha: 'd'.repeat(40),
        cutoffAt: 10,
        excludedCandidateIds: [state.dependency.id],
        allowShadowDependencyEvidence: true
      }
    );

    expect(train).not.toBeNull();
    expect(state.createdCandidateIds).toEqual([['frontend-dependant']]);
    expect(state.dependant()).toMatchObject({
      status: 'STAGING_CLAIMED',
      hold_reason: null,
      current_train_id: train?.id
    });
  });

  it('does not use shadow evidence to release a live dependency hold', async () => {
    const state = repositoryWithShadowedDependency();

    const train = await new ReleaseBusService(state.repository).freezeNextTrain(
      {
        lane: 'STAGING',
        owner: 'live-starter',
        frontendBaseSha: 'c'.repeat(40),
        backendBaseSha: 'd'.repeat(40),
        cutoffAt: 10,
        excludedCandidateIds: [state.dependency.id]
      }
    );

    expect(train).toBeNull();
    expect(state.createdCandidateIds).toEqual([]);
    expect(state.dependant()).toMatchObject({
      status: 'BLOCKED',
      hold_reason: 'WAITING_FOR_DEPENDENCY:STAGING'
    });
  });
});

describe('ReleaseBusService break glass', () => {
  it('does not pause when a train is active', async () => {
    const activeTrain = { id: 'active-train' };
    const setControl = jest.fn();
    const appendEvent = jest.fn();
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      listControls: async () => [],
      findActiveTrain: async () => activeTrain,
      setControl,
      appendEvent
    } as unknown as ReleaseBusRepository;

    await expect(
      new ReleaseBusService(repository).pauseForBreakGlass(
        'PRODUCTION',
        'Emergency deploy',
        'operator'
      )
    ).resolves.toBe(activeTrain);
    expect(setControl).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('pauses and audits atomically when no train is active', async () => {
    const calls: string[] = [];
    const repository = {
      executeNativeQueriesInTransaction: async (
        fn: (value: unknown) => unknown
      ) => fn({}),
      listControls: async () => {
        calls.push('lock-controls');
        return [];
      },
      findActiveTrain: async () => null,
      setControl: async () => {
        calls.push('pause');
      },
      appendEvent: async () => {
        calls.push('audit');
      }
    } as unknown as ReleaseBusRepository;

    await expect(
      new ReleaseBusService(repository).pauseForBreakGlass(
        'STAGING',
        'Emergency deploy',
        'operator'
      )
    ).resolves.toBeNull();
    expect(calls).toEqual(['lock-controls', 'pause', 'audit']);
  });
});
