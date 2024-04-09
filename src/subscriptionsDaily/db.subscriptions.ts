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

export async function fetchAllAutoSubscriptions() {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .find({ where: { automatic: true }, order: { created_at: 'ASC' } });
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
  let connection = manager ?? getDataSource();
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
