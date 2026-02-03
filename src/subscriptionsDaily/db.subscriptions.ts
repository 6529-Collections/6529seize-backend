import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  MEMES_SEASONS_TABLE
} from '@/constants';
import { getDataSource } from '../db';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { insertWithoutUpdate } from '../orm_helpers';
import { sqlExecutor } from '../sql-executor';

export async function fetchAllAutoSubscriptions() {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .find({ where: { automatic: true }, order: { created_at: 'ASC' } });
}

export async function fetchSubscriptionModeForConsolidationKey(
  consolidationKey: string
) {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .findOne({ where: { consolidation_key: consolidationKey } });
}

export async function fetchAllNftSubscriptions(contract: string, id: number) {
  return await getDataSource()
    .getRepository(NFTSubscription)
    .find({ where: { contract: contract, token_id: id } });
}

export async function fetchAllNftSubscriptionBalances() {
  return await getDataSource().getRepository(SubscriptionBalance).find();
}

export async function fetchNftFinalSubscriptionForConsolidationKey(
  contract: string,
  token_id: number,
  consolidation_key: string
) {
  return await getDataSource().getRepository(NFTFinalSubscription).find({
    where: {
      contract,
      token_id,
      consolidation_key
    }
  });
}

export async function fetchSubscriptionBalanceForConsolidationKey(
  consolidation_key: string,
  manager?: any
) {
  const connection = manager ?? getDataSource();
  return await connection
    .getRepository(SubscriptionBalance)
    .findOne({ where: { consolidation_key } });
}

export async function persistSubscriptions(
  subscriptions: NFTSubscription[],
  logs: SubscriptionLog[]
) {
  await getDataSource().transaction(async (manager) => {
    await getDataSource()
      .getRepository(NFTSubscription)
      .upsert(subscriptions, ['consolidation_key', 'contract', 'token_id']);
    await manager.getRepository(SubscriptionLog).insert(logs);
  });
}

export async function persistNFTFinalSubscriptions(
  contract: string,
  token_id: number,
  upload: NFTFinalSubscriptionUpload,
  subscriptions: NFTFinalSubscription[],
  logs: SubscriptionLog[]
) {
  await getDataSource().transaction(async (manager) => {
    const finalRepo = manager.getRepository(NFTFinalSubscription);
    const uploadRepo = manager.getRepository(NFTFinalSubscriptionUpload);
    await finalRepo.delete({
      contract: contract,
      token_id: token_id
    });
    await insertWithoutUpdate(finalRepo, subscriptions);
    await uploadRepo.upsert(upload, ['contract', 'token_id']);

    await manager.getRepository(SubscriptionLog).insert(logs);
  });
}

export async function fetchSubscriptionEligibility(
  consolidationKey: string
): Promise<number> {
  const maxSeasonId = await sqlExecutor.execute<{ max_id: number }>(
    `SELECT MAX(id) as max_id FROM ${MEMES_SEASONS_TABLE}`
  );

  if (!maxSeasonId || maxSeasonId.length === 0 || !maxSeasonId[0].max_id) {
    return 1;
  }

  const seasonId = maxSeasonId[0].max_id;

  const cardSetsResult = await sqlExecutor.execute<{
    sets: number;
  }>(
    `SELECT sets FROM ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} 
     WHERE consolidation_key = :consolidationKey AND season = :seasonId`,
    { consolidationKey, seasonId }
  );

  if (
    !cardSetsResult ||
    cardSetsResult.length === 0 ||
    !cardSetsResult[0].sets ||
    cardSetsResult[0].sets === 0
  ) {
    return 1;
  }

  return cardSetsResult[0].sets;
}
