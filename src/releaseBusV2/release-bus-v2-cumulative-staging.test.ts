import { ReleaseBusV2Repository } from '@/releaseBusV2/release-bus-v2.repository';
import { ReleaseBusV2Service } from '@/releaseBusV2/release-bus-v2.service';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2Repository as RepositoryName,
  ReleaseBusV2StagingStateRecord,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

const mockRefContainsCommit = jest.fn();
const mockEnsureCommitStatus = jest.fn();

jest.mock('@/releaseBusV2/release-bus-v2.github-app', () => ({
  releaseBusGitHubApp: {
    refContainsCommit: (...args: unknown[]) => mockRefContainsCommit(...args),
    ensureCommitStatus: (...args: unknown[]) => mockEnsureCommitStatus(...args)
  }
}));

function candidate(
  id: string,
  repository: RepositoryName,
  status: ReleaseBusV2CandidateRecord['status'],
  live: boolean
): ReleaseBusV2CandidateRecord {
  return {
    id,
    repository,
    pr_number: Number(id.replace(/\D/g, '')) || 1,
    branch_name: `feature/${id}`,
    head_sha: id.slice(0, 1).repeat(40),
    requested_by: 'operator',
    status,
    deploy_plan_json:
      repository === 'backend'
        ? { units: ['dbMigrationsLoop', 'api'], edges: [] }
        : null,
    pr_evidence_json: null,
    current_train_id: null,
    staging_validated_train_id: live ? `train-${id}` : null,
    staging_validated_manifest_id: live ? `manifest-${id}` : null,
    staging_live_state: live ? 'LIVE' : 'NOT_LIVE',
    staging_live_manifest_id: live ? 'manifest-live' : null,
    staging_admitted_at: live ? 1 : null,
    staging_live_updated_at: live ? 1 : null,
    production_requested_at: null,
    production_requested_by: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

function train(id: string): ReleaseBusV2TrainRecord {
  return {
    id,
    lane: 'STAGING',
    status: 'CLAIMED',
    frontend_base_sha: 'f'.repeat(40),
    backend_base_sha: 'b'.repeat(40),
    frontend_composed_sha: null,
    backend_composed_sha: null,
    frontend_artifact_digest: null,
    backend_artifact_digest: null,
    manifest_id: null,
    parent_train_id: null,
    qualification_identity_sha256: null,
    qualification_train_id: null,
    staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
    staging_baseline_manifest_id: 'manifest-live',
    staging_transition_json: null,
    failure_class: null,
    failure_message: null,
    recovery_message: null,
    phase_started_at: 1,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

describe('Release Bus v2 cumulative admitted staging', () => {
  const originalMode = process.env.RELEASE_BUS_V2_MODE;

  beforeEach(() => {
    process.env.RELEASE_BUS_V2_MODE = 'PRODUCTION';
    mockRefContainsCommit.mockReset();
    mockRefContainsCommit.mockResolvedValue(true);
    mockEnsureCommitStatus.mockReset();
    mockEnsureCommitStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RELEASE_BUS_V2_MODE;
    else process.env.RELEASE_BUS_V2_MODE = originalMode;
  });

  it('claims A+B and then A+B+C instead of composing each new candidate from main', async () => {
    const a = candidate('a1', 'frontend', 'STAGING_VALIDATED', true);
    const b = candidate('b2', 'backend', 'READY_FOR_STAGING', false);
    const c = candidate('c3', 'frontend', 'READY_FOR_STAGING', false);
    let live = [a];
    let ready = [b];
    const createTrain = jest
      .fn()
      .mockImplementation(async (input: { candidateIds: string[] }) =>
        train(`claimed-${input.candidateIds.join('-')}`)
      );
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 7
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? ready : [],
      listLiveStagingCandidates: async () => live,
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.claimLane(
      'STAGING',
      'f'.repeat(40),
      'b'.repeat(40),
      'operator',
      { frontendSha: '3'.repeat(40), backendSha: '4'.repeat(40) }
    );
    expect(createTrain).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateIds: [a.id, b.id],
        candidateRoles: {
          [a.id]: 'CARRY_FORWARD',
          [b.id]: 'NEW'
        },
        stagingPolicy: 'CUMULATIVE_ADMITTED_SET_V1'
      }),
      expect.anything()
    );

    live = [
      a,
      {
        ...b,
        status: 'STAGING_VALIDATED',
        staging_live_state: 'LIVE',
        staging_live_manifest_id: 'manifest-live'
      }
    ];
    ready = [c];
    await service.claimLane(
      'STAGING',
      'f'.repeat(40),
      'b'.repeat(40),
      'operator',
      { frontendSha: '3'.repeat(40), backendSha: '4'.repeat(40) }
    );
    expect(createTrain).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateIds: [a.id, b.id, c.id],
        candidateRoles: {
          [a.id]: 'CARRY_FORWARD',
          [b.id]: 'CARRY_FORWARD',
          [c.id]: 'NEW'
        }
      }),
      expect.anything()
    );
  });

  it('repairs a failed terminal cumulative carry-forward status without changing staging evidence or live membership', async () => {
    const stuck = {
      ...candidate('a1', 'frontend', 'STAGING_BUILDING', true),
      current_train_id: 'train-cumulative',
      staging_validated_train_id: 'train-original-validation',
      staging_validated_manifest_id: 'manifest-original-validation',
      staging_live_manifest_id: 'manifest-cumulative',
      row_version: 10
    };
    const terminalTrain = {
      ...train('train-cumulative'),
      status: 'FAILED' as const
    };
    const updateCandidate = jest.fn(async () => true);
    const appendEvent = jest.fn(async () => undefined);
    const repository = {
      listCandidates: async () => [stuck],
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      findCandidateById: async () => stuck,
      findTrain: async () => terminalTrain,
      listTrainCandidates: async () => [
        {
          train_id: terminalTrain.id,
          candidate_id: stuck.id,
          candidate_role: 'CARRY_FORWARD',
          disposition: 'INCLUDED'
        }
      ],
      listProductionManifestsForCandidate: async () => [],
      updateCandidate,
      appendEvent
    };
    const service = new ReleaseBusV2Service(repository as never);
    mockEnsureCommitStatus.mockRejectedValueOnce(
      new Error('transient GitHub failure')
    );

    await expect(
      service.repairTerminalCumulativeCarryForwardStatuses('reconciler')
    ).resolves.toEqual([
      expect.objectContaining({
        id: stuck.id,
        status: 'STAGING_VALIDATED',
        current_train_id: null,
        staging_validated_train_id: stuck.staging_validated_train_id,
        staging_validated_manifest_id: stuck.staging_validated_manifest_id,
        staging_live_state: 'LIVE',
        staging_live_manifest_id: stuck.staging_live_manifest_id
      })
    ]);
    expect(updateCandidate).toHaveBeenCalledWith(
      stuck.id,
      stuck.row_version,
      {
        status: 'STAGING_VALIDATED',
        currentTrainId: null,
        holdReason: null
      },
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        trainId: terminalTrain.id,
        candidateId: stuck.id,
        eventType: 'TERMINAL_CUMULATIVE_CARRY_FORWARD_STATUS_REPAIRED',
        payload: expect.objectContaining({
          incorrect_status: 'STAGING_BUILDING',
          restored_status: 'STAGING_VALIDATED',
          staging_validated_manifest_id: stuck.staging_validated_manifest_id,
          staging_live_state: 'LIVE'
        })
      }),
      expect.anything()
    );
    expect(mockEnsureCommitStatus).toHaveBeenCalledWith(
      stuck.repository,
      stuck.head_sha,
      'success',
      'Exact v2 staging manifest validated; production is explicit',
      'Release Bus v2'
    );
  });

  it('restores preserved candidate-evidence production intent on carry-forward repair', async () => {
    const stuck = {
      ...candidate('a1', 'frontend', 'STAGING_BUILDING', true),
      current_train_id: 'train-cumulative',
      production_requested_at: 2,
      production_requested_by: 'operator',
      production_selection_id: 'selection-a',
      row_version: 10
    };
    const validatedTrain = {
      ...train('train-cumulative'),
      status: 'STAGING_VALIDATED' as const
    };
    const updateCandidate = jest.fn(async () => true);
    const repository = {
      listCandidates: async () => [stuck],
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      findCandidateById: async () => stuck,
      findTrain: async () => validatedTrain,
      listTrainCandidates: async () => [
        {
          train_id: validatedTrain.id,
          candidate_id: stuck.id,
          candidate_role: 'CARRY_FORWARD',
          disposition: 'INCLUDED'
        }
      ],
      listProductionManifestsForCandidate: async () => [],
      updateCandidate,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.repairTerminalCumulativeCarryForwardStatuses('reconciler');

    expect(updateCandidate).toHaveBeenCalledWith(
      stuck.id,
      stuck.row_version,
      expect.objectContaining({
        status: 'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
        currentTrainId: null
      }),
      expect.anything()
    );
    expect(mockEnsureCommitStatus).toHaveBeenCalledWith(
      stuck.repository,
      stuck.head_sha,
      'pending',
      'Release Bus v2: ready for candidate evidence production',
      'Release Bus v2'
    );
  });

  it('does not invent staging certification when a terminal carry-forward row has no historical evidence', async () => {
    const stuck = {
      ...candidate('a1', 'frontend', 'STAGING_BUILDING', false),
      current_train_id: 'train-cumulative',
      row_version: 10
    };
    const terminalTrain = {
      ...train('train-cumulative'),
      status: 'FAILED' as const
    };
    const updateCandidate = jest.fn(async () => true);
    const repository = {
      listCandidates: async () => [stuck],
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      findCandidateById: async () => stuck,
      findTrain: async () => terminalTrain,
      listTrainCandidates: async () => [
        {
          train_id: terminalTrain.id,
          candidate_id: stuck.id,
          candidate_role: 'CARRY_FORWARD',
          disposition: 'INCLUDED'
        }
      ],
      listProductionManifestsForCandidate: async () => [],
      updateCandidate,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.repairTerminalCumulativeCarryForwardStatuses('reconciler')
    ).resolves.toEqual([]);
    expect(updateCandidate).not.toHaveBeenCalled();
    expect(mockEnsureCommitStatus).not.toHaveBeenCalled();
  });

  it('restores preserved legacy production intent on carry-forward repair', async () => {
    const stuck = {
      ...candidate('a1', 'frontend', 'STAGING_BUILDING', true),
      current_train_id: 'train-cumulative',
      production_requested_at: 2,
      production_requested_by: 'operator',
      production_selection_id: null,
      row_version: 10
    };
    const validatedTrain = {
      ...train('train-cumulative'),
      status: 'STAGING_VALIDATED' as const
    };
    const updateCandidate = jest.fn(async () => true);
    const repository = {
      listCandidates: async () => [stuck],
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      findCandidateById: async () => stuck,
      findTrain: async () => validatedTrain,
      listTrainCandidates: async () => [
        {
          train_id: validatedTrain.id,
          candidate_id: stuck.id,
          candidate_role: 'CARRY_FORWARD',
          disposition: 'INCLUDED'
        }
      ],
      listProductionManifestsForCandidate: async () => [],
      updateCandidate,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.repairTerminalCumulativeCarryForwardStatuses('reconciler');

    expect(updateCandidate).toHaveBeenCalledWith(
      stuck.id,
      stuck.row_version,
      expect.objectContaining({
        status: 'READY_FOR_PRODUCTION',
        currentTrainId: null
      }),
      expect.anything()
    );
  });

  it('restores exact terminal production deployment evidence on carry-forward repair', async () => {
    const stuck = {
      ...candidate('a1', 'frontend', 'STAGING_BUILDING', true),
      current_train_id: 'train-cumulative',
      production_requested_at: 2,
      production_requested_by: 'operator',
      production_selection_id: 'selection-a',
      row_version: 10
    };
    const validatedTrain = {
      ...train('train-cumulative'),
      status: 'STAGING_VALIDATED' as const
    };
    const updateCandidate = jest.fn(async () => true);
    const repository = {
      listCandidates: async () => [stuck],
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      findCandidateById: async () => stuck,
      findTrain: async () => validatedTrain,
      listTrainCandidates: async () => [
        {
          train_id: validatedTrain.id,
          candidate_id: stuck.id,
          candidate_role: 'CARRY_FORWARD',
          disposition: 'INCLUDED'
        }
      ],
      listProductionManifestsForCandidate: async () => [
        {
          train_id: 'production-train',
          manifest_json: {
            candidates: [
              {
                candidate_id: stuck.id,
                repository: stuck.repository,
                pr_number: stuck.pr_number,
                head_sha: stuck.head_sha
              }
            ],
            operations: [
              { type: 'E2E_PROD', workflow_run_id: 'production-e2e-run' }
            ]
          }
        }
      ],
      listOperations: async () => [
        {
          operation_type: 'E2E_PROD',
          status: 'SUCCEEDED',
          external_id: 'production-e2e-run'
        }
      ],
      updateCandidate,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.repairTerminalCumulativeCarryForwardStatuses('reconciler');

    expect(updateCandidate).toHaveBeenCalledWith(
      stuck.id,
      stuck.row_version,
      expect.objectContaining({
        status: 'PRODUCTION_DEPLOYED',
        currentTrainId: null
      }),
      expect.anything()
    );
  });

  it('bootstraps the legacy live manifest by exact refs and successful E2E before admitting B', async () => {
    const a = {
      ...candidate('a1', 'frontend', 'PRODUCTION_DEPLOYED', true),
      staging_validated_train_id: 'train-a',
      staging_validated_manifest_id: 'manifest-a',
      staging_live_manifest_id: 'manifest-a'
    };
    const b = candidate('b2', 'backend', 'READY_FOR_STAGING', false);
    const frontendSha = '1'.repeat(40);
    const backendSha = '2'.repeat(40);
    let state: ReleaseBusV2StagingStateRecord = {
      id: 'current' as const,
      status: 'UNINITIALIZED' as const,
      current_manifest_id: null,
      last_validated_manifest_id: null,
      frontend_sha: null,
      backend_sha: null,
      frontend_staging_ref_sha: null,
      backend_staging_ref_sha: null,
      clean_main: false,
      last_transition_train_id: null,
      updated_at: 1,
      row_version: 1
    };
    const createTrain = jest.fn(async () => train('legacy-plus-b'));
    const commitValidatedStaging = jest.fn(async () => {
      state = {
        ...state,
        status: 'LIVE',
        current_manifest_id: 'manifest-a',
        last_validated_manifest_id: 'manifest-a',
        frontend_sha: frontendSha,
        backend_sha: backendSha,
        frontend_staging_ref_sha: frontendSha,
        backend_staging_ref_sha: backendSha,
        last_transition_train_id: 'train-a',
        row_version: 2
      };
    });
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => state,
      findStagingValidatedManifestByShas: async () => ({
        id: 'manifest-a',
        train_id: 'train-a',
        e2e_run_id: 'e2e-a',
        manifest_json: {
          candidates: [
            {
              candidate_id: a.id,
              repository: a.repository,
              pr_number: a.pr_number,
              head_sha: a.head_sha
            }
          ]
        }
      }),
      listOperations: async () => [
        {
          operation_type: 'E2E_STAGING',
          status: 'SUCCEEDED',
          external_id: 'e2e-a'
        }
      ],
      findCandidateByIdentity: async () => a,
      commitValidatedStaging,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async () => [b],
      listLiveStagingCandidates: async () => [a],
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', 'f'.repeat(40), 'b'.repeat(40), 'operator', {
        frontendSha,
        backendSha
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'legacy-plus-b' }));
    expect(commitValidatedStaging).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: 'manifest-a',
        frontendStagingRefSha: frontendSha,
        backendStagingRefSha: backendSha,
        admittedCandidateIds: [a.id]
      }),
      expect.anything()
    );
    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [a.id, b.id],
        candidateRoles: { [a.id]: 'CARRY_FORWARD', [b.id]: 'NEW' },
        stagingTransition: expect.objectContaining({
          baseline_state_version: 2
        })
      }),
      expect.anything()
    );
  });

  it('bootstraps an exact clean-main reset without creating staging validation evidence', async () => {
    const b = candidate('b2', 'backend', 'READY_FOR_STAGING', false);
    const frontendSha = 'f'.repeat(40);
    const backendSha = 'b'.repeat(40);
    let state: ReleaseBusV2StagingStateRecord = {
      id: 'current',
      status: 'UNINITIALIZED',
      current_manifest_id: null,
      last_validated_manifest_id: null,
      frontend_sha: null,
      backend_sha: null,
      frontend_staging_ref_sha: null,
      backend_staging_ref_sha: null,
      clean_main: false,
      last_transition_train_id: null,
      updated_at: 1,
      row_version: 1
    };
    const updateStagingState = jest.fn(async () => {
      state = {
        ...state,
        status: 'CLEAN_MAIN',
        frontend_sha: frontendSha,
        backend_sha: backendSha,
        frontend_staging_ref_sha: frontendSha,
        backend_staging_ref_sha: backendSha,
        clean_main: true,
        row_version: 2
      };
      return true;
    });
    const appendEvent = jest.fn(async () => undefined);
    const findStagingValidatedManifestByShas = jest.fn();
    const createTrain = jest.fn(async () => train('clean-main-plus-b'));
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => state,
      updateStagingState,
      findStagingValidatedManifestByShas,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? [b] : [],
      listLiveStagingCandidates: async () => [],
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', frontendSha, backendSha, 'operator', {
        frontendSha,
        backendSha
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'clean-main-plus-b' }));
    expect(updateStagingState).toHaveBeenCalledWith(
      1,
      {
        status: 'CLEAN_MAIN',
        currentManifestId: null,
        lastValidatedManifestId: null,
        frontendSha,
        backendSha,
        frontendStagingRefSha: frontendSha,
        backendStagingRefSha: backendSha,
        cleanMain: true,
        lastTransitionTrainId: null
      },
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'CUMULATIVE_STAGING_STATE_BOOTSTRAPPED_FROM_CLEAN_MAIN',
        payload: expect.objectContaining({
          admitted_candidate_ids: [],
          staging_validation_created: false
        })
      }),
      expect.anything()
    );
    expect(findStagingValidatedManifestByShas).not.toHaveBeenCalled();
    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        stagingBaselineManifestId: null,
        stagingTransition: expect.objectContaining({
          baseline_state_version: 2,
          baseline_manifest_id: null
        })
      }),
      expect.anything()
    );
  });

  it('blocks detached manual staging refs without resurrecting an old validated manifest', async () => {
    const frontendMain = 'f'.repeat(40);
    const backendMain = 'b'.repeat(40);
    const state: ReleaseBusV2StagingStateRecord = {
      id: 'current',
      status: 'DETACHED_MANUAL_OWNERSHIP',
      current_manifest_id: null,
      last_validated_manifest_id: 'historical-manifest',
      frontend_sha: null,
      backend_sha: null,
      frontend_staging_ref_sha: null,
      backend_staging_ref_sha: null,
      clean_main: false,
      last_transition_train_id: null,
      updated_at: 1,
      row_version: 9
    };
    const findStagingValidatedManifestByShas = jest.fn();
    const commitDetachedStagingCleanMain = jest.fn();
    const createTrain = jest.fn();
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => state,
      findStagingValidatedManifestByShas,
      commitDetachedStagingCleanMain,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      createTrain
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', frontendMain, backendMain, 'operator', {
        frontendSha: '1'.repeat(40),
        backendSha: '2'.repeat(40)
      })
    ).resolves.toBeNull();
    expect(findStagingValidatedManifestByShas).not.toHaveBeenCalled();
    expect(commitDetachedStagingCleanMain).not.toHaveBeenCalled();
    expect(createTrain).not.toHaveBeenCalled();
  });

  it('hard-blocks production claiming while staging ownership is detached', async () => {
    const ready = candidate('a1', 'frontend', 'READY_FOR_PRODUCTION', false);
    const listCandidates = jest.fn(async () => [ready]);
    const createTrain = jest.fn();
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'DETACHED_MANUAL_OWNERSHIP',
        current_manifest_id: null,
        last_validated_manifest_id: 'historical-manifest',
        frontend_sha: null,
        backend_sha: null,
        frontend_staging_ref_sha: null,
        backend_staging_ref_sha: null,
        clean_main: false,
        last_transition_train_id: null,
        updated_at: 1,
        row_version: 9
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listCandidates,
      createTrain
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane(
        'PRODUCTION',
        'f'.repeat(40),
        'b'.repeat(40),
        'operator'
      )
    ).resolves.toBeNull();
    expect(listCandidates).not.toHaveBeenCalled();
    expect(createTrain).not.toHaveBeenCalled();
  });

  it('bootstraps detached ownership only from exact current mains and does not restore historical membership', async () => {
    const frontendMain = 'f'.repeat(40);
    const backendMain = 'b'.repeat(40);
    const ready = candidate('b2', 'backend', 'READY_FOR_STAGING', false);
    const terminalHistoricalLive = {
      ...candidate('a1', 'frontend', 'PRODUCTION_DEPLOYED', true),
      staging_live_manifest_id: 'historical-manifest'
    };
    let state: ReleaseBusV2StagingStateRecord = {
      id: 'current',
      status: 'DETACHED_MANUAL_OWNERSHIP',
      current_manifest_id: null,
      last_validated_manifest_id: 'historical-manifest',
      frontend_sha: null,
      backend_sha: null,
      frontend_staging_ref_sha: null,
      backend_staging_ref_sha: null,
      clean_main: false,
      last_transition_train_id: null,
      updated_at: 1,
      row_version: 9
    };
    const findStagingValidatedManifestByShas = jest.fn();
    const commitDetachedStagingCleanMain = jest.fn(async () => {
      state = {
        ...state,
        status: 'CLEAN_MAIN',
        current_manifest_id: null,
        frontend_sha: frontendMain,
        backend_sha: backendMain,
        frontend_staging_ref_sha: frontendMain,
        backend_staging_ref_sha: backendMain,
        clean_main: true,
        row_version: 10
      };
    });
    const createTrain = jest.fn(async () => train('exact-main-plus-b'));
    const listLiveStagingCandidates = jest.fn(async () => [
      terminalHistoricalLive
    ]);
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => state,
      findStagingValidatedManifestByShas,
      commitDetachedStagingCleanMain,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? [ready] : [],
      listLiveStagingCandidates,
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', frontendMain, backendMain, 'operator', {
        frontendSha: frontendMain,
        backendSha: backendMain
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'exact-main-plus-b' }));
    expect(commitDetachedStagingCleanMain).toHaveBeenCalledWith(
      {
        expectedStateVersion: 9,
        frontendSha: frontendMain,
        backendSha: backendMain
      },
      expect.anything()
    );
    expect(findStagingValidatedManifestByShas).not.toHaveBeenCalled();
    expect(listLiveStagingCandidates).not.toHaveBeenCalled();
    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [ready.id],
        stagingBaselineManifestId: null,
        stagingTransition: expect.objectContaining({
          baseline_manifest_id: null,
          baseline_state_version: 10
        })
      }),
      expect.anything()
    );
  });

  it('rejects runtime/ref mismatch before it can overwrite authoritative staging state', async () => {
    const statements: string[] = [];
    const db = {
      execute: async (sql: string) => {
        statements.push(sql);
        return { affectedRows: 0 };
      },
      oneOrNull: async () => null,
      getAffectedRows: (result: { affectedRows: number }) => result.affectedRows
    };
    const repository = new ReleaseBusV2Repository(() => db as never);
    await expect(
      repository.commitValidatedStaging(
        {
          trainId: 'stale-train',
          expectedStateVersion: 4,
          manifestId: 'stale-manifest',
          frontendSha: 'a'.repeat(40),
          backendSha: 'b'.repeat(40),
          frontendStagingRefSha: 'c'.repeat(40),
          backendStagingRefSha: 'd'.repeat(40),
          admittedCandidateIds: ['candidate-a'],
          removedCandidateIds: [],
          newCandidateIds: []
        },
        {}
      )
    ).rejects.toThrow(
      'Validated staging runtime SHAs must equal their exact staging ref SHAs'
    );
    expect(statements).toHaveLength(0);
  });

  it('rejects overlapping NEW and removed sets before any staging mutation', async () => {
    const execute = jest.fn();
    const repository = new ReleaseBusV2Repository(
      () =>
        ({
          execute,
          oneOrNull: async () => null,
          getAffectedRows: () => 0
        }) as never
    );

    await expect(
      repository.commitValidatedStaging(
        {
          trainId: 'overlap-train',
          expectedStateVersion: 4,
          manifestId: 'overlap-manifest',
          frontendSha: 'a'.repeat(40),
          backendSha: 'b'.repeat(40),
          frontendStagingRefSha: 'a'.repeat(40),
          backendStagingRefSha: 'b'.repeat(40),
          admittedCandidateIds: ['candidate-a'],
          removedCandidateIds: ['candidate-a'],
          newCandidateIds: ['candidate-a']
        },
        {}
      )
    ).rejects.toThrow('NEW and removed candidate sets must be disjoint');

    expect(execute).not.toHaveBeenCalled();
  });

  it('replaces only the superseded exact PR head in the proposed cumulative manifest', async () => {
    const a = candidate('a1', 'frontend', 'STAGING_VALIDATED', true);
    const b = candidate('b2', 'backend', 'STAGING_VALIDATED', true);
    const a2 = {
      ...candidate('z9', 'frontend', 'READY_FOR_STAGING', false),
      pr_number: a.pr_number,
      head_sha: 'e'.repeat(40),
      branch_name: a.branch_name
    };
    const createTrain = jest.fn(async () => train('replace-a'));
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 9
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? [a2] : [],
      listLiveStagingCandidates: async () => [a, b],
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.claimLane(
      'STAGING',
      'f'.repeat(40),
      'b'.repeat(40),
      'operator',
      { frontendSha: '3'.repeat(40), backendSha: '4'.repeat(40) }
    );

    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [b.id, a2.id],
        candidateRoles: {
          [b.id]: 'CARRY_FORWARD',
          [a2.id]: 'NEW'
        },
        stagingTransition: expect.objectContaining({
          replaced_candidate_ids: [a.id],
          carried_candidate_ids: [b.id],
          new_candidate_ids: [a2.id]
        })
      }),
      expect.anything()
    );
  });

  it('never classifies the same exact live candidate as both NEW and REPLACED', async () => {
    const exact = candidate('a1', 'frontend', 'READY_FOR_STAGING', true);
    const carried = candidate('b2', 'backend', 'STAGING_VALIDATED', true);
    const createTrain = jest.fn(async () => train('self-replacement-guard'));
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 9
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? [exact] : [],
      listLiveStagingCandidates: async () => [exact, carried],
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.claimLane(
      'STAGING',
      'f'.repeat(40),
      'b'.repeat(40),
      'operator',
      { frontendSha: '3'.repeat(40), backendSha: '4'.repeat(40) }
    );

    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [exact.id, carried.id],
        candidateRoles: {
          [carried.id]: 'CARRY_FORWARD',
          [exact.id]: 'NEW'
        },
        stagingTransition: expect.objectContaining({
          new_candidate_ids: [exact.id],
          replaced_candidate_ids: [],
          carried_candidate_ids: [carried.id]
        })
      }),
      expect.anything()
    );
  });

  it('removes a live candidate only through an explicit audited transition membership', async () => {
    const a = {
      ...candidate('a1', 'frontend', 'STAGING_VALIDATED', true),
      staging_transition_request: 'REMOVE' as const,
      staging_transition_requested_at: 2,
      staging_transition_requested_by: 'operator',
      staging_transition_reason: 'Retire completed experiment'
    };
    const b = candidate('b2', 'backend', 'STAGING_VALIDATED', true);
    const createTrain = jest.fn(async () => train('remove-a'));
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 10
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async () => [],
      listLiveStagingCandidates: async () => [a, b],
      listStagingTransitionRequests: async () => [a],
      listDependencies: async () => [],
      createTrain,
      updateCandidate: async () => true,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await service.claimLane(
      'STAGING',
      'f'.repeat(40),
      'b'.repeat(40),
      'operator',
      { frontendSha: '3'.repeat(40), backendSha: '4'.repeat(40) }
    );

    expect(createTrain).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateIds: [b.id, a.id],
        candidateRoles: {
          [b.id]: 'CARRY_FORWARD',
          [a.id]: 'REMOVAL'
        },
        candidateDispositions: { [a.id]: 'AUDIT_ONLY' },
        stagingTransition: expect.objectContaining({
          removed_candidate_ids: [a.id],
          carried_candidate_ids: [b.id]
        })
      }),
      expect.anything()
    );
  });

  it('records one durable hold when an absorption request is no longer contained in main', async () => {
    const a = {
      ...candidate('a1', 'frontend', 'STAGING_VALIDATED', true),
      staging_transition_request: 'ABSORB' as const,
      staging_transition_requested_at: 2,
      staging_transition_requested_by: 'operator',
      staging_transition_reason: 'Absorb released code'
    };
    const updateCandidate = jest.fn(async () => true);
    const appendEvent = jest.fn(async () => undefined);
    const createTrain = jest.fn();
    mockRefContainsCommit.mockResolvedValue(false);
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 10
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async () => [],
      listLiveStagingCandidates: async () => [a],
      listStagingTransitionRequests: async () => [a],
      listDependencies: async () => [],
      createTrain,
      updateCandidate,
      appendEvent
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', 'f'.repeat(40), 'b'.repeat(40), 'operator', {
        frontendSha: '3'.repeat(40),
        backendSha: '4'.repeat(40)
      })
    ).resolves.toBeNull();

    expect(createTrain).not.toHaveBeenCalled();
    expect(updateCandidate).toHaveBeenCalledWith(
      a.id,
      a.row_version,
      {
        status: a.status,
        holdReason:
          'Absorption blocked: exact candidate SHA is not contained in current main'
      },
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: a.id,
        eventType: 'STAGING_ABSORPTION_BLOCKED_MAIN_IDENTITY',
        actor: 'operator'
      }),
      expect.anything()
    );
  });

  it('rejects a staging dependency whose prerequisite is only historically validated', async () => {
    const historical = candidate('a1', 'frontend', 'STAGING_VALIDATED', false);
    const dependent = candidate('b2', 'backend', 'READY_FOR_STAGING', false);
    const createTrain = jest.fn();
    const updateCandidate = jest.fn(async () => true);
    const listDependencies = jest.fn(async (ids: string[]) =>
      ids.includes(dependent.id)
        ? [
            {
              id: 'dependency',
              candidate_id: dependent.id,
              prerequisite_candidate_id: historical.id,
              environment: 'STAGING',
              created_at: 1
            }
          ]
        : []
    );
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'CLEAN_MAIN',
        current_manifest_id: null,
        last_validated_manifest_id: 'historical-manifest',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: true,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 8
      }),
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async (statuses: string[]) =>
        statuses.includes('READY_FOR_STAGING') ? [dependent] : [],
      listLiveStagingCandidates: async () => [],
      listStagingTransitionRequests: async () => [],
      listDependencies,
      findCandidateById: async (id: string) =>
        id === historical.id ? historical : dependent,
      createTrain,
      updateCandidate,
      appendEvent: async () => undefined
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', 'f'.repeat(40), 'b'.repeat(40), 'operator', {
        frontendSha: '3'.repeat(40),
        backendSha: '4'.repeat(40)
      })
    ).resolves.toBeNull();
    expect(createTrain).not.toHaveBeenCalled();
    expect(listDependencies).toHaveBeenCalledWith(
      [dependent.id],
      expect.anything()
    );
    expect(updateCandidate).toHaveBeenCalledWith(
      dependent.id,
      dependent.row_version,
      expect.objectContaining({
        status: 'WAITING_FOR_DEPENDENCY',
        holdReason: 'Cumulative staging dependency closure is incomplete'
      }),
      expect.anything()
    );
  });

  it('surfaces manual 1a-staging drift without revoking historical validation evidence', async () => {
    const historicalManifest = 'historical-manifest-a';
    const currentManifest = 'manifest-live';
    const updateStagingState = jest.fn(async () => true);
    const setControl = jest.fn(async () => undefined);
    const appendEvent = jest.fn(async () => undefined);
    const createTrain = jest.fn();
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: currentManifest,
        last_validated_manifest_id: historicalManifest,
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 11
      }),
      updateStagingState,
      setControl,
      appendEvent,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      listTrains: async () => [],
      listCandidates: async () => [
        candidate('b2', 'backend', 'READY_FOR_STAGING', false)
      ],
      listLiveStagingCandidates: async () => [],
      listStagingTransitionRequests: async () => [],
      listDependencies: async () => [],
      createTrain
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', 'f'.repeat(40), 'b'.repeat(40), 'operator', {
        frontendSha: '9'.repeat(40),
        backendSha: '4'.repeat(40)
      })
    ).resolves.toBeNull();

    expect(createTrain).not.toHaveBeenCalled();
    expect(updateStagingState).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        status: 'ROLLBACK_FAILED',
        currentManifestId: null,
        lastValidatedManifestId: historicalManifest,
        frontendStagingRefSha: '9'.repeat(40),
        backendStagingRefSha: '4'.repeat(40)
      }),
      expect.anything()
    );
    expect(setControl).toHaveBeenCalledWith(
      'STAGING',
      true,
      expect.stringContaining('drift'),
      'release-bus-v2',
      expect.anything()
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'STAGING_REF_DRIFT_DETECTED',
        payload: expect.objectContaining({
          current_manifest_id: currentManifest,
          production_evidence_preserved: true
        })
      }),
      expect.anything()
    );
  });

  it('does not classify an active train ref advance as manual drift', async () => {
    const activeTrain = train('active-staging-train');
    const updateStagingState = jest.fn(async () => true);
    const setControl = jest.fn(async () => undefined);
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (connection: unknown) => unknown
      ) => callback({}),
      acquireLock: async () => ({ lease_token: 'scheduler' }),
      releaseLock: async () => true,
      listControls: async () => [
        { scope: 'ALL', paused: false },
        { scope: 'STAGING', paused: false },
        { scope: 'PRODUCTION', paused: false }
      ],
      getStagingState: async () => ({
        id: 'current',
        status: 'LIVE',
        current_manifest_id: 'manifest-live',
        last_validated_manifest_id: 'manifest-live',
        frontend_sha: '1'.repeat(40),
        backend_sha: '2'.repeat(40),
        frontend_staging_ref_sha: '3'.repeat(40),
        backend_staging_ref_sha: '4'.repeat(40),
        clean_main: false,
        last_transition_train_id: 'previous',
        updated_at: 1,
        row_version: 11
      }),
      updateStagingState,
      setControl,
      appendEvent: jest.fn(async () => undefined),
      listTrains: async () => [activeTrain]
    };
    const service = new ReleaseBusV2Service(repository as never);

    await expect(
      service.claimLane('STAGING', 'f'.repeat(40), 'b'.repeat(40), 'operator', {
        // The live ref can already be at the train's target while the
        // authoritative state transition is still committing.
        frontendSha: '9'.repeat(40),
        backendSha: '4'.repeat(40)
      })
    ).resolves.toEqual(activeTrain);

    expect(updateStagingState).not.toHaveBeenCalled();
    expect(setControl).not.toHaveBeenCalled();
  });
});
