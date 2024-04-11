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
  const whereClause = Array.from(deleteDelta)
    .map((wallet) => `wallet = '${wallet}'`)
    .join(' OR ');
  const deleted = await repo
    .createQueryBuilder()
    .delete()
    .where(whereClause)
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
  const whereClause = Array.from(deleteDelta)
    .map((wallet) => `consolidation_key LIKE '%${wallet}%'`)
    .join(' OR ');
  const deleted = await repo
    .createQueryBuilder()
    .delete()
    .where(whereClause)
    .execute();
  return deleted.affected ?? 0;
}
