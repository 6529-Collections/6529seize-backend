import {
  DeployDispatchBodySchema,
  ReleaseBusV2CandidateActionBodySchema,
  ReleaseBusV2BaselineAdoptionBodySchema,
  ReleaseBusV2BaselineAutomaticE2EDecisionBodySchema,
  ReleaseBusV2BaselineBackendDeploymentEventBodySchema,
  ReleaseBusV2CandidateBodySchema,
  ReleaseBusV2CandidateDeregistrationBodySchema,
  ReleaseBusV2ManualDeploymentReadinessBodySchema,
  ReleaseBusV2ProductionSelectionBodySchema,
  ReleaseBusV2AuthorizationBodySchema,
  ReleaseBusV2ProgressBodySchema
} from '@/api/deploy/deploy.validation';

describe('deploy.validation', () => {
  it('accepts one serialized backend service request', () => {
    const { error, value } = DeployDispatchBodySchema.validate({
      ref: 'feature/deploy-ui',
      environment: 'staging',
      services: ['api']
    });

    expect(error).toBeUndefined();
    expect(value.ref).toBe('feature/deploy-ui');
  });

  it('rejects a concurrent backend service batch', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'staging',
      services: ['api', 'tdhLoop']
    });

    expect(error).toBeDefined();
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
});

