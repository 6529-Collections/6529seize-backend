import { createHash } from 'node:crypto';
import type {
  MarketOperationRow,
  MarketOperationState
} from './market-operations.db';
import type { MarketTransaction } from './provider.types';

export interface MarketSendAttempt {
  attempt_id: string;
  purpose: 'APPROVAL' | 'TRANSACTION';
  transaction_digest: string;
  transaction: MarketTransaction;
  snapshot_block: number;
  previous_state: MarketOperationState;
  status: 'ACTIVE' | 'REJECTED' | 'RESOLVED';
  transaction_hash?: string;
  rejection_reason?: 'USER_REJECTED' | 'WALLET_NOT_REQUESTED';
}

export function operationSendAttempt(
  row: MarketOperationRow
): MarketSendAttempt | undefined {
  const value = row.send_attempt_json;
  return value
    ? ((typeof value === 'string'
        ? JSON.parse(value)
        : value) as MarketSendAttempt)
    : undefined;
}

export function marketOperationRevision(row: MarketOperationRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        requestHash: row.request_hash,
        prepared: row.prepared_json,
        updatedAt: row.updated_at,
        state: row.state,
        transactionHash: row.transaction_hash,
        errorCode: row.error_code,
        expiresAt: row.expires_at,
        sendAttempt: row.send_attempt_json ?? null
      })
    )
    .digest('hex');
}

export function reviewedTransactionDigest(
  tx: Pick<MarketTransaction, 'from' | 'to' | 'data' | 'value'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        chain_id: 1,
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        data: tx.data.toLowerCase(),
        value: BigInt(tx.value).toString()
      })
    )
    .digest('hex');
}
