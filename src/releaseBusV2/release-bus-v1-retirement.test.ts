import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type RetirementMigration = {
  up(db: { runSql(sql: string): Promise<unknown> }): Promise<void>;
  down(db: { runSql(sql: string): Promise<unknown> }): Promise<void>;
};

const requireModule = createRequire(__filename);

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

  it('retires legacy tables atomically and reversibly before deletion', async () => {
    const migration = read(
      'migrations/20260724202500-retire-release-bus-v1-tables.js'
    );
    const executableMigration = requireModule(
      path.resolve(
        __dirname,
        '../../migrations/20260724202500-retire-release-bus-v1-tables.js'
      )
    ) as RetirementMigration;
    expect(migration).toContain('RENAME TABLE');
    expect(migration).toContain('exports.down');
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    const pairs = [
      ['release_ready_deployments', 'retired_release_bus_v1_ready_deployments'],
      [
        'release_candidate_dependencies',
        'retired_release_bus_v1_candidate_dependencies'
      ],
      ['release_trains', 'retired_release_bus_v1_trains'],
      ['release_train_items', 'retired_release_bus_v1_train_items'],
      ['release_train_operations', 'retired_release_bus_v1_train_operations'],
      ['release_train_evidence', 'retired_release_bus_v1_train_evidence'],
      ['release_deployment_lanes', 'retired_release_bus_v1_deployment_lanes'],
      ['release_bus_controls', 'retired_release_bus_v1_controls'],
      ['release_train_events', 'retired_release_bus_v1_train_events']
    ];
    const executeWithTables = async (
      direction: 'up' | 'down',
      tables: string[]
    ) => {
      const statements: string[] = [];
      const db = {
        runSql: jest.fn(async (sql: string) => {
          statements.push(sql);
          return sql.startsWith('SELECT ')
            ? tables.map((table_name) => ({ table_name }))
            : undefined;
        })
      };
      await executableMigration[direction](db);
      return statements;
    };
    const up = await executeWithTables(
      'up',
      pairs.map(([active]) => active)
    );
    const down = await executeWithTables(
      'down',
      pairs.map(([, retired]) => retired)
    );

    expect(up).toHaveLength(2);
    expect(down).toHaveLength(2);
    expect(up[0]).toMatch(/^SELECT /);
    expect(down[0]).toMatch(/^SELECT /);
    expect(up[1]).toMatch(/^RENAME TABLE /);
    expect(down[1]).toMatch(/^RENAME TABLE /);
    for (const [active, retired] of pairs) {
      expect(up[1]).toContain(`\`${active}\` TO \`${retired}\``);
      expect(down[1]).toContain(`\`${retired}\` TO \`${active}\``);
    }

    await expect(
      executeWithTables('up', [pairs[0][0], pairs[0][1]])
    ).rejects.toThrow('Ambiguous Release Bus v1 table retirement state');
    await expect(
      executeWithTables(
        'up',
        pairs.map(([, retired]) => retired)
      )
    ).resolves.toHaveLength(1);
  });
});
