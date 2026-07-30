import {
  backendGraph,
  backendReleaseNoteInputs,
  backendReleaseNoteGroups,
  canUseSingleCandidateFastPath,
  candidateEvidenceSelectionForPreparation,
  candidateUnavailableForTrainUpdate,
  candidateStatusMutationCandidates,
  deletedProductionCandidateCanRetainReadiness,
  candidateExclusionClosure,
  dagLayers,
  e2eWorkflowInputs,
  operationContributorCandidates,
  releaseTrainContributorGithubLogins,
  releaseBusV2Branch,
  ReleaseBusV2Reconciler,
  relevantCandidates,
  stagingDeploymentCandidates
} from '@/releaseBusV2/release-bus-v2.reconciler';
import {
  normalizeDeployPlan,
  topologicalOrder
} from '@/releaseBusV2/release-bus-v2.service';
import { releaseBusGitHubApp } from '@/releaseBusV2/release-bus-v2.github-app';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2FailureClass,
  ReleaseBusV2PrEvidence,
  ReleaseBusV2TrainRecord
} from '@/releaseBusV2/release-bus-v2.types';

function candidate(
  id: string,
  headSha: string,
  evidence: ReleaseBusV2PrEvidence | null = null
): ReleaseBusV2CandidateRecord {
  return {
    id,
    repository: 'backend',
    pr_number: 1,
    branch_name: `feature/${id}`,
    head_sha: headSha,
    requested_by: 'agent',
    status: 'READY_FOR_STAGING',
    deploy_plan_json: { units: ['api'], edges: [] },
    pr_evidence_json: evidence,
    current_train_id: null,
    staging_validated_train_id: null,
    staging_validated_manifest_id: null,
    production_requested_at: null,
    production_requested_by: null,
    production_selection_id: null,
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

describe('Release Bus v2 deterministic orchestration', () => {
  it('fails closed when a rollback baseline candidate identity cannot be resolved', async () => {
    const stagingTrain: ReleaseBusV2TrainRecord = {
      id: 'train-unresolvable-baseline',
      lane: 'STAGING',
      status: 'STAGING_ROLLING_BACK',
      frontend_base_sha: '1'.repeat(40),
      backend_base_sha: '2'.repeat(40),
      frontend_composed_sha: '3'.repeat(40),
      backend_composed_sha: '4'.repeat(40),
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      manifest_id: 'failed-manifest',
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'baseline-manifest',
      staging_transition_json: null,
      failure_class: 'CONTROL_PLANE',
      failure_message: 'rollback required',
      recovery_message: null,
      phase_started_at: 1,
      completed_at: null,
      created_at: 1,
      updated_at: 1,
      row_version: 1
    };
    const repository = {
      findManifest: jest.fn(async () => ({
        id: 'baseline-manifest',
        train_id: 'baseline-train',
        lane: 'STAGING',
        identity_sha256: '5'.repeat(64),
        status: 'STAGING_VALIDATED',
        frontend_sha: '6'.repeat(40),
        backend_sha: '7'.repeat(40),
        frontend_artifact_digest: null,
        backend_artifact_digest: null,
        e2e_run_id: '123',
        manifest_json: {
          candidates: [
            {
              repository: 'backend',
              pr_number: 1880,
              head_sha: '8'.repeat(40)
            }
          ]
        },
        deployed_at: 1,
        validated_at: 2,
        created_at: 1,
        updated_at: 2
      }))
    };
    const reconciler = new ReleaseBusV2Reconciler(
      repository as never,
      {} as never
    ) as unknown as {
      cumulativeRollbackBaseline(context: unknown): Promise<unknown>;
    };

    await expect(
      reconciler.cumulativeRollbackBaseline({
        train: stagingTrain,
        memberships: [],
        candidates: [],
        dependencies: []
      })
    ).rejects.toThrow(
      'Cumulative rollback baseline manifest baseline-manifest has an unresolvable candidate identity'
    );
  });

  it('keeps carried candidates in composition without spuriously redeploying their runtime units', () => {
    const carried = candidate('carried', 'a'.repeat(40));
    const removed = {
      ...candidate('removed', 'b'.repeat(40)),
      deploy_plan_json: { units: ['public-api'], edges: [] }
    };
    const stagingTrain: ReleaseBusV2TrainRecord = {
      id: 'train-remove',
      lane: 'STAGING',
      status: 'CLAIMED',
      frontend_base_sha: 'c'.repeat(40),
      backend_base_sha: 'd'.repeat(40),
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      manifest_id: null,
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'manifest-before-removal',
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
    const context = {
      train: stagingTrain,
      memberships: [
        {
          id: 'membership-carried',
          train_id: stagingTrain.id,
          candidate_id: carried.id,
          sequence: 1,
          disposition: 'INCLUDED',
          candidate_role: 'CARRY_FORWARD',
          created_at: 1
        },
        {
          id: 'membership-removed',
          train_id: stagingTrain.id,
          candidate_id: removed.id,
          sequence: 2,
          disposition: 'AUDIT_ONLY',
          candidate_role: 'REMOVAL',
          created_at: 1
        }
      ],
      candidates: [carried, removed],
      dependencies: []
    };

    expect(relevantCandidates(context)).toEqual([carried]);
    expect(stagingDeploymentCandidates(context, 'backend')).toEqual([removed]);
    expect(operationContributorCandidates(context, 'backend')).toEqual([]);
  });

  it('scopes cumulative staging contributors by repository, service, and NEW membership', () => {
    const api = {
      ...candidate('api-new', 'a'.repeat(40)),
      deploy_plan_json: { units: ['api'], edges: [] }
    };
    const worker = {
      ...candidate('worker-new', 'b'.repeat(40)),
      deploy_plan_json: { units: ['claimsBuilder'], edges: [] }
    };
    const carried = candidate('carried', 'c'.repeat(40));
    const frontend = {
      ...candidate('frontend-new', 'd'.repeat(40)),
      repository: 'frontend' as const,
      deploy_plan_json: null
    };
    const train = {
      id: 'train-scoped',
      lane: 'STAGING',
      status: 'CLAIMED',
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1'
    } as ReleaseBusV2TrainRecord;
    const membership = (
      candidateId: string,
      role: 'NEW' | 'CARRY_FORWARD',
      sequence: number
    ) => ({
      id: `membership-${candidateId}`,
      train_id: train.id,
      candidate_id: candidateId,
      sequence,
      disposition: 'INCLUDED' as const,
      candidate_role: role,
      created_at: 1
    });
    const context = {
      train,
      memberships: [
        membership(api.id, 'NEW', 1),
        membership(worker.id, 'NEW', 2),
        membership(carried.id, 'CARRY_FORWARD', 3),
        membership(frontend.id, 'NEW', 4)
      ],
      candidates: [api, worker, carried, frontend],
      dependencies: []
    };

    expect(operationContributorCandidates(context, 'backend', 'api')).toEqual([
      api
    ]);
    expect(
      operationContributorCandidates(context, 'backend', 'claimsBuilder')
    ).toEqual([worker]);
    expect(operationContributorCandidates(context, 'frontend')).toEqual([
      frontend
    ]);
  });

  it('uses only the explicit included production subset for contributor scope', () => {
    const selected = candidate('selected', 'a'.repeat(40));
    const unrelated = candidate('unrelated', 'b'.repeat(40));
    const train = {
      id: 'train-production-subset',
      lane: 'PRODUCTION',
      status: 'CLAIMED',
      staging_policy: null
    } as ReleaseBusV2TrainRecord;
    const context = {
      train,
      memberships: [
        {
          id: 'membership-selected',
          train_id: train.id,
          candidate_id: selected.id,
          sequence: 1,
          disposition: 'INCLUDED' as const,
          candidate_role: 'NEW' as const,
          created_at: 1
        },
        {
          id: 'membership-unrelated',
          train_id: train.id,
          candidate_id: unrelated.id,
          sequence: 2,
          disposition: 'AUDIT_ONLY' as const,
          candidate_role: 'CARRY_FORWARD' as const,
          created_at: 1
        }
      ],
      candidates: [selected, unrelated],
      dependencies: []
    };

    expect(operationContributorCandidates(context, 'backend', 'api')).toEqual([
      selected
    ]);
  });

  it('uses the bounded legacy preparation bridge when transition-only work has no source candidate', () => {
    expect(candidateEvidenceSelectionForPreparation([], null)).toEqual({
      mode: 'legacy-whole-train',
      aggregateDigest: null,
      singular: null
    });
  });

  it('mutates only new candidate statuses during cumulative staging preparation', () => {
    const carried = candidate('carried', 'a'.repeat(40));
    const added = candidate('added', 'b'.repeat(40));
    const stagingTrain: ReleaseBusV2TrainRecord = {
      id: 'train-cumulative-statuses',
      lane: 'STAGING',
      status: 'CLAIMED',
      frontend_base_sha: 'c'.repeat(40),
      backend_base_sha: 'd'.repeat(40),
      frontend_composed_sha: null,
      backend_composed_sha: null,
      frontend_artifact_digest: null,
      backend_artifact_digest: null,
      manifest_id: null,
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'manifest-before',
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
    const context = {
      train: stagingTrain,
      memberships: [
        {
          id: 'membership-carried',
          train_id: stagingTrain.id,
          candidate_id: carried.id,
          sequence: 1,
          disposition: 'INCLUDED',
          candidate_role: 'CARRY_FORWARD',
          created_at: 1
        },
        {
          id: 'membership-added',
          train_id: stagingTrain.id,
          candidate_id: added.id,
          sequence: 2,
          disposition: 'INCLUDED',
          candidate_role: 'NEW',
          created_at: 1
        }
      ],
      candidates: [carried, added],
      dependencies: []
    };

    expect(candidateStatusMutationCandidates(context)).toEqual([added]);
  });

  it('keeps the admitted state unchanged while a failed cumulative train enters rollback', async () => {
    const train: ReleaseBusV2TrainRecord = {
      id: 'train-cumulative',
      lane: 'STAGING',
      status: 'E2E_RUNNING',
      frontend_base_sha: 'a'.repeat(40),
      backend_base_sha: 'b'.repeat(40),
      frontend_composed_sha: 'c'.repeat(40),
      backend_composed_sha: 'd'.repeat(40),
      frontend_artifact_digest: 'e'.repeat(64),
      backend_artifact_digest: 'f'.repeat(64),
      manifest_id: 'failed-manifest',
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'validated-manifest-a',
      staging_transition_json: null,
      failure_class: null,
      failure_message: null,
      recovery_message: null,
      phase_started_at: 1,
      completed_at: null,
      created_at: 1,
      updated_at: 1,
      row_version: 4
    };
    const updateTrain = jest.fn(async () => true);
    const updateStagingState = jest.fn();
    const updateCandidate = jest.fn();
    const repository = {
      updateManifestStatus: jest.fn(async () => undefined),
      appendEvent: jest.fn(async () => undefined),
      findTrain: jest.fn(async () => train),
      updateTrain,
      updateStagingState,
      updateCandidate
    };
    const reconciler = new ReleaseBusV2Reconciler(
      repository as never,
      {} as never
    ) as unknown as {
      beginCumulativeStagingRollback(
        train: ReleaseBusV2TrainRecord,
        failureClass: ReleaseBusV2FailureClass,
        message: string
      ): Promise<void>;
    };

    await reconciler.beginCumulativeStagingRollback(
      train,
      'E2E',
      'new candidate B failed'
    );

    expect(updateTrain).toHaveBeenCalledWith(
      train.id,
      train.row_version,
      expect.objectContaining({
        status: 'STAGING_ROLLING_BACK',
        failureClass: 'E2E',
        failureMessage: 'new candidate B failed'
      }),
      {}
    );
    expect(updateStagingState).not.toHaveBeenCalled();
    expect(updateCandidate).not.toHaveBeenCalled();
  });

  it('records rollback failure under the authoritative staging row lock before pausing', async () => {
    jest
      .spyOn(releaseBusGitHubApp, 'resolveRefIfExists')
      .mockImplementation(async (repository) =>
        repository === 'frontend' ? 'f'.repeat(40) : 'b'.repeat(40)
      );
    const train: ReleaseBusV2TrainRecord = {
      id: 'train-rollback-failed',
      lane: 'STAGING',
      status: 'STAGING_ROLLING_BACK',
      frontend_base_sha: 'a'.repeat(40),
      backend_base_sha: 'b'.repeat(40),
      frontend_composed_sha: 'c'.repeat(40),
      backend_composed_sha: 'd'.repeat(40),
      frontend_artifact_digest: 'e'.repeat(64),
      backend_artifact_digest: 'f'.repeat(64),
      manifest_id: 'rollback-manifest',
      parent_train_id: null,
      qualification_identity_sha256: null,
      qualification_train_id: null,
      staging_policy: 'CUMULATIVE_ADMITTED_SET_V1',
      staging_baseline_manifest_id: 'validated-manifest-a',
      staging_transition_json: null,
      failure_class: 'E2E',
      failure_message: 'candidate manifest failed',
      recovery_message: null,
      phase_started_at: 1,
      completed_at: null,
      created_at: 1,
      updated_at: 1,
      row_version: 4
    };
    const connection = {};
    let stagingState = {
      id: 'current',
      status: 'LIVE' as string,
      current_manifest_id: train.staging_baseline_manifest_id as string | null,
      last_validated_manifest_id: train.staging_baseline_manifest_id,
      frontend_sha: 'a'.repeat(40),
      backend_sha: 'b'.repeat(40),
      frontend_staging_ref_sha: 'a'.repeat(40),
      backend_staging_ref_sha: 'b'.repeat(40),
      clean_main: false,
      last_transition_train_id: 'prior-train',
      updated_at: 1,
      row_version: 7
    };
    let currentTrain = train;
    let stagingPaused = false;
    const getStagingState = jest.fn(async () => stagingState);
    const updateStagingState = jest.fn(
      async (
        rowVersion: number,
        fields: {
          status: string;
          currentManifestId: string | null;
          lastTransitionTrainId: string;
        }
      ) => {
        if (rowVersion !== stagingState.row_version) return false;
        stagingState = {
          ...stagingState,
          status: fields.status,
          current_manifest_id: fields.currentManifestId,
          last_transition_train_id: fields.lastTransitionTrainId,
          row_version: rowVersion + 1
        };
        return true;
      }
    );
    const updateTrain = jest.fn(
      async (
        _id: string,
        rowVersion: number,
        fields: Partial<ReleaseBusV2TrainRecord>
      ) => {
        if (rowVersion !== currentTrain.row_version) return false;
        currentTrain = {
          ...currentTrain,
          ...fields,
          row_version: rowVersion + 1
        };
        return true;
      }
    );
    const appendEvent = jest.fn(
      async (_event: unknown, _ctx: unknown) => undefined
    );
    const setControl = jest.fn(async () => {
      stagingPaused = true;
    });
    const repository = {
      executeNativeQueriesInTransaction: async (
        callback: (value: unknown) => unknown
      ) => callback(connection),
      getStagingState,
      updateStagingState,
      findTrain: jest.fn(async () => currentTrain),
      updateTrain,
      listControls: jest.fn(async () => [
        { scope: 'STAGING', paused: stagingPaused }
      ]),
      setControl,
      appendEvent,
      listLocks: jest.fn(async () => [])
    };
    const reconciler = new ReleaseBusV2Reconciler(
      repository as never,
      {} as never
    ) as unknown as {
      failCumulativeStagingRollback(
        context: {
          train: ReleaseBusV2TrainRecord;
          memberships: [];
          candidates: [];
          dependencies: [];
        },
        message: string
      ): Promise<void>;
    };

    await reconciler.failCumulativeStagingRollback(
      { train, memberships: [], candidates: [], dependencies: [] },
      'rollback deployment failed'
    );
    await reconciler.failCumulativeStagingRollback(
      { train, memberships: [], candidates: [], dependencies: [] },
      'rollback deployment failed'
    );

    expect(getStagingState).toHaveBeenCalledTimes(2);
    expect(getStagingState).toHaveBeenCalledWith({ connection }, true);
    expect(updateStagingState).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        status: 'ROLLBACK_FAILED',
        currentManifestId: null,
        lastTransitionTrainId: train.id
      }),
      { connection }
    );
    expect(updateStagingState).toHaveBeenCalledTimes(1);
    expect(setControl).toHaveBeenCalledWith(
      'STAGING',
      true,
      expect.stringContaining(train.id),
      'release-bus-v2',
      { connection }
    );
    expect(setControl).toHaveBeenCalledTimes(1);
    expect(updateTrain).toHaveBeenCalledWith(
      train.id,
      train.row_version,
      expect.objectContaining({ status: 'STAGING_ROLLBACK_FAILED' }),
      { connection }
    );
    expect(updateTrain).toHaveBeenCalledTimes(1);
    expect(
      appendEvent.mock.calls.filter(
        ([event]) =>
          (event as { eventType?: string }).eventType ===
          'CUMULATIVE_STAGING_ROLLBACK_FAILED'
      )
    ).toHaveLength(1);
  });

  it('deduplicates exact candidate contributor logins in train order', () => {
    const first = candidate('first', 'a'.repeat(40), {
      base_sha: 'b'.repeat(40),
      merge_sha: 'c'.repeat(40),
      checks_run_id: '1',
      checks_completed_at: 1,
      artifact_run_id: null,
      artifact_name: null,
      artifact_digest: null,
      contributor_github_logins: ['GelatoGenesis', 'ragnep', 'invalid login']
    });
    const second = candidate('second', 'd'.repeat(40), {
      base_sha: 'e'.repeat(40),
      merge_sha: 'f'.repeat(40),
      checks_run_id: '2',
      checks_completed_at: 2,
      artifact_run_id: null,
      artifact_name: null,
      artifact_digest: null,
      contributor_github_logins: [
        'gelatogenesis',
        'external-user',
        'dependabot[bot]'
      ]
    });

    expect(releaseTrainContributorGithubLogins([first, second])).toEqual([
      'GelatoGenesis',
      'ragnep',
      'external-user'
    ]);
  });

  it('sends only workflow-supported inputs to each E2E environment', () => {
    const fields = {
      release_train_id: 'train-1',
      release_train_revision: '1',
      operation_key: 'replaced-by-reconciler',
      staging_source_ref: 'release-bus-v2/train-1/frontend',
      expected_sha: 'a'.repeat(40),
      release_manifest_id: 'manifest-1',
      release_manifest_identity_sha256: 'b'.repeat(64),
      frontend_sha: 'a'.repeat(40),
      backend_sha: 'c'.repeat(40),
      frontend_artifact_digest: 'd'.repeat(64),
      backend_artifact_digest: 'e'.repeat(64)
    };

    expect(e2eWorkflowInputs('staging', fields)).toMatchObject({
      pack: 'all',
      source_ref: 'release-bus-v2/train-1/frontend'
    });
    expect(e2eWorkflowInputs('prod', fields)).toEqual(
      expect.objectContaining({ source_ref: 'main' })
    );
    expect(e2eWorkflowInputs('prod', fields)).not.toHaveProperty('pack');
  });

  it('never overwrites a candidate once superseded, including by its owning train', () => {
    const claimed = {
      ...candidate('claimed', 'a'.repeat(40)),
      status: 'PRODUCTION_DEPLOYING' as const,
      current_train_id: 'train-1'
    };
    expect(
      candidateUnavailableForTrainUpdate(
        { ...claimed, status: 'SUPERSEDED', superseded_at: 2 },
        claimed
      )
    ).toBe(true);
    expect(
      candidateUnavailableForTrainUpdate(
        {
          ...claimed,
          status: 'SUPERSEDED',
          current_train_id: null,
          superseded_at: 2
        },
        claimed
      )
    ).toBe(true);
    expect(
      candidateUnavailableForTrainUpdate(
        { ...claimed, current_train_id: 'newer-train' },
        claimed
      )
    ).toBe(true);
  });

  it('retains explicit production readiness only for a deleted exact head already on main', () => {
    const ready = {
      ...candidate('production-ready', 'a'.repeat(40)),
      status: 'READY_FOR_PRODUCTION' as const,
      staging_validated_manifest_id: 'manifest-1',
      production_requested_at: 2,
      production_requested_by: 'owner'
    };
    expect(deletedProductionCandidateCanRetainReadiness(ready)).toBe(true);
    expect(
      deletedProductionCandidateCanRetainReadiness({
        ...ready,
        current_train_id: 'active-train'
      })
    ).toBe(false);
    expect(
      deletedProductionCandidateCanRetainReadiness({
        ...ready,
        staging_validated_manifest_id: null
      })
    ).toBe(false);
  });

  it('orders backend DAG frontiers while preserving independent concurrency', () => {
    expect(
      dagLayers(
        ['api', 'worker-a', 'worker-b', 'migration'],
        [
          ['migration', 'api'],
          ['migration', 'worker-a']
        ]
      )
    ).toEqual([
      ['migration', 'worker-b'],
      ['api', 'worker-a']
    ]);
    expect(
      topologicalOrder(['api', 'migration'], [['migration', 'api']])
    ).toEqual(['migration', 'api']);
  });

  it('always includes selected registry dependency edges', () => {
    expect(
      normalizeDeployPlan('backend', {
        units: ['api', 'releaseBus'],
        edges: []
      })
    ).toEqual({
      units: ['api', 'releaseBus'],
      edges: [['api', 'releaseBus']]
    });
  });

  it('keeps v2 release notes PR-scoped across overlapping service plans', () => {
    const first = {
      ...candidate('first', 'd'.repeat(40)),
      pr_number: 1801,
      deploy_plan_json: { units: ['worker', 'api'], edges: [] }
    };
    const second = {
      ...candidate('second', 'e'.repeat(40)),
      pr_number: 1802,
      deploy_plan_json: { units: ['api'], edges: [] }
    };
    const internal = {
      ...candidate('internal', 'f'.repeat(40)),
      pr_number: 1803,
      deploy_plan_json: {
        units: ['api'],
        edges: [],
        publish_release_notes: false
      }
    };

    expect(backendReleaseNoteGroups([first, second, internal], 'api')).toEqual([
      {
        release_group_id: 'pr-1801',
        release_group_services: ['api', 'worker'],
        pull_request_number: 1801,
        publish_release_note: true
      },
      {
        release_group_id: 'pr-1802',
        release_group_services: ['api'],
        pull_request_number: 1802,
        publish_release_note: true
      }
    ]);
    expect(
      backendReleaseNoteGroups([first, second, internal], 'worker')
    ).toEqual([
      {
        release_group_id: 'pr-1801',
        release_group_services: ['api', 'worker'],
        pull_request_number: 1801,
        publish_release_note: true
      }
    ]);
  });

  it('preserves an explicit release-note opt-out in a backend deploy plan', () => {
    expect(
      normalizeDeployPlan('backend', {
        units: ['api'],
        edges: [],
        publish_release_notes: false
      })
    ).toEqual({
      units: ['api'],
      edges: [],
      publish_release_notes: false
    });
  });

  it('serializes mixed overlapping groups and explicit opt-outs unambiguously', () => {
    const first = {
      ...candidate('first', 'd'.repeat(40)),
      pr_number: 1801,
      deploy_plan_json: { units: ['worker', 'api'], edges: [] }
    };
    const second = {
      ...candidate('second', 'e'.repeat(40)),
      pr_number: 1802,
      deploy_plan_json: { units: ['api'], edges: [] }
    };
    const internal = {
      ...candidate('internal', 'f'.repeat(40)),
      pr_number: 1803,
      deploy_plan_json: {
        units: ['releaseBus'],
        edges: [],
        publish_release_notes: false
      }
    };

    expect(
      backendReleaseNoteInputs([first, second, internal], 'api', 'prod')
    ).toEqual({
      release_pull_request: '',
      release_group_services: '',
      release_note_publish: 'false',
      release_note_groups: JSON.stringify([
        {
          release_group_id: 'pr-1801',
          release_group_services: ['api', 'worker'],
          pull_request_number: 1801,
          publish_release_note: true
        },
        {
          release_group_id: 'pr-1802',
          release_group_services: ['api'],
          pull_request_number: 1802,
          publish_release_note: true
        }
      ]),
      release_note_opt_out: 'false'
    });
    expect(
      backendReleaseNoteInputs([first, second, internal], 'releaseBus', 'prod')
    ).toEqual({
      release_pull_request: '',
      release_group_services: '',
      release_note_publish: 'false',
      release_note_groups: '[]',
      release_note_opt_out: 'true'
    });
  });

  it('preserves registry dependencies across separate candidates', () => {
    const migration = candidate('migration', 'd'.repeat(40));
    const api = candidate('api', 'e'.repeat(40));
    expect(
      backendGraph([
        {
          ...migration,
          deploy_plan_json: { units: ['dbMigrationsLoop'], edges: [] }
        },
        { ...api, deploy_plan_json: { units: ['api'], edges: [] } }
      ]).layers
    ).toEqual([['dbMigrationsLoop'], ['api']]);
  });

  it('filters production-only backend units from staging without changing production', () => {
    const planned = {
      ...candidate('environment-scoped', 'd'.repeat(40)),
      deploy_plan_json: {
        units: ['api', 'releaseBus'],
        edges: [['api', 'releaseBus']] as Array<readonly [string, string]>
      }
    };

    expect(backendGraph([planned], 'staging')).toEqual({
      units: ['api'],
      edges: [],
      layers: [['api']]
    });
    expect(backendGraph([planned], 'prod')).toEqual({
      units: ['api', 'releaseBus'],
      edges: [['api', 'releaseBus']],
      layers: [['api'], ['releaseBus']]
    });
  });

  it('preserves ordering across a backend unit filtered from the environment', () => {
    const planned = {
      ...candidate('projected-ordering', 'd'.repeat(40)),
      deploy_plan_json: {
        units: ['dbMigrationsLoop', 'mediaResizerLoop', 'ethPriceLoop'],
        edges: [
          ['dbMigrationsLoop', 'mediaResizerLoop'],
          ['mediaResizerLoop', 'ethPriceLoop']
        ] as Array<readonly [string, string]>
      }
    };

    expect(backendGraph([planned], 'staging')).toEqual({
      units: ['dbMigrationsLoop', 'ethPriceLoop'],
      edges: [['dbMigrationsLoop', 'ethPriceLoop']],
      layers: [['dbMigrationsLoop'], ['ethPriceLoop']]
    });
  });

  it('fails closed on dependency cycles', () => {
    expect(() =>
      dagLayers(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a']
        ]
      )
    ).toThrow('cycle');
  });

  it('excludes all transitive dependants of a conflicting candidate', () => {
    const closure = candidateExclusionClosure(
      ['a'],
      [
        {
          candidate_id: 'b',
          prerequisite_candidate_id: 'a'
        },
        {
          candidate_id: 'c',
          prerequisite_candidate_id: 'b'
        }
      ]
    );
    expect(Array.from(closure).sort()).toEqual(['a', 'b', 'c']);
  });

  it('reuses an exact green PR merge tree only against its recorded base', () => {
    const base = 'a'.repeat(40);
    const merge = 'b'.repeat(40);
    const item = candidate('candidate', 'c'.repeat(40), {
      base_sha: base,
      merge_sha: merge,
      checks_run_id: '123',
      checks_completed_at: 1,
      artifact_run_id: null,
      artifact_name: null,
      artifact_digest: null
    });
    expect(canUseSingleCandidateFastPath(item, base)).toBe(true);
    expect(canUseSingleCandidateFastPath(item, 'd'.repeat(40))).toBe(false);
  });

  it('uses immutable lane-scoped release refs', () => {
    expect(
      releaseBusV2Branch(
        { id: 'train-id', lane: 'PRODUCTION_QUALIFICATION' },
        'frontend'
      )
    ).toBe('release-bus-v2/qualification-train-train-id-frontend');
  });
});
