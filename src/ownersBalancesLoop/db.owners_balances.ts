import { getDataSource } from '../db';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { Logger } from '../logging';

const logger = Logger.get('DB_OWNER_BALANCES_LOOP');

export async function fetchAllOwnerBalances() {
  return await getDataSource().getRepository(OwnerBalances).find();
}

export async function fetchAllOwnerBalancesMemes() {
  return await getDataSource().getRepository(OwnerBalancesMemes).find();
}

export async function fetchAllConsolidatedOwnerBalances() {
  return await getDataSource().getRepository(ConsolidatedOwnerBalances).find();
}

export async function fetchAllConsolidatedOwnerBalancesMemes() {
  return await getDataSource()
    .getRepository(ConsolidatedOwnerBalancesMemes)
    .find();
}

export async function persistOwnerBalances(
  ownerBalances: OwnerBalances[],
  ownerBalancesMemes: OwnerBalancesMemes[]
) {
  logger.info({
    message: '[PERSISTING OWNER BALANCES]',
    balances: ownerBalances.length.toLocaleString(),
    balancesMemes: ownerBalancesMemes.length.toLocaleString()
  });

  await getDataSource().transaction(async (manager) => {
    const balancesRepo = manager.getRepository(OwnerBalances);
    const balancesMemesRepo = manager.getRepository(OwnerBalancesMemes);

    await Promise.all(
      ownerBalances.map(async (ob) => {
        if (0 >= ob.total_balance) {
          await balancesRepo.remove(ob);
        } else {
          await balancesRepo.upsert(ob, ['wallet']);
        }
      })
    );

    await Promise.all(
      ownerBalancesMemes.map(async (obm) => {
        if (0 >= obm.balance) {
          await balancesMemesRepo.remove(obm);
        } else {
          await balancesMemesRepo.upsert(obm, ['wallet']);
        }
      })
    );
  });

  logger.info({
    message: '[OWNER BALANCES PERSISTED]'
  });
}

export async function persistConsolidatedOwnerBalances(
  consolidatedOwnerBalances: ConsolidatedOwnerBalances[],
  consolidatedOwnerBalancesMemes: ConsolidatedOwnerBalancesMemes[]
) {
  logger.info({
    message: '[PERSISTING CONSOLIDATED OWNER BALANCES]',
    balances: consolidatedOwnerBalances.length.toLocaleString(),
    balancesMemes: consolidatedOwnerBalancesMemes.length.toLocaleString()
  });

  await getDataSource().transaction(async (manager) => {
    const balancesRepo = manager.getRepository(ConsolidatedOwnerBalances);
    const balancesMemesRepo = manager.getRepository(
      ConsolidatedOwnerBalancesMemes
    );

    await Promise.all(
      consolidatedOwnerBalances.map(async (cob) => {
        if (0 >= cob.total_balance) {
          await balancesRepo.remove(cob);
        } else {
          await balancesRepo.upsert(cob, ['consolidation_key']);
        }
      })
    );

    await Promise.all(
      consolidatedOwnerBalancesMemes.map(async (cobm) => {
        if (0 >= cobm.balance) {
          await balancesMemesRepo.remove(cobm);
        } else {
          await balancesMemesRepo.upsert(cobm, ['consolidation_key']);
        }
      })
    );
  });

  logger.info({
    message: '[CONSOLIDATED OWNER BALANCES PERSISTED]'
  });
}
