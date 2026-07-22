import {
  DeployDispatchBodySchema,
  ReleaseBusAuthorizationBodySchema,
  ReleaseBusBreakGlassAuthorizationBodySchema,
  ReleaseBusExperimentalResetBodySchema,
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

  it('requires an exact destructive reset confirmation and bounded reason', () => {
    expect(
      ReleaseBusExperimentalResetBodySchema.validate({
        reset_id: '123e4567-e89b-42d3-a456-426614174001',
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Release Bus go-live clean-slate reset after full quiescence'
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusExperimentalResetBodySchema.validate({
        reset_id: '123e4567-e89b-42d3-a456-426614174001',
        confirmation: 'reset',
        reason: 'Release Bus go-live clean-slate reset after full quiescence'
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusExperimentalResetBodySchema.validate({
        reset_id: '123e4567-e89b-42d3-a456-426614174001',
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'too short'
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusExperimentalResetBodySchema.validate({
        reset_id: 'not-a-uuid',
        confirmation: 'RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY',
        reason: 'Release Bus go-live clean-slate reset after full quiescence'
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

  it('accepts only complete exact-tree backend evidence with one package build per unit', () => {
    const sourceSha = 'a'.repeat(40);
    const sourceTree = 'b'.repeat(40);
    const gateFingerprint = 'c'.repeat(64);
    const behaviorDigest = 'd'.repeat(64);
    const backendEvidence = {
      schema_version: 1,
      kind: 'release_bus_backend_preflight_evidence',
      source_sha: sourceSha,
      source_tree: sourceTree,
      workflow_sha: 'e'.repeat(40),
      workflow_digest: 'f'.repeat(64),
      behavior_digest: behaviorDigest,
      gate_fingerprint: gateFingerprint,
      component_digests: {
        'package.json': '9'.repeat(64),
        '.github/workflows/release-bus-preflight.yml': '8'.repeat(64)
      },
      node_version: '22',
      package_manager: 'npm@11.5.1',
      execution: 'executed_exact_composed_tree',
      reuse_reason: 'no_exact_composed_tree_evidence_selected',
      lint: 'success',
      typecheck: 'success',
      tests: {
        schema_version: 1,
        kind: 'release_bus_backend_test_evidence',
        source_sha: sourceSha,
        source_tree: sourceTree,
        gate_fingerprint: gateFingerprint,
        behavior_digest: behaviorDigest,
        execution: 'executed',
        jest_max_workers: 2,
        expected_files: 10,
        executed_files: 10,
        missing_files: [],
        unexpected_files: [],
        duplicate_inventory_files: [],
        duplicate_files: [],
        duplicate_test_identities: [],
        malformed_test_results: 0,
        executed_test_results: 100,
        failed_tests: 0,
        failed_test_suites: 0,
        skipped_tests: 0,
        skipped_test_suites: 0,
        total_tests: 100,
        total_test_suites: 10,
        status: 'SUCCEEDED'
      },
      selected_units: ['api'],
      package_build_count: 1,
      package_digests: { api: '1'.repeat(64) },
      status: 'SUCCEEDED',
      artifact_digest: '2'.repeat(64)
    };
    const report = {
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      phase: 'complete',
      status: 'SUCCEEDED',
      summary: null,
      backend_evidence: backendEvidence
    };

    expect(
      ReleaseBusProgressReportBodySchema.validate(report).error
    ).toBeUndefined();
    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...report,
        backend_evidence: {
          ...backendEvidence,
          tests: {
            ...backendEvidence.tests,
            duplicate_inventory_files: ['src/duplicate.test.ts']
          }
        }
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...report,
        backend_evidence: {
          ...backendEvidence,
          tests: {
            ...backendEvidence.tests,
            executed_test_results: 99
          }
        }
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...report,
        backend_evidence: { ...backendEvidence, package_build_count: 2 }
      }).error
    ).toBeDefined();
  });

  it('accepts only dependency infrastructure failures as retryable', () => {
    const base = {
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      phase: 'complete',
      status: 'FAILED',
      stages: [],
      jest: null,
      summary: null
    };

    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...base,
        failure_class: 'INFRASTRUCTURE_TRANSIENT',
        failure_phase: 'dependency_install',
        retryable: true
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...base,
        failure_class: 'SOURCE',
        failure_phase: 'gate',
        retryable: true
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusProgressReportBodySchema.validate({
        ...base,
        status: 'SUCCEEDED',
        failure_class: 'INFRASTRUCTURE_TRANSIENT',
        failure_phase: 'dependency_install',
        retryable: true
      }).error
    ).toBeDefined();
  });
});
