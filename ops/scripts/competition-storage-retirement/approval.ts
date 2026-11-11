import {
  cleanupDigest,
  type CompetitionCleanupInventory,
  type inspectCompetitionOrphans
} from '../../../src/competitions/competition-storage-cleanup';

export interface CompetitionCleanupPlan {
  environment: 'staging' | 'prod';
  inventory: CompetitionCleanupInventory;
  orphans: Awaited<ReturnType<typeof inspectCompetitionOrphans>>;
}

export interface CompetitionCleanupRecovery {
  snapshotArn: string;
  snapshotStatus: 'available';
  snapshotEncrypted: true;
  restoredSnapshotArn: string;
  restoredInventory: CompetitionCleanupInventory;
  restoredOrphans: CompetitionCleanupPlan['orphans'];
  verifiedAt: string;
  deploymentRevision: string;
  drainEvidenceSha256: string;
}

function restoreCoversInventory(
  source: CompetitionCleanupInventory,
  restored: CompetitionCleanupInventory
): boolean {
  return (
    source.tables.every((table) =>
      restored.tables.some(
        (copy) => cleanupDigest(table) === cleanupDigest(copy)
      )
    ) &&
    source.columns.every((column) =>
      restored.columns.some(
        (copy) => cleanupDigest(column) === cleanupDigest(copy)
      )
    ) &&
    source.indexes.every((index) =>
      restored.indexes.some(
        (copy) => cleanupDigest(index) === cleanupDigest(copy)
      )
    ) &&
    source.sharedDefinitions.every(({ name }) =>
      restored.sharedDefinitions.some(
        (table) => table.name === name && table.definition.length > 0
      )
    )
  );
}

function restoreCoversOrphans(
  source: CompetitionCleanupPlan['orphans'],
  restored: CompetitionCleanupPlan['orphans']
): boolean {
  return source.every((target) => {
    const copy = restored.find(({ table }) => table === target.table);
    return (
      copy !== undefined &&
      target.rows.every((row) =>
        copy.rows.some(
          (restoredRow) => cleanupDigest(row) === cleanupDigest(restoredRow)
        )
      )
    );
  });
}

/** Restore evidence must come from the isolated snapshot restore, with matching
 * exact DDL, row counts/checksums and every targeted source record. Environment
 * selection is independent of database names and untrusted plan filenames. A
 * backup may include already-removed objects after a manually reviewed partial
 * DDL recovery; every still-present object and source record must match. */
export function assertCompetitionCleanupRecovery(
  plan: CompetitionCleanupPlan,
  recovery: CompetitionCleanupRecovery
): void {
  const region = plan.environment === 'prod' ? 'us-east-1' : 'eu-west-1';
  const kind = plan.environment === 'prod' ? 'cluster-snapshot' : 'snapshot';
  if (
    !new RegExp(
      `^arn:aws:rds:${region}:987989283142:${kind}:competition-retirement-${plan.environment}-[a-z0-9-]+$`
    ).test(recovery.snapshotArn) ||
    recovery.snapshotStatus !== 'available' ||
    recovery.snapshotEncrypted !== true ||
    recovery.restoredSnapshotArn !== recovery.snapshotArn
  )
    throw new Error(
      'Recovery snapshot is unavailable or belongs to a different cleanup environment'
    );
  if (
    plan.inventory.serverUuid === recovery.restoredInventory.serverUuid ||
    !restoreCoversInventory(plan.inventory, recovery.restoredInventory) ||
    !restoreCoversOrphans(plan.orphans, recovery.restoredOrphans)
  )
    throw new Error(
      'Independent snapshot restore does not match the exact affected schema and data'
    );
  if (
    !Number.isFinite(Date.parse(recovery.verifiedAt)) ||
    !/^[a-f0-9]{40}$/.test(recovery.deploymentRevision) ||
    !/^[a-f0-9]{64}$/.test(recovery.drainEvidenceSha256)
  )
    throw new Error(
      'Verified restore, deployment and old-invocation drain evidence are required'
    );
}
