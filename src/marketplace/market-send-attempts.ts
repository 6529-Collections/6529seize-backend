import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import type { ConnectionWrapper } from '@/sql-executor';
import { marketChain } from './market-chain';
import { marketOperationsDb, MarketOperationRow } from './market-operations.db';
import {
  marketOperationRevision,
  MarketSendAttempt,
  operationSendAttempt,
  reviewedTransactionDigest
} from './market-operation-state';
import type { MarketOperationPrepared as MarketPrepared } from '@/marketplace/market-operation.types';
import { isMarketBatchPrepared } from '@/marketplace/market-operation.types';

export interface BeginMarketSendAttempt {
  expected_revision: string;
  attempt_id: string;
  purpose: MarketSendAttempt['purpose'];
  transaction_digest: string;
}

function changed(): never {
  throw new CustomApiCompliantException(
    409,
    'Refresh this trade before requesting the wallet.',
    'OPERATION_CHANGED'
  );
}
function preparedFrom(row: MarketOperationRow): MarketPrepared | undefined {
  return row.prepared_json
    ? ((typeof row.prepared_json === 'string'
        ? JSON.parse(row.prepared_json)
        : row.prepared_json) as MarketPrepared)
    : undefined;
}
function sameAttempt(
  attempt: MarketSendAttempt | undefined,
  input: BeginMarketSendAttempt
): boolean {
  return (
    attempt?.attempt_id === input.attempt_id &&
    attempt.purpose === input.purpose &&
    attempt.transaction_digest === input.transaction_digest
  );
}

/** The committed UNKNOWN state is the cross-device fence before a wallet can send. */
export async function beginMarketSendAttempt(
  row: MarketOperationRow,
  input: BeginMarketSendAttempt,
  beforeCommit?: (connection: ConnectionWrapper<unknown>) => Promise<void>
): Promise<MarketOperationRow> {
  const previous = operationSendAttempt(row);
  if (sameAttempt(previous, input)) return row;
  if (
    previous?.status === 'ACTIVE' ||
    previous?.attempt_id === input.attempt_id
  )
    changed();
  const prepared = preparedFrom(row);
  if (
    !prepared ||
    !['REVIEW', 'APPROVAL'].includes(row.state) ||
    Number(row.expires_at) <= Date.now()
  )
    changed();
  const purpose = prepared.approvalTransactions.length
    ? 'APPROVAL'
    : 'TRANSACTION';
  const transaction =
    purpose === 'APPROVAL'
      ? prepared.approvalTransactions[0]
      : prepared.transaction;
  if (
    !transaction ||
    purpose !== input.purpose ||
    reviewedTransactionDigest(transaction) !== input.transaction_digest
  )
    changed();
  const attempt: MarketSendAttempt = {
    attempt_id: input.attempt_id,
    purpose,
    transaction_digest: input.transaction_digest,
    transaction: {
      ...transaction,
      ...(purpose === 'TRANSACTION' && prepared.gas
        ? { gas: prepared.gas }
        : {})
    },
    snapshot_block: prepared.snapshot.block_number,
    previous_state: row.state,
    status: 'ACTIVE'
  };
  try {
    await marketOperationsDb.transition(row.id, [row.state], 'UNKNOWN', {
      expectedRevision: input.expected_revision,
      requireUnexpiredReview: true,
      sendAttempt: attempt,
      errorCode: 'SEND_ATTEMPTED',
      beforeCommit
    });
  } catch (error) {
    // A lost acknowledgment or competing identical request must not prompt twice.
    const latest = await marketOperationsDb.get(row.id, row.profile_id);
    if (sameAttempt(operationSendAttempt(latest), input)) return latest;
    throw error;
  }
  return marketOperationsDb.get(row.id, row.profile_id);
}

export async function rejectMarketSendAttempt(
  row: MarketOperationRow,
  attemptId: string,
  reason: 'USER_REJECTED' | 'WALLET_NOT_REQUESTED',
  expectedRevision?: string
): Promise<MarketOperationRow> {
  const attempt = operationSendAttempt(row);
  if (!attempt || attempt.attempt_id !== attemptId) {
    if (
      reason !== 'WALLET_NOT_REQUESTED' ||
      !expectedRevision ||
      attempt?.status === 'ACTIVE'
    )
      changed();
    return rejectUnstartedAttempt(row, attemptId, expectedRevision);
  }
  if (attempt.status === 'REJECTED') return row;
  if (attempt.status !== 'ACTIVE' || attempt.transaction_hash) changed();
  try {
    await marketOperationsDb.transition(
      row.id,
      ['UNKNOWN'],
      attempt.previous_state,
      {
        expectedRevision: marketOperationRevision(row),
        expectedAttemptId: attemptId,
        sendAttempt: {
          ...attempt,
          status: 'REJECTED',
          rejection_reason: reason
        },
        // A new wallet prompt requires a fresh continuation, including gas/permissions.
        expiresAt: 0
      }
    );
  } catch (error) {
    const latest = await marketOperationsDb.get(row.id, row.profile_id);
    const saved = operationSendAttempt(latest);
    if (saved?.attempt_id === attemptId && saved.status === 'REJECTED')
      return latest;
    throw error;
  }
  return marketOperationsDb.get(row.id, row.profile_id);
}

