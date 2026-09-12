import {
  MarketBatchPrepared,
  MarketBatchFulfillmentMaterial
} from '@/marketplace/market-batch.types';
import { MARKET_BATCH_INTERFACE } from '@/marketplace/seaport-batch.builder';
import { MARKET_OPENSEA_CONDUIT_KEY } from '@/marketplace/seaport.registry';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import { rejectMarketBatch } from '@/marketplace/market-batch-validation';

/** Recover authorization only from the exact persisted transaction; never refetch during receipt recovery. */
export function batchPreparedMaterials(
  prepared: MarketBatchPrepared
): MarketBatchFulfillmentMaterial[] {
  const decoded = MARKET_BATCH_INTERFACE.decodeFunctionData(
    'matchAdvancedOrders',
    prepared.transaction.data
  );
  if (
    decoded.orders.length !== prepared.reviewOrders.length + 1 ||
    prepared.reviewOrders.length !== prepared.intent.items.length
  )
    rejectMarketBatch('The persisted batch order count changed.');
  return prepared.reviewOrders.map((review, index) => {
    const order = validateMarketOrder(
      prepared.intent.items[index].intent,
      review.components,
      review.protocolAddress
    );
    if (order.orderHash !== review.orderHash || order.digest !== review.digest)
      rejectMarketBatch('The persisted selected order changed.');
    return {
      order,
      signature: decoded.orders[index].signature as string,
      extraData: decoded.orders[index].extraData as string,
      fulfillerConduitKey: MARKET_OPENSEA_CONDUIT_KEY
    };
  });
}
