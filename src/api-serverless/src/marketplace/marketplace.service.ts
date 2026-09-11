import { AuthenticationContext } from '@/auth-context';
import { z } from 'zod';
import type { ConnectionWrapper } from '@/sql-executor';
import { collectingDb } from '@/collecting/collecting.db';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { marketChain } from '@/marketplace/market-chain';
import {
  marketOperationsDb,
  marketRequestHash,
  MarketOperationRow
} from '@/marketplace/market-operations.db';
import {
  MarketPreparation,
  MarketPrepared,
  MarketPrepareRequest
} from '@/marketplace/market-preparation';
import { OpenSeaMarketplaceProvider } from '@/marketplace/provider.opensea';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from '@/marketplace/market-operation-state';
import {
  BeginMarketSendAttempt,
  beginMarketSendAttempt,
  rejectMarketSendAttempt,
  reconcileApprovalAttempt,
  submitApprovalAttempt,
  verifyAttemptTransaction
} from '@/marketplace/market-send-attempts';
import { reconcileMarketOperation } from '@/marketplace/market-reconciliation';
import {
  operationDto,
  operationPrepared,
  operationRequest
} from './marketplace.dto';

export function marketplaceProvider() {
  return new OpenSeaMarketplaceProvider({
    apiKey: process.env.OPENSEA_API_KEY ?? ''
  });
}

function reviewedTransactionPatch(prepared: MarketPrepared) {
  return prepared.transaction && !prepared.approvalTransactions.length
    ? {
        reviewedTransaction: {
          digest: reviewedTransactionDigest(prepared.transaction),
          prepared
        }
      }
    : {};
}

async function ruleContinuationPatch(
  row: MarketOperationRow,
  request: MarketPrepareRequest,
  prepared: MarketPrepared
) {
  if (!row.rule_id) return {};
  const rule = await collectingRulesService.get(row.rule_id, row.profile_id);
  if (!prepared.gas)
    throw new CustomApiCompliantException(
      409,
      'This rule requires a verified purchase gas estimate.',
      'RULE_GAS_UNAVAILABLE'
    );
  const review = {
    quote_id: marketRequestHash(prepared),
    profile_id: row.profile_id,
    funding_wallet: row.wallet,
    recipient: prepared.intent.recipient,
    valid_until: Math.min(Date.now() + 20000, rule.definition.expires_at),
    assets: [
      {
        asset_key: request.asset_key,
        quantity: prepared.intent.quantity,
        unit_price_wei: (
          BigInt(prepared.intent.maxTotalWei) / BigInt(prepared.intent.quantity)
        ).toString()
      }
    ],
    item_cost_wei: prepared.intent.maxTotalWei,
    gas_reserve_wei: prepared.gas.gas_reserve_wei
  };
  return {
    beforeCommit: (connection: ConnectionWrapper<unknown>) =>
      collectingRulesService.assertOperationContinuation(
        row.id,
        review,
        connection
      )
  };
}
export function assertMarketActor(
  auth: AuthenticationContext,
  request?: MarketPrepareRequest
) {
  if (
    !auth.authenticatedWallet ||
    !auth.authenticatedProfileId ||
    auth.isAuthenticatedAsProxy()
  )
    throw new ForbiddenException(
      'Connect the signing wallet directly to manage trades.'
    );
  if (
    request &&
    (request.wallet.toLowerCase() !== auth.authenticatedWallet.toLowerCase() ||
      request.profile_id !== auth.authenticatedProfileId)
  )
    throw new ForbiddenException(
      'The trade must be authorized by its paying or signing wallet.'
    );
  return {
    profileId: auth.authenticatedProfileId,
    wallet: auth.authenticatedWallet.toLowerCase()
  };
}
export function assertMarketEnabled(cancel = false) {
  if (
    !cancel &&
    (!process.env.OPENSEA_API_KEY ||
      (process.env.MARKETPLACE_TRADING_ENABLED ?? 'true') !== 'true')
  )
    throw new CustomApiCompliantException(
      503,
      'Trading is currently unavailable. Your existing orders remain visible.',
      'TRADING_UNAVAILABLE'
    );
}
async function ownedOperation(id: string, auth: AuthenticationContext) {
  const actor = assertMarketActor(auth);
  const row = await marketOperationsDb.getForActor(
    id,
    actor.profileId,
    actor.wallet
  );
  if (row.wallet !== actor.wallet)
    throw new ForbiddenException(
      'Switch to the wallet that created this trade.'
    );
  return row;
}
async function recipientMembership(request: MarketPrepareRequest) {
  const scope = await collectingDb.readAccountHoldings(request.profile_id);
  if (!scope.account.wallets.includes(request.wallet.toLowerCase()))
    throw new ForbiddenException(
      'The paying wallet is no longer in this profile.'
    );
  return scope.account.wallets.includes(request.recipient.toLowerCase());
}

