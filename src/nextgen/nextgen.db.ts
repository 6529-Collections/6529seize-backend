import {
  NextGenBlock,
  NextGenCollection,
  NextGenLog,
  NextGenToken,
  NextGenTokenTrait,
  NextGenTransaction
} from '../entities/INextGen';
import { EntityManager } from 'typeorm';

export async function fetchNextGenLatestBlock(manager: EntityManager) {
  const block = await manager
    .getRepository(NextGenBlock)
    .createQueryBuilder()
    .select('MAX(block)', 'max_block')
    .getRawOne();
  return block.max_block ?? 0;
}

export async function fetchNextGenCollection(
  manager: EntityManager,
  id: number
) {
  const c = await manager.getRepository(NextGenCollection).findOne({
    where: {
      id: id
    }
  });
  return c;
}

export async function fetchNextGenCollectionIndex(manager: EntityManager) {
  const index = await manager
    .getRepository(NextGenCollection)
    .createQueryBuilder()
    .select('MAX(id)', 'max_id')
    .getRawOne();

  return index.max_id ?? 0;
}

export async function persistNextGenLogs(
  manager: EntityManager,
  logs: NextGenLog[]
) {
  await manager.getRepository(NextGenLog).save(logs);
}

export async function persistNextGenCollection(
  manager: EntityManager,
  collection: NextGenCollection
) {
  await manager.getRepository(NextGenCollection).save(collection);
}

export async function persistNextGenBlock(
  manager: EntityManager,
  block: NextGenBlock
) {
  await manager.getRepository(NextGenBlock).save(block);
}

export async function persistNextGenToken(
  manager: EntityManager,
  token: NextGenToken
) {
  await manager.getRepository(NextGenToken).upsert(token, ['id']);
}

export async function persistNextGenTraits(
  manager: EntityManager,
  tokenTraits: NextGenTokenTrait[]
) {
  const repo = manager.getRepository(NextGenTokenTrait);
  await repo.upsert(tokenTraits, ['token_id', 'trait']);
}

export async function persistNextgenTransactions(
  manager: EntityManager,
  transactions: NextGenTransaction[]
) {
  const repo = manager.getRepository(NextGenTransaction);
  await repo.upsert(transactions, [
    'transaction',
    'from_address',
    'to_address',
    'token_id'
  ]);
}

export async function fetchNextGenCollections(
  manager: EntityManager
): Promise<NextGenCollection[]> {
  return await manager.getRepository(NextGenCollection).find();
}

export async function fetchPendingNextgenTokens(manager: EntityManager) {
  return await manager.getRepository(NextGenToken).find({
    where: {
      pending: true
    }
  });
}

export async function fetchNextGenTokensForCollection(
  manager: EntityManager,
  collection: NextGenCollection
) {
  return await manager.getRepository(NextGenToken).find({
    where: {
      collection_id: collection.id
    }
  });
}

export async function fetchNextGenTokenTraits(
  manager: EntityManager
): Promise<NextGenTokenTrait[]> {
  return await manager.getRepository(NextGenTokenTrait).find();
}
