import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('source catalog coverage is complete and monitoring delivery has no application runtime boundary', () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL('../../../src/config/deploy-services.json', import.meta.url),
      'utf8'
    )
  );
  for (const env of ['prod', 'staging']) {
    const monitor = JSON.parse(
      readFileSync(
        new URL(`../monitoring-${env}.json`, import.meta.url),
        'utf8'
      )
    );
    const source = JSON.parse(
      readFileSync(new URL(`../source-${env}.json`, import.meta.url), 'utf8')
    );
    const coverage = JSON.parse(
      readFileSync(new URL(`../coverage-${env}.json`, import.meta.url), 'utf8')
    );
    const targets: string[] = catalog.services
      .filter((s: { allowed_environments: string[] }) =>
        s.allowed_environments.includes(env)
      )
      .flatMap(
        (s: { verification_targets: string[] }) => s.verification_targets
      );
    assert.deepEqual(
      coverage.services.flatMap((s: { functions: string[] }) => s.functions),
      targets
    );
    const filters = Object.values(source.Resources).filter(
      (r: unknown) =>
        (r as { Type: string }).Type === 'AWS::Logs::SubscriptionFilter'
    );
    assert.equal(filters.length, targets.length);
    for (const item of coverage.platformOnly as {
      name: string;
      deployCode: boolean;
    }[]) {
      const id = item.name.replace(/[^a-zA-Z0-9]/g, '');
      assert.equal(item.deployCode, false);
      assert.equal(source.Resources[`${id}ErrorLogs`], undefined);
      assert.ok(source.Resources[`${id}Errors`]);
      assert.ok(source.Resources[`${id}Throttles`]);
      assert.equal(targets.includes(item.name), false);
    }
    assert.notEqual(
      monitor.Resources.NormalDispatcher,
      monitor.Resources.CriticalDispatcher
    );
    assert.equal(
      monitor.Resources.NormalDispatcher.Properties
        .ReservedConcurrentExecutions,
      3
    );
    assert.equal(
      monitor.Resources.CriticalDispatcher.Properties
        .ReservedConcurrentExecutions,
      3
    );
    assert.equal(JSON.stringify(monitor).includes('VpcConfig'), false);
    assert.equal(JSON.stringify(monitor).includes('rds:'), false);
    assert.equal(JSON.stringify(monitor).includes('redis'), false);
    for (const resource of Object.values(monitor.Resources) as {
      Type: string;
      Properties: Record<string, unknown>;
    }[]) {
      if (resource.Type === 'AWS::Serverless::Function') {
        assert.equal(resource.Properties.CodeUri, 'dist/');
        assert.deepEqual(resource.Properties.PermissionsBoundary, {
          Ref: 'RuntimePermissionsBoundaryArn'
        });
      }
    }
  }
});
