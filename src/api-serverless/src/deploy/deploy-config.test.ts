import fc from 'fast-check';
import {
  canDeployServiceToEnvironment,
  DEPLOY_SERVICES,
  getAllowedEnvironmentsForService,
  getDeployServiceConfigs,
  isDeployService
} from '@/api/deploy/deploy.config';

describe('deploy.config', () => {
  it('only exposes unique service names', () => {
    expect(new Set(DEPLOY_SERVICES).size).toBe(DEPLOY_SERVICES.length);
  });

  it('returns a config entry for every deploy service', () => {
    expect(getDeployServiceConfigs()).toHaveLength(DEPLOY_SERVICES.length);
  });

  it('recognizes every configured deploy service', () => {
    fc.assert(
      fc.property(fc.constantFrom(...DEPLOY_SERVICES), (service) => {
        expect(isDeployService(service)).toBe(true);
        expect(
          getAllowedEnvironmentsForService(service).length
        ).toBeGreaterThan(0);
      })
    );
  });

  it('keeps the workflow environment constraints in sync', () => {
    expect(canDeployServiceToEnvironment('mediaResizerLoop', 'prod')).toBe(
      true
    );
    expect(canDeployServiceToEnvironment('mediaResizerLoop', 'staging')).toBe(
      false
    );
    expect(
      canDeployServiceToEnvironment('dropVideoConversionInvokerLoop', 'staging')
    ).toBe(true);
    expect(
      canDeployServiceToEnvironment('dropVideoConversionInvokerLoop', 'prod')
    ).toBe(false);
    expect(canDeployServiceToEnvironment('api', 'staging')).toBe(true);
    expect(canDeployServiceToEnvironment('api', 'prod')).toBe(true);
  });

  it('does not allow unknown services to deploy anywhere', () => {
    expect(
      getAllowedEnvironmentsForService('definitely-not-a-service')
    ).toEqual([]);
    expect(
      canDeployServiceToEnvironment('definitely-not-a-service', 'staging')
    ).toBe(false);
    expect(
      canDeployServiceToEnvironment('definitely-not-a-service', 'prod')
    ).toBe(false);
  });
});
