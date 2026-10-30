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

export async function deleteConsolidations<T extends ObjectLiteral>(
  repo: Repository<T>,
  deleteDelta: Set<string>
): Promise<number> {
  if (deleteDelta.size === 0) {
    return 0;
  }

  // Read each persisted key once, including former consolidations. A growing
  // OR of LIKE '%wallet%' evaluates every wallet against every stored row.
  const rows = await repo
    .createQueryBuilder()
    .select('consolidation_key')
    .distinct(true)
    .getRawMany<{ consolidation_key: string }>();

  const wallets = new Set(
    Array.from(deleteDelta, (wallet) => wallet.toLowerCase())
  );
  const keysToDelete = rows
    .filter((row) =>
      row.consolidation_key
        .toLowerCase()
        .split('-')
        .some((wallet) => wallets.has(wallet))
    )
    .map((row) => row.consolidation_key);

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
