import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const read = (file: string) =>
  readFileSync(path.resolve(__dirname, '..', file), 'utf8');
it('does not depend on GitHub role variables or an execution-role export step', () => {
  const source = read('.github/workflows/deploy.yml');
  expect(source).not.toMatch(
    /DROP_FORGE_WORKER_ROLE_ARN|DROP_FORGE_PREPARATION_ROLE_ARN|Configure Drop Forge execution role/
  );
});
it.each(['dropForgeLaunchHandler', 'memesDistributionHandler'])(
  '%s consumes durable work without an idle schedule',
  (name) => {
    const source = read(`src/${name}/serverless.yaml`);
    expect(source).not.toMatch(/rate\(|cron\(|env:DROP_FORGE.*ROLE/);
    expect(source).toContain('drop-forge.js)');
    expect(source).toContain('batchSize: 1');
    expect(source).toContain('maximumConcurrency: 2');
    expect(source).toContain('reservedConcurrency: 2');
    expect(source).toContain('VisibilityTimeout: 1800');
    expect(source).toContain('maxReceiveCount: 10');
    expect(source).toContain('ApproximateNumberOfMessagesVisible');
  }
);
it.each(['staging', 'prod'])(
  'uses separate versioned %s role references',
  (stage) => {
    const config = require(`../serverless-config/${stage}/drop-forge.js`);
    expect(config.launchRole()['Fn::Sub']).toContain(
      `role/drop-forge-${stage}-launch`
    );
    expect(config.distributionRole()['Fn::Sub']).toContain(
      `role/drop-forge-${stage}-distribution`
    );
    expect(config.schedulerRole()['Fn::Sub']).toContain(
      `role/drop-forge-${stage}-scheduler`
    );
  }
);
it('deploys schema and queue-owning handlers before the producing API without a dependency cycle', () => {
  const catalog = JSON.parse(read('src/config/deploy-services.json'));
  const find = (name: string) =>
    catalog.services.find((service: { name: string }) => service.name === name);
  expect(find('api').default_dependencies).toEqual(
    expect.arrayContaining([
      'memesDistributionHandler',
      'dropForgeLaunchHandler'
    ])
  );
  expect(find('dropForgeLaunchHandler').default_dependencies).toEqual([
    'dbMigrationsLoop'
  ]);
  expect(find('memesDistributionHandler').default_dependencies).toEqual([
    'dbMigrationsLoop',
    'dropForgeLaunchHandler'
  ]);
  expect(
    parse(read('.github/workflows/deploy.yml')).jobs['build-and-deploy']
  ).toBeDefined();
});
