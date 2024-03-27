import { getDataSource } from '../db';
import {
  NFTSubscription,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';

export async function fetchAllAutoSubscriptions() {
  return await getDataSource()
    .getRepository(SubscriptionMode)
    .find({ where: { automatic: true } });
}

export async function fetchAllNftSubscriptions(contract: string, id: number) {
  return await getDataSource()
    .getRepository(NFTSubscription)
    .find({ where: { contract: contract, token_id: id } });
}

export async function persistSubscriptions(subscriptions: NFTSubscription[]) {
  await getDataSource()
    .getRepository(NFTSubscription)
    .upsert(subscriptions, ['consolidation_key', 'contract', 'token_id']);
}

export async function persistSubscriptionLogs(logs: SubscriptionLog[]) {
  await getDataSource().getRepository(SubscriptionLog).insert(logs);
}