/** Fence a lost begin request even when the quote has expired or trading is paused. */
async function rejectUnstartedAttempt(
  row: MarketOperationRow,
  attemptId: string,
  expectedRevision: string
): Promise<MarketOperationRow> {
  const prepared = preparedFrom(row);
  if (!prepared || !['REVIEW', 'APPROVAL'].includes(row.state)) changed();
  const transaction = prepared.approvalTransactions[0] ?? prepared.transaction;
  if (!transaction) changed();
  const attempt: MarketSendAttempt = {
    attempt_id: attemptId,
    purpose: prepared.approvalTransactions.length ? 'APPROVAL' : 'TRANSACTION',
    transaction_digest: reviewedTransactionDigest(transaction),
    transaction,
    snapshot_block: prepared.snapshot.block_number,
    previous_state: row.state,
    status: 'REJECTED',
    rejection_reason: 'WALLET_NOT_REQUESTED'
  };
  try {
    await marketOperationsDb.transition(row.id, [row.state], row.state, {
      expectedRevision,
      sendAttempt: attempt,
      expiresAt: 0
    });
  } catch (error) {
    const latest = await marketOperationsDb.get(row.id, row.profile_id);
    const saved = operationSendAttempt(latest);
    if (saved?.attempt_id === attemptId)
      return rejectMarketSendAttempt(latest, attemptId, 'WALLET_NOT_REQUESTED');
    throw error;
  }
  return marketOperationsDb.get(row.id, row.profile_id);
}

export async function verifyAttemptTransaction(
  row: MarketOperationRow,
  attempt: MarketSendAttempt,
  hash: string
) {
  const tx = await marketChain().rpc.getTransaction(hash);
  if (!tx)
    throw new CustomApiCompliantException(
      409,
      'The transaction is not visible yet. Keep its hash and retry.',
      'SUBMISSION_UNKNOWN'
    );
  if (
    !tx.to ||
    tx.hash.toLowerCase() !== hash.toLowerCase() ||
    tx.chainId !== BigInt(1) ||
    tx.from.toLowerCase() !== row.wallet.toLowerCase() ||
    (tx.blockNumber !== null && tx.blockNumber <= attempt.snapshot_block) ||
    reviewedTransactionDigest({
      ...tx,
      to: tx.to,
      value: tx.value.toString()
    }) !== attempt.transaction_digest
  )
    throw new ForbiddenException(
      'The transaction does not match the recorded wallet request.'
    );
  return tx;
}

export async function submitApprovalAttempt(
  row: MarketOperationRow,
  hash: string
): Promise<void> {
  const attempt = operationSendAttempt(row);
  if (!attempt || attempt.purpose !== 'APPROVAL' || attempt.status !== 'ACTIVE')
    changed();
  if (
    attempt.transaction_hash &&
    attempt.transaction_hash !== hash.toLowerCase()
  )
    changed();
  await verifyAttemptTransaction(row, attempt, hash);
  if (!attempt.transaction_hash) {
    try {
      await marketOperationsDb.transition(row.id, ['UNKNOWN'], 'UNKNOWN', {
        expectedRevision: marketOperationRevision(row),
        expectedAttemptId: attempt.attempt_id,
        sendAttempt: { ...attempt, transaction_hash: hash.toLowerCase() },
        errorCode: 'APPROVAL_SUBMITTED'
      });
    } catch (error) {
      const latest = operationSendAttempt(
        await marketOperationsDb.get(row.id, row.profile_id)
      );
      if (
        latest?.attempt_id !== attempt.attempt_id ||
        latest.transaction_hash !== hash.toLowerCase()
      )
        throw error;
    }
  }
  await reconcileApprovalAttempt(
    await marketOperationsDb.get(row.id, row.profile_id)
  );
}

/** A visible hash alone never releases the fence: canonical receipt + fresh permissions are required. */
export async function reconcileApprovalAttempt(
  row: MarketOperationRow
): Promise<void> {
  const attempt = operationSendAttempt(row);
  if (
    attempt?.status !== 'ACTIVE' ||
    attempt.purpose !== 'APPROVAL' ||
    !attempt.transaction_hash
  )
    return;
  const chain = marketChain(),
    hash = attempt.transaction_hash;
  try {
    await verifyAttemptTransaction(row, attempt, hash);
    const receipt = await chain.rpc.getTransactionReceipt(hash);
    if (
      !receipt ||
      receipt.blockNumber <= attempt.snapshot_block ||
      receipt.hash.toLowerCase() !== hash ||
      ![0, 1].includes(receipt.status ?? -1)
    )
      return;
    const canonical = await chain.rpc.getBlock(receipt.blockNumber);
    if (
      !canonical?.hash ||
      canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      return;
    const prepared = preparedFrom(row);
    if (!prepared || isMarketBatchPrepared(prepared)) return;
    const order = prepared.signedOrder?.order ?? prepared.reviewOrder;
    if (!order) return;
    const approvalTransactions = await chain.approvals(
      prepared.intent,
      order.components.conduitKey
    );
    const freshCanonical = await chain.rpc.getBlock(receipt.blockNumber);
    if (freshCanonical?.hash !== canonical.hash) return;
    await marketOperationsDb.transition(row.id, ['UNKNOWN'], 'REVIEW', {
      expectedRevision: marketOperationRevision(row),
      expectedAttemptId: attempt.attempt_id,
      sendAttempt: { ...attempt, status: 'RESOLVED' },
      prepared: { ...prepared, approvalTransactions },
      expiresAt: 0,
      ...(receipt.status === 0 ? { errorCode: 'APPROVAL_REVERTED' } : {})
    });
  } catch {
    // RPC uncertainty or another reconciler winning cannot permit a resend.
  }
}