async function knownCancellationOrder(
  request: MarketPrepareRequest,
  previous?: MarketPrepared
) {
  if (request.kind !== 'CANCEL' || !request.order) return undefined;
  const row = previous
    ? undefined
    : await marketOperationsDb.findOrder(
        request.wallet,
        request.order.order_hash
      );
  const prepared = previous ?? (row ? operationPrepared(row) : undefined);
  const order = prepared?.signedOrder?.order ?? prepared?.reviewOrder;
  return order
    ? {
        identity: {
          protocolAddress: order.protocolAddress,
          orderHash: order.orderHash
        },
        components: order.components
      }
    : undefined;
}

export async function prepareMarketOperation(
  auth: AuthenticationContext,
  request: MarketPrepareRequest,
  key: string,
  context?: {
    ruleId: string;
    beforeExpose: (
      operationId: string,
      prepared: MarketPrepared,
      connection: ConnectionWrapper<unknown>
    ) => Promise<void>;
  }
) {
  assertMarketActor(auth, request);
  assertMarketEnabled(request.kind === 'CANCEL');
  const recipientInProfile = await recipientMembership(request);
  const result = await marketOperationsDb.create({
    profileId: request.profile_id,
    wallet: request.wallet,
    key,
    request,
    currency: request.currency,
    ...(context ? { ruleId: context.ruleId } : {})
  });
  if (!result.created) return operationDto(result.operation);
  try {
    const prepared = await new MarketPreparation(
      marketplaceProvider(),
      marketChain()
    ).prepare(
      request,
      recipientInProfile,
      await knownCancellationOrder(request)
    );
    await marketOperationsDb.transition(
      result.operation.id,
      ['PREPARING'],
      'REVIEW',
      {
        prepared,
        ...(context
          ? {
              beforeCommit: (connection: ConnectionWrapper<unknown>) =>
                context.beforeExpose(result.operation.id, prepared, connection)
            }
          : {}),
        ...reviewedTransactionPatch(prepared),
        expiresAt: Date.now() + 20000,
        orderHash: prepared.signedOrder?.order.orderHash,
        ...(request.kind === 'OFFER'
          ? {
              liabilityWei: prepared.intent.maxTotalWei,
              fundingBalanceWei: await marketChain().currencyBalance(
                request.currency,
                request.wallet
              )
            }
          : {})
      }
    );
  } catch (error) {
    await marketOperationsDb.transition(
      result.operation.id,
      ['PREPARING'],
      'FAILED',
      {
        errorCode:
          error instanceof MarketValidationError
            ? error.code
            : 'PREPARATION_FAILED'
      }
    );
    throw error;
  }
  return operationDto(
    await marketOperationsDb.get(result.operation.id, request.profile_id)
  );
}

export async function continueMarketOperation(
  id: string,
  auth: AuthenticationContext
) {
  const row = await ownedOperation(id, auth),
    request = operationRequest(row);
  assertMarketActor(auth, request);
  assertMarketEnabled(request.kind === 'CANCEL');
  if (!['REVIEW', 'APPROVAL', 'AWAITING_SIGNATURE'].includes(row.state))
    throw new CustomApiCompliantException(
      409,
      'Refresh this trade before continuing.',
      'OPERATION_CHANGED'
    );
  const previous = operationPrepared(row);
  if (!previous)
    throw new CustomApiCompliantException(
      409,
      'The trade is not ready.',
      'OPERATION_CHANGED'
    );
  const recipientInProfile = await recipientMembership(request);
  if (!recipientInProfile && !request.acknowledge_external_recipient)
    throw new CustomApiCompliantException(
      409,
      'The recipient has left this profile. Review it as a third-party recipient before continuing.',
      'RECIPIENT_SCOPE_CHANGED'
    );
  let prepared: MarketPrepared;
  if (previous.signedOrder) {
    if ((await marketChain().rpc.getCode(request.wallet)) !== '0x')
      throw new CustomApiCompliantException(
        409,
        'Trading from this smart wallet is not available yet.',
        'UNSUPPORTED_ACTION'
      );
    const snapshot = await marketChain().snapshot();
    if (
      Number(previous.signedOrder.order.components.endTime) <=
      snapshot.block_timestamp
    )
      throw new CustomApiCompliantException(
        409,
        'The order has expired.',
        'ORDER_EXPIRED'
      );
    if (
      previous.signedOrder.order.components.counter !==
      (await marketChain().counter(request.wallet))
    )
      throw new CustomApiCompliantException(
        409,
        'The maker counter changed.',
        'ORDER_CHANGED'
      );
    const approvalTransactions = await marketChain().approvals(
      previous.intent,
      previous.signedOrder.order.components.conduitKey
    );
    prepared = {
      ...previous,
      recipientInProfile,
      snapshot,
      approvalTransactions
    };
  } else {
    prepared = await new MarketPreparation(
      marketplaceProvider(),
      marketChain()
    ).prepare(
      request,
      recipientInProfile,
      await knownCancellationOrder(request, previous)
    );
  }
  let next: MarketOperationRow['state'] = 'REVIEW';
  if (prepared.approvalTransactions.length) next = 'APPROVAL';
  else if (prepared.signedOrder) next = 'AWAITING_SIGNATURE';
  // A signature can leave the browser even if publication is never acknowledged.
  // Keep potential offer exposure until effective chain expiry/cancellation/fill.
  await marketOperationsDb.transition(
    id,
    ['REVIEW', 'APPROVAL', 'AWAITING_SIGNATURE'],
    next,
    {
      expectedRevision: marketOperationRevision(row),
      prepared,
      ...reviewedTransactionPatch(prepared),
      ...(await ruleContinuationPatch(row, request, prepared)),
      expiresAt: Date.now() + 20000
    }
  );
  return operationDto(await marketOperationsDb.get(id, request.profile_id));
}

