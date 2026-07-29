import {
  DeployDispatchBodySchema,
  ReleaseBusV2CandidateActionBodySchema,
  ReleaseBusV2CandidateBodySchema,
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
