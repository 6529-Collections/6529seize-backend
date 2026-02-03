import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataResult,
  SortingOrder
} from 'alchemy-sdk';
import { SUBSCRIPTIONS_ADDRESS } from '@/constants';
import { SubscriptionTopUp } from '../entities/ISubscription';

export async function getAllSubscriptionTopUps(
  alchemy: Alchemy,
  fromBlock: number,
  toBlock: number
): Promise<SubscriptionTopUp[]> {
  const subscriptions: AssetTransfersWithMetadataResult[] = [];
  let pageKey: string | undefined = undefined;
  do {
    const result = await getSubscriptions(alchemy, fromBlock, toBlock, pageKey);
    subscriptions.push(...result.transfers);
    pageKey = result.pageKey;
  } while (pageKey);

  return subscriptions.map((subscription) => {
    const topUp: SubscriptionTopUp = {
      block: parseInt(subscription.blockNum, 16),
      transaction_date: new Date(subscription.metadata.blockTimestamp),
      hash: subscription.hash,
      from_wallet: subscription.from.toLowerCase(),
      amount: subscription.value ?? 0
    };
    return topUp;
  });
}

async function getSubscriptions(
  alchemy: Alchemy,
  fromBlock: number,
  toBlock: number,
  pageKey?: string
): Promise<{
  transfers: AssetTransfersWithMetadataResult[];
  pageKey?: string;
}> {
  const subscriptions = await alchemy.core.getAssetTransfers({
    category: [
      AssetTransfersCategory.EXTERNAL,
      AssetTransfersCategory.INTERNAL
    ],
    order: SortingOrder.ASCENDING,
    maxCount: 150,
    withMetadata: true,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    toAddress: SUBSCRIPTIONS_ADDRESS,
    pageKey: pageKey
  });
  const transfers = subscriptions.transfers.filter(
    (subscriptions) =>
      subscriptions.to?.toLowerCase() === SUBSCRIPTIONS_ADDRESS.toLowerCase()
  );
  return {
    transfers,
    pageKey: subscriptions.pageKey
  };
}