export async function publishMarketOperation(
  id: string,
  auth: AuthenticationContext,
  signature: string
) {
  const row = await ownedOperation(id, auth),
    request = operationRequest(row);
  assertMarketActor(auth, request);
  assertMarketEnabled();
  if (
    row.state === 'LIVE' ||
    row.state === 'PUBLISHING' ||
    row.state === 'UNKNOWN'
  )
    return operationDto(row);
  if (row.state !== 'AWAITING_SIGNATURE')
    throw new CustomApiCompliantException(
      409,
      'Review this order before signing.',
      'OPERATION_CHANGED'
    );
  const prepared = operationPrepared(row);
  if (!prepared?.signedOrder)
    throw new CustomApiCompliantException(
      409,
      'No order is ready for signing.',
      'OPERATION_CHANGED'
    );
  await marketOperationsDb.transition(
    id,
    ['AWAITING_SIGNATURE'],
    'PUBLISHING',
    { orderHash: prepared.signedOrder.order.orderHash }
  );
  try {
    await marketplaceProvider().publishOrder(
      prepared.intent,
      prepared.signedOrder.order,
      signature
    );
    await marketOperationsDb.transition(id, ['PUBLISHING'], 'LIVE');
  } catch {
    await marketOperationsDb.transition(id, ['PUBLISHING'], 'UNKNOWN', {
      errorCode: 'PUBLICATION_UNKNOWN'
    });
  }
  return operationDto(await marketOperationsDb.get(id, request.profile_id));
}

export async function beginMarketTransactionAttempt(
  id: string,
  auth: AuthenticationContext,
  input: BeginMarketSendAttempt
) {
  const row = await ownedOperation(id, auth),
    request = operationRequest(row);
  assertMarketActor(auth, request);
  assertMarketEnabled(request.kind === 'CANCEL');
  const recipientInProfile = await recipientMembership(request);
  if (!recipientInProfile && !request.acknowledge_external_recipient)
    throw new CustomApiCompliantException(
      409,
      'Review the changed recipient profile before requesting the wallet.',
      'RECIPIENT_SCOPE_CHANGED'
    );
  const prepared = operationPrepared(row);
  const guard = prepared
    ? await ruleContinuationPatch(row, request, prepared)
    : {};
  return operationDto(
    await beginMarketSendAttempt(row, input, guard.beforeCommit)
  );
}

export async function rejectMarketTransactionAttempt(
  id: string,
  auth: AuthenticationContext,
  attemptId: string,
  reason: 'USER_REJECTED' | 'WALLET_NOT_REQUESTED',
  expectedRevision?: string
) {
  return operationDto(
    await rejectMarketSendAttempt(
      await ownedOperation(id, auth),
      attemptId,
      reason,
      expectedRevision
    )
  );
}

