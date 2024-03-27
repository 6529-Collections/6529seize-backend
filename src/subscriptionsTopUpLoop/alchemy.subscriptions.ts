import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataResult
} from 'alchemy-sdk';
import { SUBSCRIPTIONS_ADDRESS } from '../constants';
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

  const topUps = subscriptions.map((subscription) => {
    const topUp: SubscriptionTopUp = {
      block: parseInt(subscription.blockNum, 16),
      transaction_date: new Date(subscription.metadata.blockTimestamp),
      hash: subscription.hash,
      from_wallet: subscription.from.toLowerCase(),
      amount: subscription.value ?? 0
    };
    return topUp;
  });

  return topUps;
}

async function getSubscriptions(
  alchemy: Alchemy,
  fromBlock: number,
  toBlock: number,
  pageKey?: string
) {
  const subscriptions = await alchemy.core.getAssetTransfers({
    category: [AssetTransfersCategory.EXTERNAL],
    maxCount: 150,
    withMetadata: true,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
    toAddress: SUBSCRIPTIONS_ADDRESS,
    pageKey: pageKey
  });
  return subscriptions;
}
