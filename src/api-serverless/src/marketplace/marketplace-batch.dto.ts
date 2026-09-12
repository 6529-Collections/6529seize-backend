import {
  ApiMarketBatchOperation,
  ApiMarketBatchOperationKindEnum,
  ApiMarketBatchOperationExecutionPolicyEnum,
  ApiMarketBatchOperationStateEnum
} from '@/api/generated/models/ApiMarketBatchOperation';
import { ApiMarketBatchSettlementOutcomeEnum } from '@/api/generated/models/ApiMarketBatchSettlement';
import {
  ApiMarketBatchSendAttemptPurposeEnum,
  ApiMarketBatchSendAttemptStatusEnum
} from '@/api/generated/models/ApiMarketBatchSendAttempt';
import {
  ApiMarketBatchTransaction,
  ApiMarketBatchTransactionPurposeEnum,
  ApiMarketBatchTransactionApprovalScopeEnum
} from '@/api/generated/models/ApiMarketBatchTransaction';
import { MarketTransaction } from '@/marketplace/provider.types';
import { MarketBatchPrepareRequest } from '@/marketplace/market-batch.schema';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { MarketOperationRow } from '@/marketplace/market-operations.db';
import {
  marketOperationRevision,
  operationSendAttempt
} from '@/marketplace/market-operation-state';
import {
  transactionDto,
  componentsDto
} from '@/api/marketplace/marketplace-shared.dto';

function batchTransactionDto(
  transaction: MarketTransaction
): ApiMarketBatchTransaction {
  const {
    purpose: _purpose,
    approval_scope: _scope,
    ...dto
  } = transactionDto(transaction);
  return {
    ...dto,
    purpose: transaction.purpose as ApiMarketBatchTransactionPurposeEnum,
    ...(transaction.approvalScope
      ? {
          approval_scope:
            transaction.approvalScope as ApiMarketBatchTransactionApprovalScopeEnum
        }
      : {})
  };
}

export function batchOperationDto(
  row: MarketOperationRow,
  request: MarketBatchPrepareRequest,
  prepared?: MarketBatchPrepared
): ApiMarketBatchOperation {
  const attempt = operationSendAttempt(row);
  const settlement = prepared?.settlement;
  return {
    id: row.id,
    revision: marketOperationRevision(row),
    state: row.state as ApiMarketBatchOperationStateEnum,
    profile_id: row.profile_id,
    wallet: row.wallet,
    kind: ApiMarketBatchOperationKindEnum.BuyBatch,
    execution_policy: ApiMarketBatchOperationExecutionPolicyEnum.AllOrRevert,
    currency: request.currency,
    total_wei: prepared?.intent.totalWei ?? request.amount_wei,
    potential_liability_wei: row.liability_wei,
    approval_transactions: [],
    items: request.items.map((item, index) => {
      const line = prepared?.intent.items[index];
      const order = prepared?.reviewOrders[index];
      return {
        ...item,
        allocations: item.allocations.map((allocation, position) => ({
          ...allocation,
          ...(line
            ? {
                recipient_in_profile:
                  line.allocations[position].recipientInProfile
              }
            : {})
        })),
        ...(line
          ? {
              net_wei: line.intent.minNetWei,
              fees: line.intent.fees.map((fee) => ({
                recipient: fee.recipient,
                amount_wei: fee.amountWei
              }))
            }
          : {}),
        ...(order
          ? {
              reviewed_order: {
                protocol_address: order.protocolAddress,
                order_hash: order.orderHash,
                digest: order.digest,
                components: componentsDto(order.components)
              }
            }
          : {})
      };
    }),
    ...(prepared
      ? {
          transaction: {
            ...batchTransactionDto(prepared.transaction),
            ...prepared.gas
          },
          mirror_terms: {
            start_time: prepared.mirrorTerms.startTime,
            end_time: prepared.mirrorTerms.endTime,
            salt: prepared.mirrorTerms.salt
          },
          block_number: prepared.snapshot.block_number,
          block_hash: prepared.snapshot.block_hash,
          block_timestamp: prepared.snapshot.block_timestamp
        }
      : {}),
    ...(attempt
      ? {
          send_attempt: {
            attempt_id: attempt.attempt_id,
            purpose: attempt.purpose as ApiMarketBatchSendAttemptPurposeEnum,
            status: attempt.status as ApiMarketBatchSendAttemptStatusEnum,
            transaction_digest: attempt.transaction_digest,
            snapshot_block: attempt.snapshot_block,
            transaction: batchTransactionDto(attempt.transaction),
            transaction_hash: attempt.transaction_hash ?? null
          }
        }
      : {}),
    ...(row.transaction_hash ? { transaction_hash: row.transaction_hash } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(settlement
      ? {
          settlement: {
            outcome: ApiMarketBatchSettlementOutcomeEnum.AllSelected,
            items: settlement.items.map((item) => ({
              asset_key: item.assetKey,
              order: {
                protocol_address: item.order.protocolAddress,
                order_hash: item.order.orderHash
              },
              filled_quantity: item.filledQuantity,
              allocations: item.allocations.map((allocation) => ({
                recipient: allocation.recipient,
                quantity: allocation.quantity,
                acknowledge_external_recipient:
                  allocation.acknowledgeExternalRecipient,
                recipient_in_profile: allocation.recipientInProfile
              }))
            })),
            transaction_hash: settlement.transactionHash,
            block_number: settlement.blockNumber,
            block_hash: settlement.blockHash,
            ...(settlement.safeBlockNumber === undefined
              ? {}
              : { safe_block_number: settlement.safeBlockNumber })
          }
        }
      : {}),
    expires_at: Number(row.expires_at),
    updated_at: Number(row.updated_at)
  };
}
