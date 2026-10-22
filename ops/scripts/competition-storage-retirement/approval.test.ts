import {
  assertCompetitionCleanupRecovery,
  CompetitionCleanupPlan,
  CompetitionCleanupRecovery
} from './approval';

function fixture() {
  const plan: CompetitionCleanupPlan = {
    environment: 'prod',
    inventory: {
      database: 'application',
      serverUuid: 'source-server',
      sharedDefinitions: [{ name: 'waves', definition: 'create table waves' }],
      tables: [
        {
          name: 'drop_voter_states',
          definition: 'create table drop_voter_states',
          rows: '3',
          checksum: '123'
        }
      ],
      columns: [
        {
          table: 'competitions',
          name: 'storage_mode',
          definition: 'retired-selector'
        }
      ],
      indexes: []
    },
    orphans: [
      {
        table: 'competitions',
        rows: [{ id: 'orphan', wave_id: 'deleted-wave' }]
      }
    ]
  };
  const recovery: CompetitionCleanupRecovery = {
    snapshotArn:
      'arn:aws:rds:us-east-1:987989283142:cluster-snapshot:competition-retirement-prod-fixture',
    snapshotStatus: 'available',
    snapshotEncrypted: true,
    restoredSnapshotArn:
      'arn:aws:rds:us-east-1:987989283142:cluster-snapshot:competition-retirement-prod-fixture',
    restoredInventory: {
      ...plan.inventory,
      database: 'isolated_restore',
      serverUuid: 'independent-restored-server'
    },
    restoredOrphans: plan.orphans,
    verifiedAt: '2026-10-22T12:00:00Z',
    deploymentRevision: 'a'.repeat(40),
    drainEvidenceSha256: 'b'.repeat(64)
  };
  return { plan, recovery };
}

it('requires an independent encrypted same-environment restore matching the affected schema and source rows', () => {
  const { plan, recovery } = fixture();
  expect(() => assertCompetitionCleanupRecovery(plan, recovery)).not.toThrow();
});

it.each([
  'region',
  'account',
  'kind',
  'environment',
  'status',
  'encryption',
  'identity',
  'table-data',
  'table-schema',
  'orphan-data',
  'drain',
  'revision'
])('rejects invalid recovery evidence: %s', (field) => {
  const { plan, recovery } = fixture();
  if (field === 'region')
    recovery.snapshotArn = recovery.snapshotArn.replace(
      'us-east-1',
      'eu-west-1'
    );
  if (field === 'account')
    recovery.snapshotArn = recovery.snapshotArn.replace(
      '987989283142',
      '111111111111'
    );
  if (field === 'kind')
    recovery.snapshotArn = recovery.snapshotArn.replace(
      'cluster-snapshot',
      'snapshot'
    );
  if (field === 'environment') plan.environment = 'staging';
  if (field === 'status')
    (recovery as unknown as { snapshotStatus: string }).snapshotStatus =
      'creating';
  if (field === 'encryption')
    (recovery as unknown as { snapshotEncrypted: boolean }).snapshotEncrypted =
      false;
  if (field === 'identity')
    recovery.restoredInventory.serverUuid = plan.inventory.serverUuid;
  if (field === 'table-data')
    recovery.restoredInventory = {
      ...recovery.restoredInventory,
      tables: [{ ...recovery.restoredInventory.tables[0], checksum: '456' }]
    };
  if (field === 'table-schema')
    recovery.restoredInventory = {
      ...recovery.restoredInventory,
      tables: [
        {
          ...recovery.restoredInventory.tables[0],
          definition: 'another schema'
        }
      ]
    };
  if (field === 'orphan-data') recovery.restoredOrphans = [];
  if (field === 'drain') recovery.drainEvidenceSha256 = '';
  if (field === 'revision') recovery.deploymentRevision = '';
  expect(() => assertCompetitionCleanupRecovery(plan, recovery)).toThrow();
});

it('permits a reviewed partial-DDL recovery only when the original restored snapshot covers every remaining object', () => {
  const { plan, recovery } = fixture();
  plan.inventory = { ...plan.inventory, tables: [], indexes: [] };
  plan.orphans = plan.orphans.map((target) => ({ ...target, rows: [] }));
  expect(() => assertCompetitionCleanupRecovery(plan, recovery)).not.toThrow();
  plan.inventory.columns = [
    {
      table: 'competitions',
      name: 'storage_mode',
      definition: 'changed after backup'
    }
  ];
  expect(() => assertCompetitionCleanupRecovery(plan, recovery)).toThrow(
    'exact affected schema and data'
  );
});
