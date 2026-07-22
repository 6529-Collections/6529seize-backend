import {
  buildReleaseTrainOverview,
  projectReleaseCandidate
} from '@/releaseBus/release-bus-status.service';
import type {
  ReleaseOperationRecord,
  ReleaseTrainEventRecord,
  ReleaseTrainItemRecord
} from '@/releaseBus/release-bus.repository';
import type {
  ReleaseCandidateRecord,
  ReleaseTrainRecord
} from '@/releaseBus/release-bus.types';

const NOW = 1_800_000_000_000;
const BASE_SHA = 'a'.repeat(40);

const train: ReleaseTrainRecord = {
  id: 'train-1',
  revision: 1,
  target_lane: 'STAGING',
  status: 'BASE_CANARY_RUNNING',
  cutoff_at: NOW - 2_000,
  frontend_base_sha: BASE_SHA,
  backend_base_sha: 'b'.repeat(40),
  frontend_release_branch: null,
  backend_release_branch: null,
  frontend_pr_number: null,
  backend_pr_number: null,
  state_machine_execution_arn: null,
  worker_version: '1',
  failure_reason: null,
  started_at: NOW - 30 * 60_000,
  completed_at: null,
  created_at: NOW - 30 * 60_000,
  updated_at: NOW - 1_000,
  row_version: 1
};

const candidate: ReleaseCandidateRecord = {
  id: 'candidate-1',
  repository: 'frontend',
  branch_name: 'feature/example',
  head_sha: 'c'.repeat(40),
  pr_number: 3301,
  status: 'STAGING_CLAIMED',
  staging_ready_by_github_login: 'developer',
  staging_ready_at: NOW - 60_000,
  production_ready_by_github_login: null,
  production_ready_at: null,
  deploy_plan_json: null,
  force_fresh_base_canary: false,
  metadata_version: 1,
  current_train_id: 'train-1',
  hold_reason: null,
  invalidated_at: null,
  released_at: null,
  created_at: NOW - 60_000,
  updated_at: NOW - 60_000,
  row_version: 1
};

const item: ReleaseTrainItemRecord = {
  id: 'item-1',
  train_id: 'train-1',
  revision: 1,
  candidate_id: candidate.id,
  sequence: 1,
  status: 'INCLUDED',
  hold_reason: null,
  created_at: NOW - 60_000,
  updated_at: NOW - 60_000
};

function operation(status: ReleaseOperationRecord['status']) {
  return {
    id: 'operation-1',
    operation_key: 'operation-key',
    train_id: 'train-1',
    revision: 1,
    operation_type: 'base-canary-frontend',
    repository: 'frontend',
    environment: 'orchestration',
    service: null,
    expected_sha: BASE_SHA,
    artifact_digest: null,
    attempt: 1,
    status,
    external_id: '29816499825',
    request_metadata_json: {},
    result_metadata_json: {
      url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/29816499825',
      workflow_status: status === 'FAILED' ? 'completed' : 'in_progress',
      workflow_conclusion: status === 'FAILED' ? 'failure' : null,
      active_job: status === 'FAILED' ? null : 'gate',
      active_step: status === 'FAILED' ? null : 'Run unit tests',
      failed_job: status === 'FAILED' ? 'gate' : null,
      failed_step: status === 'FAILED' ? 'Run unit tests' : null,
      last_progress_at: NOW - 30 * 60_000,
      gate_report: {
        jest: {
          failing_suites: ['wavesCreatePageClient.test.tsx'],
          failing_tests: [
            {
              suite: 'wavesCreatePageClient.test.tsx',
              test: 'renders the create page'
            }
          ]
        }
      }
    },
    started_at: NOW - 30 * 60_000,
    completed_at: status === 'FAILED' ? NOW : null,
    created_at: NOW - 30 * 60_000,
    updated_at: NOW,
    row_version: 1
  } satisfies ReleaseOperationRecord;
}

function overview(
  operationStatus: ReleaseOperationRecord['status'],
  trainOverride: Partial<ReleaseTrainRecord> = {},
  candidateOverride: Partial<ReleaseCandidateRecord> = {},
  controlOverride: { paused?: boolean; reason?: string | null } = {},
  events: ReleaseTrainEventRecord[] = []
) {
  return buildReleaseTrainOverview({
    train: { ...train, ...trainOverride },
    items: [item],
    candidates: [{ ...candidate, ...candidateOverride }],
    operations: [operation(operationStatus)],
    events,
    lanes: [
      {
        name: 'global-orchestration',
        train_id: 'train-1',
        lease_owner: 'step-functions:train-1',
        lease_token: 'not-exposed',
        heartbeat_at: NOW - 5_000,
        expires_at: NOW + 55_000,
        updated_at: NOW - 5_000,
        row_version: 1
      }
    ],
    controls: [
      {
        scope: 'STAGING',
        paused: controlOverride.paused ?? false,
        reason: controlOverride.reason ?? null,
        github_actor: null,
        updated_at: NOW,
        row_version: 1
      }
    ],
    now: NOW
  });
}

