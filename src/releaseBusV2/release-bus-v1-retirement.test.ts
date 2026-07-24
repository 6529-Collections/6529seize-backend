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
});
