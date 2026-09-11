import { ApiMarketKind } from '@/api/generated/models/ApiMarketKind';
import {
  ApiMarketOperation,
  ApiMarketOperationStateEnum
} from '@/api/generated/models/ApiMarketOperation';
import {
  ApiMarketTransaction,
  ApiMarketTransactionApprovalScopeEnum,
  ApiMarketTransactionPurposeEnum
} from '@/api/generated/models/ApiMarketTransaction';
import {
  MarketOperationRow,
  marketRequestHash
} from '@/marketplace/market-operations.db';
import {
  MarketPrepared,
  MarketPrepareRequest,
  marketPrepareSchema
} from '@/marketplace/market-preparation';
import {
  MarketTransaction,
  MarketDiscoveredOrder
} from '@/marketplace/provider.types';
import {
  ApiMarketOrder,
  ApiMarketOrderSideEnum
} from '@/api/generated/models/ApiMarketOrder';
import { MarketSettlement } from '@/marketplace/market-reconciliation';

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
export function operationRequest(
  row: MarketOperationRow
): MarketPrepareRequest {
  return marketPrepareSchema.parse(json(row.request_json));
}
export function operationPrepared(
  row: MarketOperationRow
): MarketPrepared | undefined {
  return row.prepared_json
    ? (json(row.prepared_json) as MarketPrepared)
    : undefined;
}
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
export function discoveredOrderDto(
  order: MarketDiscoveredOrder,
  assetKey: string
): ApiMarketOrder {
  return {
    identity: {
      protocol_address: order.identity.protocolAddress,
      order_hash: order.identity.orderHash
    },
    asset_key: assetKey,
    maker: order.maker,
    recipient: order.recipient,
    side: order.side as ApiMarketOrderSideEnum,
    quantity: order.quantity,
    currency: order.currency,
    total_wei: order.totalWei,
    net_wei: order.netWei,
    fees: order.fees.map((fee) => ({
      recipient: fee.recipient,
      amount_wei: fee.amountWei
    })),
    start_time: order.startTime,
    end_time: order.endTime
  };
}
function componentsDto(
  c: NonNullable<MarketPrepared['signedOrder']>['order']['components']
) {
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
export function operationDto(row: MarketOperationRow): ApiMarketOperation {
  const request = operationRequest(row),
    prepared = operationPrepared(row);
  const intent = prepared?.intent;
  const signed = prepared?.signedOrder?.order ?? prepared?.reviewOrder;
  const settlement = (
    prepared as (MarketPrepared & { settlement?: MarketSettlement }) | undefined
  )?.settlement;
  return {
    id: row.id,
    revision: marketRequestHash({
      requestHash: row.request_hash,
      prepared: row.prepared_json,
      updatedAt: row.updated_at
    }),
    state: row.state as ApiMarketOperationStateEnum,
    profile_id: row.profile_id,
    kind: request.kind as ApiMarketKind,
    wallet: row.wallet,
    recipient: request.recipient,
    recipient_in_profile: prepared?.recipientInProfile ?? false,
    asset_key: request.asset_key,
    quantity: request.quantity,
    currency: request.currency,
    total_wei: intent?.maxTotalWei ?? request.amount_wei,
    potential_liability_wei: row.liability_wei,
    net_wei: intent?.minNetWei ?? '0',
    fees: (intent?.fees ?? []).map((fee) => ({
      recipient: fee.recipient,
      amount_wei: fee.amountWei
    })),
    approval_transactions: (prepared?.approvalTransactions ?? []).map(
      transactionDto
    ),
    ...(prepared?.transaction
      ? {
          transaction: {
            ...transactionDto(prepared.transaction),
            ...prepared.gas
          }
        }
      : {}),
    ...(signed
      ? {
          order: {
            protocol_address: signed.protocolAddress,
            order_hash: signed.orderHash,
            digest: signed.digest,
            components: componentsDto(signed.components)
          }
        }
      : {}),
    ...(row.transaction_hash ? { transaction_hash: row.transaction_hash } : {}),
    ...(row.order_hash ? { order_hash: row.order_hash } : {}),
    ...(prepared?.nftRecipient ? { nft_recipient: prepared.nftRecipient } : {}),
    ...(settlement
      ? {
          settlement: {
            filled_quantity: settlement.filledQuantity,
            remaining_quantity: settlement.remainingQuantity,
            ...(settlement.transactionHash
              ? { transaction_hash: settlement.transactionHash }
              : {}),
            ...(settlement.blockNumber !== undefined
              ? { block_number: settlement.blockNumber }
              : {}),
            ...(settlement.blockHash
              ? { block_hash: settlement.blockHash }
              : {}),
            ...(settlement.safeBlockNumber !== undefined
              ? { safe_block_number: settlement.safeBlockNumber }
              : {})
          }
        }
      : {}),
    expires_at: Number(row.expires_at),
    updated_at: Number(row.updated_at),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(prepared
      ? {
          block_number: prepared.snapshot.block_number,
          block_hash: prepared.snapshot.block_hash
        }
      : {})
  };
}
