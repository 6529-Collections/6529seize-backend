import {
  ApiMarketTransaction,
  ApiMarketTransactionApprovalScopeEnum,
  ApiMarketTransactionPurposeEnum
} from '@/api/generated/models/ApiMarketTransaction';
import {
  MarketTransaction,
  SeaportOrderComponents
} from '@/marketplace/provider.types';

export function transactionDto(
  transaction: MarketTransaction
): ApiMarketTransaction {
  return {
    chain_id: transaction.chainId,
    sender: transaction.from,
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
    purpose: transaction.purpose as ApiMarketTransactionPurposeEnum,
    ...transaction.gas,
    ...(transaction.approvalScope
      ? {
          approval_scope:
            transaction.approvalScope as ApiMarketTransactionApprovalScopeEnum
        }
      : {})
  };
}
export function componentsDto(c: SeaportOrderComponents) {
  const item = (entry: (typeof c.offer)[number]) => ({
    item_type: entry.itemType,
    token: entry.token,
    identifier_or_criteria: entry.identifierOrCriteria,
    start_amount: entry.startAmount,
    end_amount: entry.endAmount
  });
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer.map(item),
    consideration: c.consideration.map((entry) => ({
      ...item(entry),
      recipient: entry.recipient
    })),
    order_type: c.orderType,
    start_time: c.startTime,
    end_time: c.endTime,
    zone_hash: c.zoneHash,
    salt: c.salt,
    conduit_key: c.conduitKey,
    counter: c.counter
  };
}
