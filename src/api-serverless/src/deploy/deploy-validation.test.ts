import { DeployDispatchBodySchema } from '@/api/deploy/deploy.validation';

describe('deploy.validation', () => {
  it('accepts one serialized backend service request', () => {
    const { error, value } = DeployDispatchBodySchema.validate({
      ref: '1a-staging',
      environment: 'staging',
      services: ['api']
    });

    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      target: 'backend',
      ref: '1a-staging',
      release_pull_request: null,
      release_group_services: '',
      release_note_opt_out: false
    });
  });

  it('rejects a concurrent backend service batch', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: '1a-staging',
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

  it('accepts a production PR with its full service group', () => {
    const { error, value } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_pull_request: 1801,
      release_group_services: 'dbMigrationsLoop,api'
    });

    expect(error).toBeUndefined();
    expect(value.release_pull_request).toBe(1801);
    expect(value.release_group_services).toBe('dbMigrationsLoop,api');
  });

  it('accepts an explicit internal production deployment', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_note_opt_out: true
    });

    expect(error).toBeUndefined();
  });

  it('requires a PR or explicit release-note opt-out for backend production', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api']
    });

    expect(error?.message).toContain('Choose a production PR');
  });

  it.each([{ release_pull_request: 1801 }, { release_group_services: 'api' }])(
    'rejects opt-out with release-note metadata %j',
    (metadata) => {
      const { error } = DeployDispatchBodySchema.validate({
        ref: 'main',
        environment: 'prod',
        services: ['api'],
        release_note_opt_out: true,
        ...metadata
      });

      expect(error?.message).toContain(
        'Internal deployments cannot include release-note metadata'
      );
    }
  );

  it.each([0, -1, 1.5])('rejects invalid PR number %s', (number) => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_pull_request: number
    });

    expect(error).toBeDefined();
  });

  it('does not coerce a string into release-note opt-out', () => {
    const { error } = DeployDispatchBodySchema.validate({
      ref: 'main',
      environment: 'prod',
      services: ['api'],
      release_note_opt_out: 'true'
    });

    expect(error?.message).toContain('must be a boolean');
  });

  it.each([
    { target: 'backend', environment: 'staging', ref: 'main' },
    { target: 'backend', environment: 'prod', ref: '1a-staging' },
    { target: 'frontend', environment: 'prod', ref: 'feature/deploy-ui' }
  ])('rejects deployment outside the environment branch %j', (request) => {
    const { error } = DeployDispatchBodySchema.validate({
      ...request,
      ...(request.target === 'backend' ? { services: ['api'] } : {}),
      release_note_opt_out: true
    });

    expect(error?.message).toContain('deployments must use');
  });

  it('accepts frontend production without a backend service or PR number', () => {
    const { error, value } = DeployDispatchBodySchema.validate({
      target: 'frontend',
      ref: 'main',
      environment: 'prod'
    });

    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty('services');
  });

  it.each([
    { environment: 'staging', ref: '1a-staging' },
    { environment: 'prod', ref: 'main', services: ['api'] }
  ])(
    'rejects frontend manual staging or backend service selection %j',
    (request) => {
      const { error } = DeployDispatchBodySchema.validate({
        target: 'frontend',
        ...request
      });

      expect(error).toBeDefined();
    }
  );
});
