import fs from 'node:fs';
import path from 'node:path';

function read(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../..', relativePath),
    'utf8'
  );
}

describe('Release Bus v1 retirement', () => {
  it('keeps API and deployment workflows versioned to v2', () => {
    const api = read('src/api-serverless/src/deploy/deploy.routes.ts');
    const deploy = read('.github/workflows/deploy.yml');
    const status = read('ops/scripts/release-bus-status.mjs');

    expect(api).not.toMatch(/['"]\/release-(?:candidates|trains)/);
    expect(api).not.toContain("'/release-bus/");
    expect(deploy).not.toContain('/deploy/release-bus/');
    expect(status).not.toContain('/deploy/release-bus/controls');
    expect(status).not.toContain('SHADOW');
  });

  it('has no v1 runtime claimant or entity export', () => {
    const infrastructure = read('src/releaseBus/serverless.yaml');
    const entities = read('src/entities/entities.ts');
    const tables = read('src/constants/db-tables.ts');

    expect(infrastructure).not.toMatch(
      /releaseBusStarter|releaseBusWorker|ReleaseBusStateMachine/
    );
    expect(entities).not.toMatch(
      /ReleaseReadyDeployment|ReleaseTrainEntity|ReleaseBusControlEntity/
    );
    expect(tables).not.toMatch(
      /RELEASE_READY_DEPLOYMENTS_TABLE|RELEASE_TRAINS_TABLE|RELEASE_BUS_CONTROLS_TABLE/
    );
  });

  it('retires legacy tables atomically and reversibly before deletion', () => {
    const migration = read(
      'migrations/20260724202500-retire-release-bus-v1-tables.js'
    );

    expect(migration).toContain('RENAME TABLE');
    expect(migration).toContain('exports.down');
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    for (const table of [
      'release_ready_deployments',
      'release_candidate_dependencies',
      'release_trains',
      'release_train_items',
      'release_train_operations',
      'release_train_evidence',
      'release_deployment_lanes',
      'release_bus_controls',
      'release_train_events'
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
  });
});
