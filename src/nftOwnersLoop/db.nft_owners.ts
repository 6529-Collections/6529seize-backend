import { getDataSource } from '../db';
import { Logger } from '../logging';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { NFT_OWNERS_TABLE } from '../constants';
import { EntityTarget } from 'typeorm';
import {
  deleteConsolidations,
  resetRepository,
  upsertRepository
} from '../orm_helpers';

const logger = Logger.get('DB_NFT_OWNERS');

export async function getMaxBlockReference(): Promise<number> {
  const maxBlock = await getDataSource()
    .getRepository(NFTOwner)
    .createQueryBuilder(NFT_OWNERS_TABLE)
    .select(`MAX(${NFT_OWNERS_TABLE}.block_reference)`, 'max_block')
    .getRawOne();

  return maxBlock.max_block ?? 0;
}

export async function fetchAllNftOwners(contracts?: string[], pk?: string[]) {
  return (await fetchAllNftOwnersByClass(
    NFTOwner,
    contracts,
    pk
  )) as NFTOwner[];
}

export async function fetchDistinctNftOwnerWallets(
  contracts?: string[]
): Promise<string[]> {
  const queryBuilder = getDataSource()
    .getRepository(NFTOwner)
    .createQueryBuilder('nftowner')
    .select('DISTINCT nftowner.wallet', 'wallet');

  if (contracts) {
    queryBuilder.where('nftowner.contract IN (:...contracts)', {
      contracts
    });
  }

  return (await queryBuilder.getRawMany()).map((row) => row.wallet);
}

async function fetchAllNftOwnersByClass<T>(
  entityClass: EntityTarget<NFTOwner | ConsolidatedNFTOwner>,
  contracts?: string[],
  pk?: string[]
): Promise<(NFTOwner | ConsolidatedNFTOwner)[]> {
  const pkColumn = entityClass === NFTOwner ? 'wallet' : 'consolidation_key';

  const queryBuilder = getDataSource()
    .getRepository(entityClass)
    .createQueryBuilder('nftowner');

  if (contracts) {
    queryBuilder.where('nftowner.contract IN (:...contracts)', {
      contracts
    });
  }
  if (pk) {
    queryBuilder.where(`nftowner.${pkColumn} IN (:...pk)`, {
      pk
    });
  }

  return await queryBuilder.getMany();
}

export async function persistNftOwners(
  upsertDelta: NFTOwner[],
  deleteDelta: NFTOwner[],
  reset: boolean
) {
  if (reset) {
    logger.info(`[RESETTING NFT OWNERS...]`);
    const repo = getDataSource().getRepository(NFTOwner);
    await resetRepository(repo, upsertDelta);
    logger.info(`[INSERTED ${upsertDelta.length} NFT OWNERS]`);
  } else {
    logger.info(`[UPSERTING NFT OWNERS...]`);
    await getDataSource().transaction(async (manager) => {
      const repo = manager.getRepository(NFTOwner);
      await upsertRepository(
        repo,
        ['wallet', 'contract', 'token_id'],
        upsertDelta,
        deleteDelta
      );
    });
    logger.info(
      `[UPSERTED ${upsertDelta.length} NFT OWNERS] : [DELETED ${deleteDelta.length} NFT OWNERS]`
    );
  }
}

export async function persistConsolidatedNftOwners(
  upsertDelta: ConsolidatedNFTOwner[],
  deleteDelta: Set<string>,
  reset?: boolean
) {
  if (reset) {
    logger.info(`[RESETTING CONSOLIDATED NFT OWNERS...]`);
    const repo = getDataSource().getRepository(ConsolidatedNFTOwner);
    await resetRepository(repo, upsertDelta);
    logger.info(`[INSERTED ${upsertDelta.length} CONSOLIDATED NFT OWNERS]`);
  } else {
    logger.info(`[UPSERTING CONSOLIDATED NFT OWNERS...]`);
    await getDataSource().transaction(async (manager) => {
      const repo = manager.getRepository(ConsolidatedNFTOwner);
      const deleted = await deleteConsolidations(repo, deleteDelta);
      logger.info(`[DELETED ${deleted} CONSOLIDATED NFT OWNERS]`);
      await repo.insert(upsertDelta);
      logger.info(`[INSERTED ${upsertDelta.length} CONSOLIDATED NFT OWNERS]`);
    });
  }
}
