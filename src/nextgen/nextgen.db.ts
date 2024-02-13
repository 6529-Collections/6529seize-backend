import {
  NextGenBlock,
  NextGenCollection,
  NextGenLog,
  NextGenToken,
  NextGenTokenTrait
} from '../entities/INextGen';
import { EntityManager, IsNull } from 'typeorm';
import {
  NEXTGEN_START_BLOCK,
  NEXTGEN_TOKENS_TABLE,
  getNextgenNetwork
} from './nextgen_constants';
import { sqlExecutor } from '../sql-executor';
import { Transaction } from '../entities/ITransaction';

export async function fetchNextGenLatestBlock(manager: EntityManager) {
  const block = await manager
    .getRepository(NextGenBlock)
    .createQueryBuilder()
    .select('MAX(block)', 'max_block')
    .getRawOne();
  return block.max_block ?? NEXTGEN_START_BLOCK[getNextgenNetwork()];
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

export async function persistNextgenTransaction(
  manager: EntityManager,
  transaction: Transaction
) {
  const repo = manager.getRepository(Transaction);
  await repo.upsert(transaction, [
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

export async function fetchMissingDataNextgenTokens(manager: EntityManager) {
  return await manager.getRepository(NextGenToken).find({
    where: {
      mint_data: IsNull()
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

export async function wasTransactionLogProcessed(
  manager: EntityManager,
  txHash: string
): Promise<boolean> {
  const count = await manager.getRepository(NextGenLog).count({
    where: {
      transaction: txHash
    }
  });
  return count > 0;
}

export async function fetchNextgenToken(
  manager: EntityManager,
  tokenId: number
) {
  return await manager.getRepository(NextGenToken).findOne({
    where: {
      id: tokenId
    }
  });
}

export async function fetchNextgenTokens(manager?: EntityManager) {
  if (manager) {
    return await manager.getRepository(NextGenToken).find();
  } else {
    const sql = `SELECT * FROM ${NEXTGEN_TOKENS_TABLE};`;
    return await sqlExecutor.execute(sql);
  }
}

export async function persistNextGenCollectionHodlRate(
  manager: EntityManager,
  collectionId: number,
  hodlRate: number
) {
  await manager.getRepository(NextGenToken).update(
    {
      collection_id: collectionId
    },
    { hodl_rate: hodlRate }
  );
}
