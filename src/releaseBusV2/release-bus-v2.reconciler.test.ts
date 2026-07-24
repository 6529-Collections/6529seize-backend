import {
  backendGraph,
  backendReleaseNoteInputs,
  backendReleaseNoteGroups,
  canUseSingleCandidateFastPath,
  candidateUnavailableForTrainUpdate,
  candidateExclusionClosure,
  dagLayers,
  releaseBusV2Branch
} from '@/releaseBusV2/release-bus-v2.reconciler';
import {
  normalizeDeployPlan,
  topologicalOrder
} from '@/releaseBusV2/release-bus-v2.service';
import type {
  ReleaseBusV2CandidateRecord,
  ReleaseBusV2PrEvidence
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
