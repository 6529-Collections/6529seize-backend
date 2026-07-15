import {
  DeployDispatchBodySchema,
  ReleaseBusAuthorizationBodySchema,
  ReleaseBusBreakGlassAuthorizationBodySchema,
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
    const { error } = ReleaseCandidateReadyBodySchema.validate({
      repository: 'frontend',
      branch: 'feature/ui',
      expected_head_sha: 'a'.repeat(40),
      target_lane: 'STAGING',
      dependencies: [{ repository: 'backend', branch: 'feature/api' }],
      deploy_plan: null
    });

    expect(error).toBeUndefined();
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

  it('requires immutable artifact identity for deployment operations', () => {
    const deployment = {
      train_id: '8af60034-9741-4b9d-bb1c-80b483f75455',
      operation_key: 'train:key',
      workflow_run_id: '12345',
      artifact_run_id: null,
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
});
