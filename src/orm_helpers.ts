import { ObjectLiteral, Repository } from 'typeorm';

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
  await repo.clear();
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

export async function deleteConsolidations<T extends ObjectLiteral>(
  repo: Repository<T>,
  deleteDelta: Set<string>
): Promise<number> {
  if (deleteDelta.size === 0) {
    return 0;
  }

  // Build the WHERE clause for LIKE
  const whereClause = Array.from(deleteDelta)
    .map((wallet) => `consolidation_key LIKE '%${wallet}%'`)
    .join(' OR ');

  // Step 1 → SELECT consolidation keys matching the LIKEs
  const rows = await repo
    .createQueryBuilder()
    .select('consolidation_key')
    .where(whereClause)
    .getRawMany<{ consolidation_key: string }>();

  const keysToDelete = rows.map((r) => r.consolidation_key);

  if (keysToDelete.length === 0) {
    return 0;
  }

  // Step 2 → DELETE using IN
  const deleted = await repo
    .createQueryBuilder()
    .delete()
    .where('consolidation_key IN (:...keys)', { keys: keysToDelete })
    .execute();

  return deleted.affected ?? 0;
}
