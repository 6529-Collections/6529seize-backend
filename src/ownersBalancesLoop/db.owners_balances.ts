import { Repository } from 'typeorm';
import { OWNERS_BALANCES_TABLE } from '../constants';
import { getDataSource } from '../db';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { Logger } from '../logging';
import {
  deleteConsolidations,
  deleteWallet,
  insertWithoutUpdate,
  resetRepository
} from '../orm_helpers';

const logger = Logger.get('DB_OWNER_BALANCES');

export async function fetchAllOwnerBalances(addresses?: string[]) {
  const queryBuilder = getDataSource()
    .getRepository(OwnerBalances)
    .createQueryBuilder('ownerBalances');

  if (addresses) {
    queryBuilder.where('ownerBalances.wallet IN (:...addresses)', {
      addresses
    });
  }

  return await queryBuilder.getMany();
}

export async function fetchAllOwnerBalancesMemes(addresses?: string[]) {
  const queryBuilder = getDataSource()
    .getRepository(OwnerBalancesMemes)
    .createQueryBuilder('ownerBalancesMemes');

  if (addresses) {
    queryBuilder.where('ownerBalancesMemes.wallet IN (:...addresses)', {
      addresses
    });
  }

  return await queryBuilder.getMany();
}

export async function fetchAllConsolidatedOwnerBalances() {
  return await getDataSource().getRepository(ConsolidatedOwnerBalances).find();
}

export async function fetchAllConsolidatedOwnerBalancesMemes() {
  return await getDataSource()
    .getRepository(ConsolidatedOwnerBalancesMemes)
    .find();
}

export async function getMaxOwnerBalancesBlockReference(): Promise<number> {
  const maxBlock = await getDataSource()
    .getRepository(OwnerBalances)
    .createQueryBuilder(OWNERS_BALANCES_TABLE)
    .select(`MAX(${OWNERS_BALANCES_TABLE}.block_reference)`, 'max_block')
    .getRawOne();

  return maxBlock.max_block ?? 0;
}

async function upsertBalances(
  balancesRepo: Repository<OwnerBalances | ConsolidatedOwnerBalances>,
  balancesMemesRepo: Repository<
    OwnerBalancesMemes | ConsolidatedOwnerBalancesMemes
  >,
  ownerBalances: OwnerBalances[] | ConsolidatedOwnerBalances[],
  ownerBalancesMemes: OwnerBalancesMemes[] | ConsolidatedOwnerBalancesMemes[],
  pk: string,
  reset: boolean
) {
  const removeBalancesArray = reset
    ? []
    : ownerBalances.filter((ob) => ob.total_balance <= 0);
  const upsertBalancesArray = ownerBalances.filter(
    (ob) => ob.total_balance > 0
  );
  const removeMemesArray = reset
    ? []
    : ownerBalancesMemes.filter((obm) => obm.balance <= 0);
  const upsertMemesArray = ownerBalancesMemes.filter((obm) => obm.balance > 0);

  logger.info({
    message: `[UPDATING OWNER BALANCES ${pk}]`,
    removeBalances: removeBalancesArray.length.toLocaleString(),
    upsertBalances: upsertBalancesArray.length.toLocaleString(),
    removeMemes: removeMemesArray.length.toLocaleString(),
    upsertMemes: upsertMemesArray.length.toLocaleString(),
    reset
  });

  await balancesRepo.remove(removeBalancesArray);
  await balancesRepo.upsert(upsertBalancesArray, [pk]);
  await balancesMemesRepo.remove(removeMemesArray);
  await balancesMemesRepo.upsert(upsertMemesArray, [pk, 'season']);
}

export async function persistOwnerBalances(
  ownerBalances: OwnerBalances[],
  ownerBalancesMemes: OwnerBalancesMemes[],
  deleteDelta: Set<string>,
  reset: boolean
) {
  if (reset) {
    logger.info(`[RESETTING OWNER BALANCES...]`);
    const balancesRepo = getDataSource().getRepository(OwnerBalances);
    const balancesMemesRepo = getDataSource().getRepository(OwnerBalancesMemes);
    await resetRepository(balancesRepo, ownerBalances);
    await resetRepository(balancesMemesRepo, ownerBalancesMemes);
  } else {
    await getDataSource().transaction(async (manager) => {
      const balancesRepo = manager.getRepository(OwnerBalances);
      const balancesMemesRepo = manager.getRepository(OwnerBalancesMemes);

      const deleted = await deleteWallet(balancesRepo, deleteDelta);
      const deletedMemes = await deleteWallet(balancesMemesRepo, deleteDelta);
      logger.info(
        `[DELETED ${deleted} OWNER BALANCES] : [DELETED ${deletedMemes} OWNER BALANCES MEMES]`
      );

      await upsertBalances(
        balancesRepo,
        balancesMemesRepo,
        ownerBalances,
        ownerBalancesMemes,
        'wallet',
        reset
      );
      logger.info({
        message: '[OWNER BALANCES PERSISTED]'
      });
    });
  }
}

export async function persistConsolidatedOwnerBalances(
  consolidatedOwnerBalances: ConsolidatedOwnerBalances[],
  consolidatedOwnerBalancesMemes: ConsolidatedOwnerBalancesMemes[],
  deleteDelta: Set<string>,
  reset: boolean
) {
  if (reset) {
    logger.info(`[RESETTING CONSOLIDATED OWNER BALANCES...]`);
    const balancesRepo = getDataSource().getRepository(
      ConsolidatedOwnerBalances
    );
    const balancesMemesRepo = getDataSource().getRepository(
      ConsolidatedOwnerBalancesMemes
    );
    await balancesRepo.clear();
    await insertWithoutUpdate(balancesRepo, consolidatedOwnerBalances);
    await balancesMemesRepo.clear();
    await insertWithoutUpdate(
      balancesMemesRepo,
      consolidatedOwnerBalancesMemes
    );
    logger.info(
      `[INSERTED ${consolidatedOwnerBalances.length} CONSOLIDATED OWNER BALANCES]`
    );
  } else {
    await getDataSource().transaction(async (manager) => {
      const balancesRepo = manager.getRepository(ConsolidatedOwnerBalances);
      const balancesMemesRepo = manager.getRepository(
        ConsolidatedOwnerBalancesMemes
      );

      const deleted = await deleteConsolidations(balancesRepo, deleteDelta);
      const deletedMemes = await deleteConsolidations(
        balancesMemesRepo,
        deleteDelta
      );
      logger.info(
        `[DELETED ${deleted} CONSOLIDATED NFT BALANCES] : [DELETED ${deletedMemes} CONSOLIDATED NFT BALANCES MEMES]`
      );
      await insertWithoutUpdate(balancesRepo, consolidatedOwnerBalances);
      await insertWithoutUpdate(
        balancesMemesRepo,
        consolidatedOwnerBalancesMemes
      );

      logger.info({
        message: '[CONSOLIDATED OWNER BALANCES PERSISTED]'
      });
    });
  }
}
