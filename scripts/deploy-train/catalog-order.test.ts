import { readFileSync } from 'node:fs';
import path from 'node:path';

const catalogLib = require('./catalog');

const realConfig = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../src/config/deploy-services.json'),
    'utf8'
  )
);

function service(name: string, dependencies: string[] = []) {
  return {
    name,
    allowed_environments: ['staging', 'prod'],
    deploy_adapter: 'serverless',
    aws_region: { staging: 'eu-west-1', prod: 'us-east-1' },
    verification_targets: [name],
    validation_profile: 'lambda-version',
    default_dependencies: dependencies
  };
}

function catalogOf(services: ReturnType<typeof service>[]) {
  return catalogLib.loadCatalog({
    default_environment: 'staging',
    default_service: services[0].name,
    services
  });
}

describe('deploy catalog ordering', () => {
  it('orders the real catalog with dbMigrationsLoop first and dependencies before dependents', () => {
    const catalog = catalogLib.loadCatalog(realConfig);
    const names: string[] = catalog.services.map(
      (entry: { name: string }) => entry.name
    );
    const order: string[] = catalogLib.dependencyOrder(catalog, names);
    expect(order[0]).toBe('dbMigrationsLoop');
    const byText = (left: string, right: string) => left.localeCompare(right);
    expect(order.slice().sort(byText)).toEqual(names.slice().sort(byText));
    const closure = catalogLib.transitiveDependencies(catalog);
    order.forEach((name, index) => {
      closure.get(name).forEach((dependency: string) => {
        expect(order.indexOf(dependency)).toBeLessThan(index);
      });
    });
  });

  it('breaks ties by priority, then by catalog position', () => {
    const catalog = catalogOf([
      service('api', ['dbMigrationsLoop']),
      service('alphaLoop'),
      service('betaLoop'),
      service('dbMigrationsLoop')
    ]);
    const priority: Record<string, number> = { betaLoop: 1, alphaLoop: 2 };
    expect(
      catalogLib.dependencyOrder(
        catalog,
        ['api', 'alphaLoop', 'betaLoop', 'dbMigrationsLoop'],
        (name: string) => [priority[name] ?? 0]
      )
    ).toEqual(['dbMigrationsLoop', 'api', 'betaLoop', 'alphaLoop']);
  });

  it('keeps transitive order when the middle service is not shipping', () => {
    const catalog = catalogOf([
      service('top', ['middle']),
      service('middle', ['bottom']),
      service('bottom')
    ]);
    expect(catalogLib.dependencyOrder(catalog, ['top', 'bottom'])).toEqual([
      'bottom',
      'top'
    ]);
    expect(
      catalogLib.dependentsOf(catalog, 'bottom', ['top', 'middle'])
    ).toEqual(['top', 'middle']);
  });

  it('rejects dependency cycles and unknown dependencies', () => {
    expect(() =>
      catalogLib.transitiveDependencies(
        catalogOf([service('a', ['b']), service('b', ['a'])])
      )
    ).toThrow('cycle');
    expect(() =>
      catalogLib.transitiveDependencies(catalogOf([service('a', ['ghost'])]))
    ).toThrow('unknown service ghost');
  });

  it('leaves train-only fields out of the deployment definition', () => {
    const definition = catalogLib.deploymentDefinition({
      ...service('royaltiesLoop'),
      deploy_train: { mode: 'manual', reason: 'money path' },
      deploy_blackouts: [{ type: 'team-freeze', reason: 'freeze' }]
    });
    expect(definition.deploy_train).toBeUndefined();
    expect(definition.deploy_blackouts).toBeUndefined();
    expect(definition.deploy_adapter).toBe('serverless');
    expect(catalogLib.trainSettings(service('x'))).toEqual({
      mode: 'auto',
      reason: null
    });
  });

  it('maps the API to its package directory', () => {
    expect(catalogLib.serviceDirectory('api')).toBe('src/api-serverless');
    expect(catalogLib.serviceDirectory('tdhLoop')).toBe('src/tdhLoop');
  });
});
