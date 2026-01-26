import { getDataSource } from '../db';
import { Logger } from '../logging';
import {
  ConsolidatedNFTOwner,
  NFTOwner,
  NftOwnersSyncState
} from '../entities/INFTOwner';
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

const SYNC_STATE_ROW_ID = 1;

export async function getNftOwnersSyncBlock(): Promise<number> {
  const row = await getDataSource()
    .getRepository(NftOwnersSyncState)
    .findOne({ where: { id: SYNC_STATE_ROW_ID } });
  return row ? Number(row.block_reference ?? 0) : 0;
}

export async function setNftOwnersSyncBlock(block: number): Promise<void> {
  await getDataSource()
    .getRepository(NftOwnersSyncState)
    .save({ id: SYNC_STATE_ROW_ID, block_reference: block });
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
      const addressesList = Array.from(addresses).map((a) => a.toLowerCase());
      const deleted = await repo
        .createQueryBuilder()
        .delete()
        .from(NFTOwner)
        .where('LOWER(wallet) IN (:...addresses)', {
          addresses: addressesList
        })
        .execute();
      await insertWithoutUpdate(repo, ownersDelta);
      logger.info(
        `[INSERTED ${ownersDelta.length} NFT OWNERS] : [DELETED ${deleted.affected} NFT OWNERS]`
      );
    });
  }
}

const CONSOLIDATED_INSERT_BATCH_SIZE = 2500;

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
      for (let i = 0; i < upsertDelta.length; i += CONSOLIDATED_INSERT_BATCH_SIZE) {
        const chunk = upsertDelta.slice(i, i + CONSOLIDATED_INSERT_BATCH_SIZE);
        await insertWithoutUpdate(repo, chunk);
      }
      logger.info(`[INSERTED ${upsertDelta.length} CONSOLIDATED NFT OWNERS]`);
    });
  }
}
