import { getDataSource } from '../db';
import { Logger } from '../logging';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { NFT_OWNERS_TABLE } from '../constants';
import {
  deleteConsolidations,
  insertWithoutUpdate,
  resetRepository
} from '../orm_helpers';

const logger = Logger.get('DB_NFT_OWNERS');

export async function getMaxNftOwnersBlockReference(): Promise<number> {
  const maxBlock = await getDataSource()
    .getRepository(NFTOwner)
    .createQueryBuilder(NFT_OWNERS_TABLE)
    .select(`MAX(${NFT_OWNERS_TABLE}.block_reference)`, 'max_block')
    .getRawOne();

  return maxBlock.max_block ?? 0;
}

export async function fetchAllNftOwners(
  contracts?: string[],
  pk?: string[]
): Promise<NFTOwner[]> {
  const queryBuilder = getDataSource()
    .getRepository(NFTOwner)
    .createQueryBuilder('nftowner');

  if (contracts) {
    queryBuilder.where('nftowner.contract IN (:...contracts)', {
      contracts
    });
  }
  if (pk) {
    queryBuilder.where(`nftowner.wallet IN (:...pk)`, {
      pk
    });
  }

  return await queryBuilder.getMany();
}

export async function fetchDistinctNftOwnerWallets(
  contracts?: string[],
  fromBlock?: number
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

  if (fromBlock) {
    queryBuilder.andWhere('nftowner.block_reference > :fromBlock', {
      fromBlock
    });
  }

  return (await queryBuilder.getRawMany()).map((row) => row.wallet);
}

export async function persistNftOwners(
  addresses: Set<string>,
  ownersDelta: NFTOwner[],
  reset: boolean
) {
  if (reset) {
    logger.info(`[RESETTING NFT OWNERS...]`);
    const repo = getDataSource().getRepository(NFTOwner);
    await resetRepository(repo, ownersDelta);
    logger.info(`[INSERTED ${ownersDelta.length} NFT OWNERS]`);
  } else {
    logger.info(`[UPSERTING NFT OWNERS...]`);
    await getDataSource().transaction(async (manager) => {
      const repo = manager.getRepository(NFTOwner);
      const deleted = await repo
        .createQueryBuilder()
        .delete()
        .from(NFTOwner)
        .where('wallet IN (:...addresses)', {
          addresses: Array.from(addresses)
        })
        .execute();
      await insertWithoutUpdate(repo, ownersDelta);
      logger.info(
        `[INSERTED ${ownersDelta.length} NFT OWNERS] : [DELETED ${deleted.affected} NFT OWNERS]`
      );
    });
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
      await insertWithoutUpdate(repo, upsertDelta);
      logger.info(`[INSERTED ${upsertDelta.length} CONSOLIDATED NFT OWNERS]`);
    });
  }
}
