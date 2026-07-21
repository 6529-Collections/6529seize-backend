import {
  DeployDispatchBodySchema,
  ReleaseBusAuthorizationBodySchema,
  ReleaseBusBreakGlassAuthorizationBodySchema,
  ReleaseBusProgressReportBodySchema,
  ReleaseCandidateReadyBodySchema
} from '@/api/deploy/deploy.validation';

describe('deploy.validation', () => {
  it('accepts a valid deploy batch request', () => {
    const { error, value } = DeployDispatchBodySchema.validate({
      ref: 'feature/deploy-ui',
      environment: 'staging',
      services: ['api', 'tdhLoop']
    });

    expect(error).toBeUndefined();
    expect(value.ref).toBe('feature/deploy-ui');
  });

  it('rejects duplicate services', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api', 'api']
    });

    expect(error).toBeDefined();
  });

  it('rejects refs with whitespace or shell-ish separators', () => {
    const invalidRefs = ['feature branch', 'main;rm -rf /', '$(whoami)'];

    invalidRefs.forEach((ref) => {
      const { error } = DeployDispatchBodySchema.validate({
        ref,
        environment: 'staging',
        services: ['api']
      });

      expect(error).toBeDefined();
    });
  });

  it('accepts an immutable cross-repository release candidate', () => {
    const { error, value } = ReleaseCandidateReadyBodySchema.validate({
      repository: 'frontend',
      branch: 'feature/ui',
      expected_head_sha: 'a'.repeat(40),
      target_lane: 'STAGING',
      dependencies: [{ repository: 'backend', branch: 'feature/api' }],
      deploy_plan: null
    });

    expect(error).toBeUndefined();
    expect(value.force_fresh_base_canary).toBe(false);
  });

  it('accepts an explicit frontend force-fresh base-canary choice', () => {
    const { error, value } = ReleaseCandidateReadyBodySchema.validate({
      repository: 'frontend',
      branch: 'feature/ui',
      expected_head_sha: 'a'.repeat(40),
      target_lane: 'STAGING',
      dependencies: [],
      deploy_plan: null,
      force_fresh_base_canary: true
    });

    expect(error).toBeUndefined();
    expect(value.force_fresh_base_canary).toBe(true);
  });

  it('requires workflow and artifact run identity at the mutation gate', () => {
    const { error } = ReleaseBusAuthorizationBodySchema.validate({
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      artifact_run_id: '12340',
      repository: 'backend',
      environment: 'prod',
      service: 'api',
      expected_sha: 'b'.repeat(40),
      artifact_digest: 'c'.repeat(64)
    });

    expect(error).toBeUndefined();
  });

  it('requires an artifact digest when an artifact run is supplied', () => {
    const deployment = {
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      artifact_run_id: '12340',
      repository: 'backend',
      environment: 'prod',
      service: 'api',
      expected_sha: 'b'.repeat(40),
      artifact_digest: null
    };

    expect(
      ReleaseBusAuthorizationBodySchema.validate(deployment).error
    ).toBeDefined();
  });

  it.each([
    ['staging', 'e2e-staging', 'frontend'],
    ['prod', 'e2e-prod', 'frontend'],
    ['staging', 'sync-staging-frontend', 'frontend'],
    ['staging', 'sync-staging-backend', 'backend']
  ])(
    'allows the artifact-free %s %s operation',
    (environment, operation, repository) => {
      const { error } = ReleaseBusAuthorizationBodySchema.validate({
        train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
        operation_key: `rb:train-id:r1:${operation}:${'a'.repeat(32)}:a1`,
        workflow_run_id: '12345',
        artifact_run_id: null,
        repository,
        environment,
        service: null,
        expected_sha: 'b'.repeat(40),
        artifact_digest: null
      });

      expect(error).toBeUndefined();
    }
  );

  it('rejects an artifact-free production deploy operation', () => {
    const { error } = ReleaseBusAuthorizationBodySchema.validate({
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: `rb:train-id:r1:deploy-frontend-prod:${'a'.repeat(32)}:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'prod',
      service: null,
      expected_sha: 'b'.repeat(40),
      artifact_digest: null
    });

    expect(error).toBeDefined();
  });

  it('allows artifact-free orchestration operations', () => {
    const { error } = ReleaseBusAuthorizationBodySchema.validate({
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: 'b'.repeat(40),
      artifact_digest: null
    });

    expect(error).toBeUndefined();
  });

  it('requires an audited break-glass identity and reason', () => {
    expect(
      ReleaseBusBreakGlassAuthorizationBodySchema.validate({
        workflow_run_id: '12345',
        repository: 'frontend',
        environment: 'prod',
        service: null,
        expected_sha: 'd'.repeat(40),
        reason: 'Emergency rollback to the last healthy version'
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusBreakGlassAuthorizationBodySchema.validate({
        workflow_run_id: '12345',
        repository: 'frontend',
        environment: 'prod',
        service: null,
        expected_sha: 'd'.repeat(40),
        reason: ''
      }).error
    ).toBeDefined();
  });

  it('accepts a strict bounded base-canary aggregate summary', () => {
    const { error } = ReleaseBusProgressReportBodySchema.validate({
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      phase: 'complete',
      status: 'SUCCEEDED',
      stages: [{ name: 'unit_tests', status: 'SUCCEEDED' }],
      jest: {
        num_failed_test_suites: 0,
        num_failed_tests: 0,
        failing_suites: [],
        failing_tests: []
      },
      summary: {
        base_sha: 'a'.repeat(40),
        environment: 'orchestration',
        gate_fingerprint: 'b'.repeat(64),
        workflow_sha: 'c'.repeat(40),
        workflow_digest: 'd'.repeat(64),
        node_version: '24.6.0',
        package_manager: 'npm@11.5.1',
        shard_count: 1,
        summary_artifact_name: 'release-bus/summary.json',
        summary_artifact_digest: 'e'.repeat(64),
        phase_durations_ms: { unit_tests: 1000, total: 1000 },
        totals: {
          files: 10,
          test_suites: 8,
          tests: 100,
          failed_test_suites: 0,
          failed_tests: 0
        },
        fresh_or_reused: 'fresh',
        shards: [
          {
            index: 0,
            count: 1,
            coordinate: '0/1',
            status: 'SUCCEEDED',
            duration_ms: 1000,
            failed_test_suites: 0,
            failed_tests: 0
          }
        ],
        missing_files: [],
        duplicate_files: []
      }
    });

    expect(error).toBeUndefined();
  });

  it('rejects unsafe aggregate paths and unbounded unknown fields', () => {
    const invalid = {
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      phase: 'complete',
      status: 'FAILED',
      summary: {
        base_sha: 'a'.repeat(40),
        environment: 'orchestration',
        gate_fingerprint: 'b'.repeat(64),
        workflow_sha: 'c'.repeat(40),
        workflow_digest: 'd'.repeat(64),
        node_version: '24.6.0',
        package_manager: 'npm@11.5.1',
        shard_count: 1,
        summary_artifact_name: '../raw.log',
        summary_artifact_digest: 'e'.repeat(64),
        phase_durations_ms: { total: 1000 },
        totals: { failed_test_suites: 1, failed_tests: 1 },
        fresh_or_reused: 'fresh',
        shards: [],
        missing_files: ['../secret.env'],
        duplicate_files: [],
        raw_logs: 'must never be accepted'
      }
    };

    expect(
      ReleaseBusProgressReportBodySchema.validate(invalid).error
    ).toBeDefined();
  });
});
