import {
  currentTrainPhase,
  leaseWaitReason,
  operationStaleAfterMs,
  toOperationView
} from '@/releaseBus/release-bus.observability';
import type { ReleaseOperationRecord } from '@/releaseBus/release-bus.repository';
import type { ReleaseTrainRecord } from '@/releaseBus/release-bus.types';

const NOW = Date.parse('2026-07-21T10:00:00Z');

function operation(
  overrides: Partial<ReleaseOperationRecord> = {}
): ReleaseOperationRecord {
  return {
    id: 'operation-1',
    operation_key: 'operation-key',
    train_id: 'train-1',
    revision: 1,
    operation_type: 'base-canary-frontend',
    repository: 'frontend',
    environment: 'orchestration',
    service: null,
    expected_sha: 'a'.repeat(40),
    artifact_digest: null,
    attempt: 1,
    status: 'RUNNING',
    external_id: '29816499825',
    request_metadata_json: {},
    result_metadata_json: {
      url: 'https://github.com/6529-Collections/6529seize-frontend/actions/runs/29816499825',
      workflow_status: 'in_progress',
      active_job: 'gate',
      active_step: 'Run unit tests',
      last_progress_at: NOW - 30 * 60 * 1000
    },
    started_at: NOW - 35 * 60 * 1000,
    completed_at: null,
    created_at: NOW - 35 * 60 * 1000,
    updated_at: NOW - 30 * 60 * 1000,
    row_version: 1,
    ...overrides
  };
}

function train(status: ReleaseTrainRecord['status']): ReleaseTrainRecord {
  return {
    id: 'train-1',
    revision: 1,
    target_lane: 'STAGING',
    status,
    cutoff_at: NOW - 40 * 60 * 1000,
    frontend_base_sha: 'a'.repeat(40),
    backend_base_sha: 'b'.repeat(40),
    frontend_release_branch: null,
    backend_release_branch: null,
    frontend_pr_number: null,
    backend_pr_number: null,
    state_machine_execution_arn: null,
    worker_version: '1',
    failure_reason: null,
    started_at: NOW - 40 * 60 * 1000,
    completed_at: null,
    created_at: NOW - 40 * 60 * 1000,
    updated_at: NOW - 30 * 60 * 1000,
    row_version: 1
  };
}

describe('release bus observability', () => {
  it('keeps a 30-minute base canary running instead of blaming a lease', () => {
    const view = toOperationView(operation(), NOW);

    expect(view.phase).toBe('BASE_CANARY_RUNNING');
    expect(view.health).toBe('RUNNING');
    expect(view.active_step).toBe('Run unit tests');
    expect(view.stalled_reason).toBeNull();
    expect(view.stale_after_ms).toBe(
      operationStaleAfterMs('base-canary-frontend')
    );
  });

  it('marks a workflow stalled only after its deterministic threshold', () => {
    const view = toOperationView(
      operation({
        result_metadata_json: {
          workflow_status: 'in_progress',
          last_progress_at: NOW - 61 * 60 * 1000
        }
      }),
      NOW
    );

    expect(view.health).toBe('STALLED');
    expect(view.stalled_reason).toBe('GITHUB_WORKFLOW_NO_RECENT_PROGRESS');
  });

  it('does not let a future progress timestamp mask a stalled operation', () => {
    const view = toOperationView(
      operation({
        started_at: NOW - 61 * 60 * 1000,
        result_metadata_json: {
          workflow_status: 'in_progress',
          last_progress_at: NOW + 24 * 60 * 60 * 1000
        }
      }),
      NOW
    );

    expect(view.health).toBe('STALLED');
    expect(view.last_progress_at).toBeNull();
    expect(view.stalled_reason).toBe('GITHUB_WORKFLOW_NO_RECENT_PROGRESS');
  });

  it('rejects an untrusted operation URL from the operator response', () => {
    const view = toOperationView(
      operation({ result_metadata_json: { url: 'javascript:alert(1)' } }),
      NOW
    );

    expect(view.workflow_url).toBeNull();
  });

  it('projects structured gate evidence without exposing raw logs', () => {
    const view = toOperationView(
      operation({
        result_metadata_json: {
          gate_report: {
            phase: 'unit_tests',
            status: 'FAILED',
            raw_logs: 'secret output must not cross the API boundary',
            jest: {
              num_failed_test_suites: 1,
              num_failed_tests: 1,
              failing_suites: ['suite.test.ts\u0000'],
              failing_tests: [{ suite: 'suite.test.ts', test: 'fails safely' }],
              failure_messages: ['raw stack']
            }
          }
        }
      }),
      NOW
    );

    expect(view.gate_report).toEqual(
      expect.objectContaining({
        phase: 'unit_tests',
        jest: expect.objectContaining({
          failing_suites: ['suite.test.ts']
        })
      })
    );
    expect(JSON.stringify(view.gate_report)).not.toContain('raw_logs');
    expect(JSON.stringify(view.gate_report)).not.toContain('raw stack');
  });

  it('shows explicit active and paused train phases', () => {
    expect(
      currentTrainPhase(train('BASE_CANARY_RUNNING'), [operation()], false)
    ).toBe('BASE_CANARY_RUNNING');
    expect(currentTrainPhase(train('PREFLIGHTING'), [], true)).toBe('PAUSED');
  });

  it('includes lease ownership only for a real lease wait', () => {
    expect(
      leaseWaitReason('global-orchestration', {
        name: 'global-orchestration',
        train_id: 'other-train',
        lease_owner: 'step-functions:other-train',
        lease_token: 'token',
        heartbeat_at: NOW - 5_000,
        expires_at: NOW + 55_000,
        updated_at: NOW - 5_000,
        row_version: 1
      })
    ).toEqual(
      expect.objectContaining({
        code: 'LEASE_UNAVAILABLE',
        lease: expect.objectContaining({
          owner: 'step-functions:other-train',
          heartbeat_at: NOW - 5_000,
          expires_at: NOW + 55_000
        })
      })
    );
  });
});
