import fs from 'node:fs';
import path from 'node:path';

type Migration = {
  up(db: { runSql(sql: string): Promise<unknown> }): Promise<void>;
  down(db: { runSql(sql: string): Promise<unknown> }): Promise<void>;
};

describe('Release Bus v2 production authority schema', () => {
  it('creates the server-side lease ledger and reversibly retires it', async () => {
    const migration = require(
      path.resolve(
        process.cwd(),
        'migrations/20260806170000-create-release-bus-v2-production-authority.js'
      )
    ) as Migration;
    const statements: string[] = [];
    const db = {
      runSql: async (sql: string) => {
        statements.push(sql);
        return undefined;
      }
    };

    await migration.up(db);
    expect(statements[0]).toContain(
      'CREATE TABLE IF NOT EXISTS release_bus_v2_production_authorities'
    );
    for (const column of [
      'operation_id varchar(180) NOT NULL',
      'selection_digest char(64) NULL',
      'qualifier_workflow_run_id varchar(20) NULL',
      'qualifier_workflow_run_attempt int NULL',
      'evidence_digest char(64) NULL',
      'lease_token varchar(36) NULL',
      'control_epoch_all int NOT NULL',
      'control_epoch_production int NOT NULL',
      'denial_code varchar(64) NULL'
    ])
      expect(statements[0]).toContain(column);
    expect(statements[0]).toContain(
      'UNIQUE KEY uq_release_bus_v2_production_authority_operation (operation_id)'
    );
    expect(statements[0]).toContain(
      'KEY idx_release_bus_v2_production_authority_status (status, lease_expires_at)'
    );

    await migration.down(db);
    expect(statements[1]).toBe(
      'RENAME TABLE release_bus_v2_production_authorities TO retired_release_bus_v2_production_authorities'
    );

    const entity = fs.readFileSync(
      path.resolve(process.cwd(), 'src/entities/IReleaseBusV2.ts'),
      'utf8'
    );
    expect(entity).toContain(
      '@Entity(RELEASE_BUS_V2_PRODUCTION_AUTHORITIES_TABLE)'
    );
    expect(entity).toContain('readonly lease_token!: string | null;');
    expect(entity).toContain(
      'readonly qualifier_workflow_run_id!: string | null;'
    );
    expect(entity).toContain('readonly evidence_digest!: string | null;');
  });
});
