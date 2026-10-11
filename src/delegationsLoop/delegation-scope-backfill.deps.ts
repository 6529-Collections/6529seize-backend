import { USE_CASE_CONSOLIDATION } from '@/constants';
import { fetchLatestNftDelegationBlock, getDataSource } from '@/db';
import { fetchDelegationTransaction, scanDelegationLogs } from '@/delegations';
import { Delegation } from '@/entities/IDelegation';
import { DataSource, Not } from 'typeorm';
import {
  DelegationRow,
  DelegationRowDiff,
  ScopeBackfillDeps
} from './delegation-scope-backfill';

const SAVE_CHUNK_SIZE = 500;

function toRow(entity: Delegation): DelegationRow {
  return {
    block: Number(entity.block),
    from_address: entity.from_address,
    to_address: entity.to_address,
    collection: entity.collection,
    use_case: Number(entity.use_case),
    expiry: Number(entity.expiry),
    all_tokens: Boolean(Number(entity.all_tokens)),
    token_id: Number(entity.token_id)
  };
}

function primaryKey(row: DelegationRow) {
  return {
    block: row.block,
    from_address: row.from_address,
    to_address: row.to_address,
    collection: row.collection,
    use_case: row.use_case
  };
}

function toEntity(row: DelegationRow): Delegation {
  const entity = new Delegation();
  Object.assign(entity, row);
  return entity;
}

/** Every delegations row except consolidation (use case 999). */
export async function readDelegationRowsForBackfill(
  dataSource: DataSource = getDataSource()
): Promise<DelegationRow[]> {
  const rows = await dataSource
    .getRepository(Delegation)
    .find({ where: { use_case: Not(USE_CASE_CONSOLIDATION) } });
  return rows.map(toRow);
}

/**
 * Writes the diff in one transaction: deletes and updates by primary key,
 * then inserts. Refuses a diff that touches a consolidation (999) row.
 */
export async function applyScopeBackfillDiff(
  diff: DelegationRowDiff,
  dataSource: DataSource = getDataSource()
): Promise<void> {
  const touched = [
    ...diff.inserts,
    ...diff.deletes,
    ...diff.updates.map((update) => update.current)
  ];
  if (touched.some((row) => row.use_case === USE_CASE_CONSOLIDATION)) {
    throw new Error('Refusing to write consolidation (999) delegation rows');
  }
  await dataSource.transaction(async (manager) => {
    const repo = manager.getRepository(Delegation);
    await Promise.all([
      ...diff.deletes.map((row) => repo.delete(primaryKey(row))),
      ...diff.updates.map(({ current, expected }) =>
        repo.update(primaryKey(current), {
          expiry: expected.expiry,
          all_tokens: expected.all_tokens,
          token_id: expected.token_id
        })
      )
    ]);
    if (diff.inserts.length > 0) {
      await repo.save(diff.inserts.map(toEntity), { chunk: SAVE_CHUNK_SIZE });
    }
  });
}

export function createScopeBackfillDeps(): ScopeBackfillDeps {
  return {
    latestProcessedBlock: fetchLatestNftDelegationBlock,
    scan: scanDelegationLogs,
    readRows: () => readDelegationRowsForBackfill(),
    getTransaction: fetchDelegationTransaction,
    applyDiff: (diff) => applyScopeBackfillDiff(diff),
    nowSeconds: () => Math.floor(Date.now() / 1000)
  };
}
