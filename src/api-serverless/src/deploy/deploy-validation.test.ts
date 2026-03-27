import { DeployDispatchBodySchema } from '@/api/deploy/deploy.validation';

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
});