describe('Release Bus v2 validation', () => {
  it('requires an exact zero-or-known-membership baseline adoption identity', () => {
    const exact = {
      idempotency_key: '8af60034-9741-4b9d-bb1c-80b483f75455',
      reason: 'Adopt the exact deployed staging pair',
      expires_at: Date.now() + 30 * 60 * 1000,
      expected_staging_state_row_version: 23,
      expected_frontend_ref: '1a-staging',
      expected_frontend_sha: 'a'.repeat(40),
      expected_frontend_runtime_sha: 'a'.repeat(40),
      expected_backend_ref: '1a-staging',
      expected_backend_sha: 'b'.repeat(40),
      expected_backend_runtime_sha: 'b'.repeat(40),
      required_backend_units: [
        { service: 'api', expected_sha: 'b'.repeat(40) }
      ],
      candidates: []
    };
    expect(
      ReleaseBusV2BaselineAdoptionBodySchema.validate(exact).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2BaselineAdoptionBodySchema.validate({
        ...exact,
        candidates: [
          {
            candidate_id: '7af60034-9741-4b9d-bb1c-80b483f75455',
            repository: 'frontend',
            pr_number: 42,
            head_sha: 'c'.repeat(40),
            row_version: 7
          }
        ]
      }).error
    ).toBeUndefined();
    for (const invalid of [
      { ...exact, expected_staging_state_row_version: '23' },
      { ...exact, expected_frontend_runtime_sha: 'z'.repeat(40) },
      { ...exact, expected_frontend_ref: 'main' },
      { ...exact, required_backend_units: [] },
      {
        ...exact,
        required_backend_units: [
          { service: 'not-a-service', expected_sha: 'b'.repeat(40) }
        ]
      },
      {
        ...exact,
        required_backend_units: [
          { service: 'releaseBus', expected_sha: 'b'.repeat(40) }
        ]
      },
      { ...exact, candidates: [null] },
      {
        ...exact,
        candidates: [
          {
            candidate_id: '7af60034-9741-4b9d-bb1c-80b483f75455',
            repository: 'frontend',
            pr_number: 42,
            head_sha: 'c'.repeat(40),
            row_version: 7
          },
          {
            candidate_id: '6af60034-9741-4b9d-bb1c-80b483f75455',
            repository: 'frontend',
            pr_number: 42,
            head_sha: 'c'.repeat(40),
            row_version: 8
          }
        ]
      },
      { ...exact, extra: true }
    ])
      expect(
        ReleaseBusV2BaselineAdoptionBodySchema.validate(invalid).error
      ).toBeDefined();
  });

  it('requires exact workflow identities for automatic defer and backend deployment events', () => {
    const automatic = {
      e2e_workflow_run_id: '91000',
      deploy_workflow_run_id: '92000',
      deployed_ref: '1a-staging',
      deployed_sha: 'a'.repeat(40)
    };
    expect(
      ReleaseBusV2BaselineAutomaticE2EDecisionBodySchema.validate(automatic)
        .error
    ).toBeUndefined();
    expect(
      ReleaseBusV2BaselineAutomaticE2EDecisionBodySchema.validate({
        ...automatic,
        deployed_ref: 'main'
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2BaselineAutomaticE2EDecisionBodySchema.validate({
        ...automatic,
        e2e_workflow_run_id: '0'
      }).error
    ).toBeDefined();

    const backend = {
      environment: 'staging',
      service: 'api',
      workflow_run_id: '93000',
      workflow_run_attempt: 1,
      source_ref: '1a-staging',
      source_sha: 'b'.repeat(40),
      status: 'SUCCEEDED'
    };
    expect(
      ReleaseBusV2BaselineBackendDeploymentEventBodySchema.validate(backend)
        .error
    ).toBeUndefined();
    expect(
      ReleaseBusV2BaselineBackendDeploymentEventBodySchema.validate({
        ...backend,
        status: 'RUNNING'
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2BaselineBackendDeploymentEventBodySchema.validate({
        ...backend,
        service: 'unknown'
      }).error
    ).toBeDefined();
  });

  it('separates read-only deregistration preparation from strict exact execution', () => {
    const candidateId = '8af60034-9741-4b9d-bb1c-80b483f75455';
    const exact = {
      expected_plan_sha256: '1'.repeat(64),
      expected_inventory_sha256: '2'.repeat(64),
      expected_candidates: [{ id: candidateId, row_version: 4 }],
      expected_controls: [
        { scope: 'ALL', paused: false, row_version: 1 },
        { scope: 'PRODUCTION', paused: true, row_version: 2 },
        { scope: 'STAGING', paused: true, row_version: 3 }
      ],
      expected_locks: [
        { name: 'production-environment', row_version: 1 },
        { name: 'scheduler', row_version: 2 },
        { name: 'staging-environment', row_version: 3 }
      ],
      expected_staging_state_row_version: 9,
      expected_staging_refs: {
        frontend: 'a'.repeat(40),
        backend: 'b'.repeat(40)
      }
    };
    expect(
      ReleaseBusV2CandidateDeregistrationBodySchema.validate({
        phase: 'PREPARE',
        reason: 'Retire the audited candidate inventory'
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2CandidateDeregistrationBodySchema.validate({
        phase: 'PREPARE',
        reason: 'Retire the audited candidate inventory',
        ...exact
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2CandidateDeregistrationBodySchema.validate({
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2CandidateDeregistrationBodySchema.validate({
        phase: 'EXECUTE',
        reason: 'Detach the exact empty candidate inventory',
        ...exact,
        expected_candidates: []
      }).error
    ).toBeUndefined();
    for (const invalid of [
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact,
        expected_candidates: [
          exact.expected_candidates[0],
          exact.expected_candidates[0]
        ]
      },
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact,
        expected_candidates: [null]
      },
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact,
        expected_candidates: [{}]
      },
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact,
        expected_controls: exact.expected_controls.slice(1)
      },
      {
        phase: 'EXECUTE',
        reason: 'Retire the audited candidate inventory',
        ...exact,
        expected_locks: exact.expected_locks.map((lock) => ({
          ...lock,
          row_version: '1'
        }))
      }
    ])
      expect(
        ReleaseBusV2CandidateDeregistrationBodySchema.validate(invalid).error
      ).toBeDefined();
  });

  it('binds manual deployment readiness to exact backend and frontend runs', () => {
    const request = {
      repository: 'backend',
      environment: 'staging',
      service: 'api',
      workflow_run_id: '12345',
      workflow_run_attempt: 2,
      source_ref: 'main',
      source_sha: 'a'.repeat(40)
    };

    expect(
      ReleaseBusV2ManualDeploymentReadinessBodySchema.validate(request).value
    ).toEqual(request);
    expect(
      ReleaseBusV2ManualDeploymentReadinessBodySchema.validate({
        ...request,
        repository: 'frontend',
        environment: 'production',
        service: 'frontend'
      }).value
    ).toEqual({
      ...request,
      repository: 'frontend',
      environment: 'prod',
      service: 'frontend'
    });
    for (const invalid of [
      { ...request, service: 'frontend' },
      { ...request, repository: 'frontend', service: 'api' },
      { ...request, workflow_run_attempt: 0 },
      { ...request, workflow_run_attempt: '2' },
      { ...request, source_ref: 'refs/heads/main' },
      { ...request, extra: true }
    ])
      expect(
        ReleaseBusV2ManualDeploymentReadinessBodySchema.validate(invalid).error
      ).toBeDefined();
  });

  it('binds workflow authorization to the exact v2 train key', () => {
    const trainId = '8af60034-9741-4b9d-bb1c-80b483f75455';
    const authorization = {
      train_id: trainId,
      operation_key: `rb2:${trainId}:prepare:frontend:a1`,
      workflow_run_id: '12345',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'orchestration',
      service: null,
      expected_sha: 'a'.repeat(40),
      artifact_digest: null
    };

    expect(
      ReleaseBusV2AuthorizationBodySchema.validate(authorization).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        operation_key: `rb2:123e4567-e89b-42d3-a456-426614174000:prepare:frontend:a1`
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        operation_key: 'rb:legacy-operation'
      }).error
    ).toBeDefined();
  });

  it('binds v2 E2E authorization to the exact manifest identity', () => {
    const trainId = '8af60034-9741-4b9d-bb1c-80b483f75455';
    const authorization = {
      train_id: trainId,
      operation_key: `rb2:${trainId}:e2e:staging:a1`,
      workflow_run_id: '29984983314',
      artifact_run_id: null,
      repository: 'frontend',
      environment: 'staging',
      service: null,
      expected_sha: 'a'.repeat(40),
      artifact_digest: 'b'.repeat(64)
    };

    expect(
      ReleaseBusV2AuthorizationBodySchema.validate(authorization).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        artifact_digest: null
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        operation_key: `rb2:${trainId}:deploy:staging:frontend:a1`
      }).error
    ).toBeDefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        operation_key: `rb2:${trainId}:deploy:e2e:staging:a1`
      }).error
    ).toBeDefined();

    const deployAuthorization = {
      ...authorization,
      operation_key: `rb2:${trainId}:deploy:staging:backend:api:a1`,
      artifact_run_id: '29984625887',
      repository: 'backend',
      service: 'api'
    };
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate(deployAuthorization).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...deployAuthorization,
        artifact_run_id: null
      }).error
    ).toBeDefined();
  });

  it('allows only exact artifact-free leased staging-ref operations', () => {
    const trainId = '8af60034-9741-4b9d-bb1c-80b483f75455';
    const authorization = {
      train_id: trainId,
      operation_key: `rb2:${trainId}:advance-staging:release:backend:a1`,
      workflow_run_id: '30510086016',
      artifact_run_id: null,
      repository: 'backend',
      environment: 'staging',
      service: null,
      expected_sha: 'a'.repeat(40),
      artifact_digest: null
    };

    expect(
      ReleaseBusV2AuthorizationBodySchema.validate(authorization).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2AuthorizationBodySchema.validate({
        ...authorization,
        operation_key: `rb2:${trainId}:advance-staging:rollback:frontend:a1`,
        repository: 'frontend'
      }).error
    ).toBeUndefined();
    for (const invalid of [
      {
        ...authorization,
        operation_key: `rb2:${trainId}:advance-staging:release:frontend:a1`
      },
      {
        ...authorization,
        operation_key: `rb2:${trainId}:advance-staging:release:backend:a1`,
        environment: 'prod'
      },
      { ...authorization, service: 'api' },
      { ...authorization, artifact_run_id: '30509992351' },
      { ...authorization, artifact_digest: 'b'.repeat(64) }
    ])
      expect(
        ReleaseBusV2AuthorizationBodySchema.validate(invalid).error
      ).toBeDefined();
  });

  it('accepts an exact backend PR candidate with an acyclic deploy plan', () => {
    const result = ReleaseBusV2CandidateBodySchema.validate({
      repository: 'backend',
      pr_number: 1788,
      branch_name: 'agent/release-bus-v2',
      expected_head_sha: 'a'.repeat(40),
      deploy_plan: {
        units: ['dbMigrationsLoop', 'api'],
        edges: [['dbMigrationsLoop', 'api']]
      },
      dependencies: [
        {
          candidate_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
          environment: 'BOTH'
        }
      ]
    });
    expect(result.error).toBeUndefined();
  });

  it('requires exact SHA and optimistic row version for production opt-in', () => {
    expect(
      ReleaseBusV2CandidateActionBodySchema.validate({
        expected_head_sha: 'b'.repeat(40),
        expected_row_version: 4
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2CandidateActionBodySchema.validate({
        expected_head_sha: 'main',
        expected_row_version: 0
      }).error
    ).toBeDefined();
  });

  it('accepts a bounded unique exact candidate production selection', () => {
    const candidateId = '8af60034-9741-4b9d-bb1c-80b483f75455';
    const item = {
      candidate_id: candidateId,
      expected_head_sha: 'b'.repeat(40),
      expected_row_version: 4
    };
    expect(
      ReleaseBusV2ProductionSelectionBodySchema.validate({
        candidates: [item]
      }).error
    ).toBeUndefined();
    expect(
      ReleaseBusV2ProductionSelectionBodySchema.validate({
        candidates: [item, item]
      }).error
    ).toBeDefined();
  });

  it('accepts bounded structured infrastructure retry reports', () => {
    expect(
      ReleaseBusV2ProgressBodySchema.validate({
        train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
        operation_key:
          'rb2:8af60034-9741-4b9d-bb1c-80b483f75455:prepare:frontend:a1',
        workflow_run_id: '12345',
        phase: 'download',
        status: 'FAILED',
        failure_class: 'INFRASTRUCTURE',
        failure_phase: 'artifact_download',
        retryable: true,
        summary: null
      }).error
    ).toBeUndefined();
  });
});
