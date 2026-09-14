import { AuthenticationContext } from '@/auth-context';
import { ApiMarketBatchPreflight } from '@/api/generated/models/ApiMarketBatchPreflight';
import { ApiMarketBatchPreflightRequest } from '@/api/generated/models/ApiMarketBatchPreflightRequest';
import { collectingDb } from '@/collecting/collecting.db';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { batchPreparedMaterials } from '@/marketplace/market-batch-materials';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { MarketBatchPrepareRequest } from '@/marketplace/market-batch.schema';
import {
  marketGasFitsEnvelope,
  sameMarketGas
} from '@/marketplace/market-gas-envelope';
import { withBatchPreflightLimit } from '@/marketplace/market-batch-preflight-limit';
import { simulateStoredMarketBatch } from '@/marketplace/market-batch-preflight-rpc';
import { isMarketBatchPrepared } from '@/marketplace/market-operation.types';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from '@/marketplace/market-operation-state';
import {
  marketOperationsDb,
  MarketOperationRow,
  marketRequestHash
} from '@/marketplace/market-operations.db';
import { validateMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';
import { operationPrepared, operationRequest } from './marketplace.dto';
import { assertMarketActor, assertMarketEnabled } from './marketplace.service';

function changed(): never {
  throw new CustomApiCompliantException(
    409,
    'The batch review changed. Review the complete batch again.',
    'OPERATION_CHANGED'
  );
}

function fresh(value: unknown) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > Date.now();
}

function sameRequest(
  prepared: MarketBatchPrepared,
  request: MarketBatchPrepareRequest
) {
  const intent = prepared.intent;
  return (
    intent.wallet.toLowerCase() === request.wallet &&
    intent.currency === request.currency &&
    intent.executionPolicy === request.execution_policy &&
    intent.totalWei === request.amount_wei &&
    intent.items.length === request.items.length &&
    intent.items.every((line, index) => {
      const item = request.items[index];
      return (
        line.assetKey === item.asset_key &&
        line.intent.quantity === item.quantity &&
        line.intent.maxTotalWei === item.amount_wei &&
        line.intent.order?.orderHash === item.order.order_hash &&
        line.intent.order.protocolAddress === item.order.protocol_address &&
        line.allocations.length === item.allocations.length &&
        line.allocations.every((allocation, offset) => {
          const expected = item.allocations[offset];
          return (
            allocation.recipient.toLowerCase() === expected.recipient &&
            allocation.quantity === expected.quantity &&
            allocation.acknowledgeExternalRecipient ===
              expected.acknowledge_external_recipient
          );
        })
      );
    })
  );
}

function validateReview(
  row: MarketOperationRow,
  auth: AuthenticationContext,
  input: ApiMarketBatchPreflightRequest
) {
  const request = operationRequest(row);
  const actor = assertMarketActor(auth, request);
  if (
    row.profile_id !== actor.profileId ||
    row.wallet.toLowerCase() !== actor.wallet
  )
    throw new ForbiddenException(
      'Switch to the wallet and profile that created this trade.'
    );
  const prepared = operationPrepared(row);
  const attempt = operationSendAttempt(row);
  // A positively rejected pre-wallet attempt may be retried. Active/resolved
  // attempts or any known hash must take the existing recovery path instead.
  if (
    row.rule_id ||
    request.kind !== 'BUY_BATCH' ||
    !prepared ||
    !isMarketBatchPrepared(prepared) ||
    row.state !== 'REVIEW' ||
    row.transaction_hash ||
    prepared.settlement ||
    (attempt && (attempt.status !== 'REJECTED' || attempt.transaction_hash)) ||
    !fresh(row.expires_at) ||
    !fresh(prepared.validUntil) ||
    marketOperationRevision(row) !== input.expected_revision ||
    marketRequestHash(request) !== row.request_hash ||
    reviewedTransactionDigest(prepared.transaction) !==
      input.transaction_digest ||
    !sameRequest(prepared, request)
  )
    changed();
  return { request, prepared };
}

async function assertMembership(request: MarketBatchPrepareRequest) {
  const { account } = await collectingDb.readAccountHoldings(
    request.profile_id
  );
  const wallets = new Set(
    account.wallets.map((wallet) => wallet.toLowerCase())
  );
  if (
    !wallets.has(request.wallet) ||
    request.items.some((item) =>
      item.allocations.some(
        (allocation) =>
          !wallets.has(allocation.recipient) &&
          !allocation.acknowledge_external_recipient
      )
    )
  )
    throw new CustomApiCompliantException(
      409,
      'Review the paying wallet and recipients in your current profile.',
      'RECIPIENT_SCOPE_CHANGED'
    );
}

export async function preflightMarketBatch(
  id: string,
  auth: AuthenticationContext,
  input: ApiMarketBatchPreflightRequest
): Promise<ApiMarketBatchPreflight> {
  const actor = assertMarketActor(auth);
  assertMarketEnabled();
  const read = async () => {
    const row = await marketOperationsDb.getForActor(
      id,
      actor.profileId,
      actor.wallet
    );
    if (row.id !== id) changed();
    return validateReview(row, auth, input);
  };
  // The distributed lease also bounds expensive decoding and profile checks.
  return withBatchPreflightLimit(
    `${actor.profileId}:${actor.wallet}`,
    id,
    async (signal) => {
      const initial = await read();
      signal.throwIfAborted();
      await assertMembership(initial.request);
      signal.throwIfAborted();
      const { prepared } = await read();
      signal.throwIfAborted();
      validateMarketBatchTransaction(
        prepared.intent,
        batchPreparedMaterials(prepared),
        prepared.mirrorTerms,
        prepared.transaction
      );
      if (
        prepared.approvalTransactions.length ||
        (prepared.transaction.gas !== undefined &&
          !sameMarketGas(prepared.gas, prepared.transaction.gas)) ||
        !marketGasFitsEnvelope(BigInt(1), BigInt(0), prepared.gas)
      )
        changed();
      const result = await simulateStoredMarketBatch(prepared, signal);
      signal.throwIfAborted();
      // Do not mutate/reconcile the operation here. Any concurrent continue,
      // recipient change, send, profile change or expired review invalidates it.
      await assertMembership(initial.request);
      signal.throwIfAborted();
      await read();
      signal.throwIfAborted();
      assertMarketEnabled();
      // The last membership/read awaits can cross the 120-second freshness
      // boundary for a block that was already near it when simulation finished.
      if (
        Date.now() - result.block_timestamp * 1000 > 120_000 ||
        result.block_timestamp * 1000 - Date.now() > 30_000
      )
        changed();
      return {
        operation_id: id,
        revision: input.expected_revision,
        transaction_digest: input.transaction_digest,
        ...result
      };
    }
  );
}