export async function readMarketOperation(
  id: string,
  auth: AuthenticationContext
) {
  const actor = assertMarketActor(auth);
  let row = await marketOperationsDb.getForActor(
    id,
    actor.profileId,
    actor.wallet
  );
  if (Number(row.updated_at) < Date.now() - 60000) {
    if (row.state === 'PREPARING' && !row.prepared_json) {
      await marketOperationsDb.transition(id, ['PREPARING'], 'FAILED', {
        errorCode: 'PREPARATION_INTERRUPTED'
      });
      row = await marketOperationsDb.get(id, row.profile_id);
    } else if (row.state === 'PUBLISHING') {
      await marketOperationsDb.transition(id, ['PUBLISHING'], 'UNKNOWN', {
        errorCode: 'PUBLICATION_UNKNOWN'
      });
      row = await marketOperationsDb.get(id, row.profile_id);
    }
  }
  if (operationSendAttempt(row)?.status === 'ACTIVE') {
    await reconcileApprovalAttempt(row);
  } else await reconcileMarketOperation(row);
  return operationDto(await marketOperationsDb.get(id, row.profile_id));
}
export async function listMarketOperations(
  auth: AuthenticationContext,
  options?: { limit: number; cursor?: string }
) {
  const actor = assertMarketActor(auth);
  const limit = options?.limit ?? 20;
  const cursor = options?.cursor;
  let before: { created_at: number; id: string } | undefined;
  if (cursor) {
    try {
      before = z
        .object({
          created_at: z.number().int().nonnegative(),
          id: z.string().uuid()
        })
        .strict()
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
      throw new CustomApiCompliantException(
        400,
        'Invalid order history cursor.'
      );
    }
  }
  const rows = await marketOperationsDb.page(
    actor.profileId,
    limit,
    before,
    actor.wallet
  );
  const shown = rows.slice(0, limit),
    last = shown.at(-1);
  return {
    operations: shown.map(operationDto),
    next:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ created_at: Number(last.created_at), id: last.id })
          ).toString('base64url')
        : null
  };
}

export async function submitMarketOperation(
  id: string,
  auth: AuthenticationContext,
  transactionHash: string
) {
  const row = await ownedOperation(id, auth);
  const attempt = operationSendAttempt(row);
  if (
    attempt?.purpose === 'APPROVAL' &&
    attempt.status === 'RESOLVED' &&
    attempt.transaction_hash === transactionHash.toLowerCase()
  )
    return operationDto(row);
  if (attempt?.status === 'ACTIVE' && attempt.purpose === 'APPROVAL') {
    await submitApprovalAttempt(row, transactionHash);
    return operationDto(await marketOperationsDb.get(id, row.profile_id));
  }
  if (
    row.transaction_hash === transactionHash.toLowerCase() &&
    ['SUBMITTED', 'MINED', 'CONFIRMED', 'UNKNOWN'].includes(row.state)
  )
    return operationDto(row);
  if (
    !['REVIEW', 'APPROVAL'].includes(row.state) &&
    !(
      row.state === 'UNKNOWN' &&
      attempt?.status === 'ACTIVE' &&
      attempt.purpose === 'TRANSACTION'
    )
  )
    throw new CustomApiCompliantException(
      409,
      'This trade cannot accept a new transaction.',
      'OPERATION_CHANGED'
    );
  const prepared = await assertSubmittedTransaction(row, transactionHash);
  if (attempt?.status === 'ACTIVE')
    await verifyAttemptTransaction(row, attempt, transactionHash);
  await marketOperationsDb.transition(
    id,
    ['REVIEW', 'APPROVAL', 'UNKNOWN'],
    'SUBMITTED',
    {
      transactionHash,
      prepared,
      expectedRevision: marketOperationRevision(row),
      ...(attempt?.status === 'ACTIVE'
        ? {
            expectedAttemptId: attempt.attempt_id,
            sendAttempt: {
              ...attempt,
              status: 'RESOLVED',
              transaction_hash: transactionHash.toLowerCase()
            }
          }
        : {})
    }
  );
  return operationDto(await marketOperationsDb.get(id, row.profile_id));
}

async function assertSubmittedTransaction(
  row: MarketOperationRow,
  hash: string
) {
  const tx = await marketChain().rpc.getTransaction(hash);
  if (!tx)
    throw new CustomApiCompliantException(
      409,
      'The transaction is not visible yet. Keep this hash and retry reconciliation.',
      'SUBMISSION_UNKNOWN'
    );
  if (!tx.to)
    throw new ForbiddenException('The transaction does not match this trade.');
  const saved = await marketOperationsDb.reviewedTransaction(
    row.id,
    reviewedTransactionDigest({ ...tx, to: tx.to, value: tx.value.toString() })
  );
  const prepared = saved
    ? operationPrepared({ ...row, prepared_json: saved })
    : undefined;
  if (!prepared?.transaction || prepared.approvalTransactions.length)
    throw new ForbiddenException(
      'The transaction does not match a reviewed trade.'
    );
  const expected = prepared.transaction;
  if (
    tx.chainId !== BigInt(1) ||
    (tx.blockNumber !== null &&
      tx.blockNumber <= prepared.snapshot.block_number) ||
    tx.from.toLowerCase() !== row.wallet ||
    tx.to?.toLowerCase() !== expected.to.toLowerCase() ||
    tx.data.toLowerCase() !== expected.data.toLowerCase() ||
    tx.value !== BigInt(expected.value)
  )
    throw new ForbiddenException(
      'The transaction does not match the reviewed trade.'
    );
  return prepared;
}