describe('release train status view', () => {
  it('explains a healthy base canary and says candidates are untested', () => {
    const result = overview('RUNNING');

    expect(result.phase).toBe('BASE_CANARY_RUNNING');
    expect(result.phase_state).toBe('RUNNING');
    expect(result.wait_reason?.summary).toContain(
      'Candidates have not been tested yet'
    );
    expect(result.current_operation?.active_step).toBe('Run unit tests');
    expect(result.latest_worker_heartbeat_at).toBe(NOW - 5_000);
    expect(result.leases[0]).not.toHaveProperty('lease_token');
  });

  it('surfaces the exact evidence miss and fresh-validation action', () => {
    const result = overview('RUNNING', {}, {}, {}, [
      {
        id: 'event-lookup',
        train_id: train.id,
        candidate_id: null,
        event_type: 'BASE_CANARY_EVIDENCE_LOOKUP_DECIDED',
        github_actor: null,
        payload_json: {
          decision: 'MISS',
          reason: 'workflow_digest_mismatch',
          action: 'fresh_validation',
          configuration_source: 'deployed_fallback'
        },
        created_at: NOW - 500
      }
    ]);

    expect(result.base_evidence).toMatchObject({
      decision: 'FRESH_EXECUTING',
      canary_skipped: false,
      lookup_decision: 'MISS',
      lookup_reason: 'workflow_digest_mismatch',
      lookup_action: 'fresh_validation',
      configuration_source: 'deployed_fallback'
    });
    expect(result.base_evidence.summary).toContain(
      'MISS (workflow_digest_mismatch); action: fresh_validation'
    );
    expect(result.timeline[0]).toMatchObject({
      event_type: 'BASE_CANARY_EVIDENCE_LOOKUP_DECIDED',
      decision: 'MISS',
      reason: 'workflow_digest_mismatch',
      action: 'fresh_validation'
    });
  });

  it('attributes a base failure to the base and quarantines nobody', () => {
    const result = overview(
      'FAILED',
      {
        status: 'FAILED',
        failure_reason: 'The fresh frontend base failed its exact canary',
        completed_at: NOW
      },
      {
        status: 'READY_FOR_STAGING',
        current_train_id: null,
        hold_reason: 'BASE_FAILURE_NO_CANDIDATE_BLAMED'
      }
    );

    expect(result.incident).toEqual(
      expect.objectContaining({
        attribution: 'PRE_EXISTING_BASE',
        quarantined_candidates: [],
        returned_candidates: ['candidate-1'],
        failed_job: 'gate',
        failed_step: 'Run unit tests',
        failing_suites: ['wavesCreatePageClient.test.tsx']
      })
    );
    expect(result.incident?.summary).toContain('No candidate was blamed');
  });

  it('does not attribute a later lane pause to a completed train', () => {
    const result = overview(
      'SUCCEEDED',
      {
        status: 'COMPLETED',
        completed_at: NOW,
        failure_reason: null
      },
      { status: 'STAGING_VALIDATED' },
      {
        paused: true,
        reason: 'Reserved after successful staging validation'
      }
    );

    expect(result.phase).toBe('COMPLETED');
    expect(result.phase_state).toBe('COMPLETED');
    expect(result.incident).toBeNull();
  });

  it('distinguishes a carried-forward skip and its source proof from a fresh canary', () => {
    const result = overview(
      'SUCCEEDED',
      { status: 'COMPLETED', completed_at: NOW },
      { status: 'STAGING_VALIDATED' },
      {},
      [
        {
          id: 'event-reuse',
          train_id: train.id,
          candidate_id: null,
          event_type: 'BASE_CANARY_EVIDENCE_REUSED',
          github_actor: null,
          payload_json: {
            source_train_id: 'train-source',
            source_run_id: '12345',
            source_evidence_id: 'evidence-source',
            source_evidence_type: 'BASE_EVIDENCE_PROMOTED',
            evidence_uri:
              'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
            source_artifact_digest: 'f'.repeat(64)
          },
          created_at: NOW - 500
        }
      ]
    );

    expect(result.base_evidence).toMatchObject({
      decision: 'CARRIED_FORWARD_REUSED',
      canary_skipped: true,
      source_train_id: 'train-source',
      source_run_id: '12345',
      source_evidence_type: 'BASE_EVIDENCE_PROMOTED',
      source_artifact_digest: 'f'.repeat(64)
    });
    expect(result.base_evidence.summary).toContain('Base canary skipped');
  });
});

describe('release candidate exact-SHA projection', () => {
  it('makes an old validated SHA and a newer unregistered branch head unmistakable', () => {
    const oldSha = '28c9f12373c65886b609accaf1a41c38d190b990';
    const newSha = '820f0e98183a1ab62ce88e942cda27375f46781f';

    expect(
      projectReleaseCandidate({
        ...candidate,
        id: 'a61dad7f-3085-4d8c-953c-2f2e1dc807cd',
        repository: 'backend',
        branch_name: 'agent/fix-attachment-realtime-race-be',
        head_sha: oldSha,
        status: 'SUPERSEDED',
        current_train_id: null,
        hold_reason: `Branch moved to ${newSha}`
      })
    ).toMatchObject({
      status: 'SUPERSEDED',
      immutable_head_sha: oldSha,
      immutable_validation_scope: 'EXACT_SHA',
      head_relation: 'SUPERSEDED_BY_UNREGISTERED_HEAD',
      unregistered_branch_head_sha: newSha,
      requires_new_readiness: true,
      status_summary: expect.stringContaining(newSha)
    });
  });
});
