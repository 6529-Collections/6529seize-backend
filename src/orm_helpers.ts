import { ObjectLiteral, Repository } from 'typeorm';

export async function deleteAll<T extends ObjectLiteral>(repo: Repository<T>) {
  await repo.createQueryBuilder().delete().execute();
}

export async function insertWithoutUpdate<T extends ObjectLiteral>(
  repo: Repository<T>,
  data: T[]
) {
  await repo
    .createQueryBuilder()
    .insert()
    .values(data)
    .updateEntity(false)
    .execute();
}

export async function resetRepository<T extends ObjectLiteral>(
  repo: Repository<T>,
  data: T[]
) {
  await deleteAll(repo);
  await insertWithoutUpdate(repo, data);
}

export async function upsertRepository<T extends ObjectLiteral>(
  repo: Repository<T>,
  pk: string[],
  upsertData: T[],
  deleteData?: T[]
) {
  if (deleteData) {
    await repo.remove(deleteData);
  }
  await repo.upsert(upsertData, pk);
}

export async function deleteWallet<T extends ObjectLiteral>(
  repo: Repository<T>,
  deleteDelta: Set<string>
): Promise<number> {
  if (deleteDelta.size === 0) {
    return 0;
  }
  const wallets = Array.from(deleteDelta);
  const deleted = await repo
    .createQueryBuilder()
    .delete()
    .where('wallet IN (:...wallets)', { wallets })
    .execute();
  return deleted.affected ?? 0;
}

const CONSOLIDATION_DELETE_BATCH_SIZE = 500;
const CONSOLIDATION_SCAN_PAGE_SIZE = 1000;

type ConsolidationScanRow = Record<string, string | number> & {
  consolidation_key: string;
};

async function fetchConsolidationPage<T extends ObjectLiteral>(
  repo: Repository<T>,
  after?: ConsolidationScanRow
): Promise<ConsolidationScanRow[]> {
  // Every consumer has a different composite primary key. Scan that key so
  // pagination stays indexed even on tables without a consolidation-key index.
  const columns = repo.metadata.primaryColumns;
  const query = repo
    .createQueryBuilder('cleanup')
    .select('cleanup.consolidation_key', 'consolidation_key')
    .limit(CONSOLIDATION_SCAN_PAGE_SIZE);
  columns.forEach((column, index) => {
    query.addSelect(`cleanup.${column.propertyPath}`, `cursor_${index}`);
    query.addOrderBy(`cleanup.${column.propertyPath}`, 'ASC');
  });
  if (after) {
    const params: Record<string, string | number> = {};
    const alternatives = columns.map((column, index) => {
      params[`after_${index}`] = after[`cursor_${index}`];
      const prefix = columns
        .slice(0, index)
        .map(
          (previous, previousIndex) =>
            `cleanup.${previous.propertyPath} = :after_${previousIndex}`
        );
      return `(${[...prefix, `cleanup.${column.propertyPath} > :after_${index}`].join(' AND ')})`;
    });
    query.where(alternatives.join(' OR '), params);
  }
  return query.getRawMany<ConsolidationScanRow>();
}

async function deleteConsolidationKeys<T extends ObjectLiteral>(
  repo: Repository<T>,
  keysToDelete: string[]
): Promise<number> {
  let affected = 0;
  for (
    let offset = 0;
    offset < keysToDelete.length;
    offset += CONSOLIDATION_DELETE_BATCH_SIZE
  ) {
    const keys = keysToDelete.slice(
      offset,
      offset + CONSOLIDATION_DELETE_BATCH_SIZE
    );
    const deleted = await repo
      .createQueryBuilder()
      .delete()
      .where('consolidation_key IN (:...keys)', { keys })
      .execute();
    affected += deleted.affected ?? 0;
  }
  return affected;
}

/**
 * Requires a repository from the caller's transaction, covering every delete
 * page and the replacement inserts. Do not commit partial cleanup pages.
 * deleteDelta contains individual wallet addresses, not consolidation keys.
 */
export async function deleteConsolidations<T extends ObjectLiteral>(
  repo: Repository<T>,
  deleteDelta: Set<string>
): Promise<number> {
  if (deleteDelta.size === 0) {
    return 0;
  }

  // Callers pass individual wallet addresses. Persisted keys use the canonical
  // buildConsolidationKey '-' format, including singleton and former groups.
  const wallets = new Set(
    Array.from(deleteDelta, (wallet) => wallet.toLowerCase())
  );
  let after: ConsolidationScanRow | undefined;
  let affected = 0;
  while (true) {
    const rows = await fetchConsolidationPage(repo, after);
    const keys = new Set(
      rows
        .filter((row) =>
          row.consolidation_key
            .toLowerCase()
            .split('-')
            .some((wallet) => wallets.has(wallet))
        )
        .map((row) => row.consolidation_key)
    );
    affected += await deleteConsolidationKeys(repo, Array.from(keys));
    if (rows.length < CONSOLIDATION_SCAN_PAGE_SIZE) return affected;
    // Deletes can remove this row and later rows of the same consolidation.
    // Seek by its values, never by OFFSET, so remaining rows cannot be skipped.
    after = rows[rows.length - 1];
  }
}
