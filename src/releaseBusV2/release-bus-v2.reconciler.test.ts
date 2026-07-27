import {
  backendGraph,
  backendReleaseNoteInputs,
  backendReleaseNoteGroups,
  canUseSingleCandidateFastPath,
  candidateUnavailableForTrainUpdate,
  deletedProductionCandidateCanRetainReadiness,
  candidateExclusionClosure,
  dagLayers,
  e2eWorkflowInputs,
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
    hold_reason: null,
    superseded_at: null,
    created_at: 1,
    updated_at: 1,
    row_version: 1
  };
}

describe('Release Bus v2 deterministic orchestration', () => {
  it('omits removal candidates from composition but redeploys their exact runtime units', () => {
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
    expect(stagingDeploymentCandidates(context, 'backend')).toEqual([
      carried,
      removed
    ]);
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
      'external-user',
      'dependabot[bot]'
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

  it('keeps an immutable active membership authoritative over stale superseded bookkeeping', () => {
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
    ).toBe(false);
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
