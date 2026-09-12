import { collectingDb } from '@/collecting/collecting.db';
import { simulateMarketBatch } from '@/marketplace/market-batch-simulation';
import { CustomApiCompliantException } from '@/exceptions';
import { MarketBatchPrepareRequest } from '@/marketplace/market-batch.schema';
import { MarketBatchPreparation } from '@/marketplace/market-batch-preparation';
import { batchPreparedMaterials } from '@/marketplace/market-batch-materials';
import {
  withMarketBatchDeadline,
  assertMarketBatchActive
} from '@/marketplace/market-batch-deadline';
import { marketChain } from '@/marketplace/market-chain';
import {
  MarketOperationRow,
  marketOperationsDb
} from '@/marketplace/market-operations.db';
import { MarketValidationError } from '@/marketplace/provider.types';
import { OpenSeaMarketplaceProvider } from '@/marketplace/provider.opensea';
import {
  marketOperationRevision,
  operationSendAttempt,
  reviewedTransactionDigest
} from '@/marketplace/market-operation-state';
import {
  BeginMarketSendAttempt,
  beginMarketSendAttempt
} from '@/marketplace/market-send-attempts';
import { validateMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';
import { isMarketBatchPrepared } from '@/marketplace/market-operation.types';
import {
  operationDto,
  operationPrepared
} from '@/api/marketplace/marketplace.dto';

async function membership(
  request: MarketBatchPrepareRequest
): Promise<string[]> {
  const { account } = await collectingDb.readAccountHoldings(
    request.profile_id
  );
  const wallets = account.wallets.map((wallet) => wallet.toLowerCase());
  if (!wallets.includes(request.wallet.toLowerCase()))
    throw new CustomApiCompliantException(
      409,
      'The paying wallet is no longer in this profile.',
      'RECIPIENT_SCOPE_CHANGED'
    );
  if (
    request.items.some((item) =>
      item.allocations.some(
        (allocation) =>
          !wallets.includes(allocation.recipient.toLowerCase()) &&
          !allocation.acknowledge_external_recipient
      )
    )
  )
    throw new CustomApiCompliantException(
      409,
      'Review every recipient that is now outside this profile.',
      'RECIPIENT_SCOPE_CHANGED'
    );
  return wallets;
}

async function prepare(request: MarketBatchPrepareRequest, wallets: string[]) {
  return withMarketBatchDeadline((signal) =>
    new MarketBatchPreparation(
      new OpenSeaMarketplaceProvider({
        apiKey: process.env.OPENSEA_API_KEY ?? '',
        signal
      }),
      marketChain()
    ).prepare(request, wallets, signal)
  );
}

function journal(prepared: Awaited<ReturnType<typeof prepare>>) {
  return { digest: reviewedTransactionDigest(prepared.transaction), prepared };
}

export async function prepareBatchOperation(
  request: MarketBatchPrepareRequest,
  key: string
) {
  const wallets = await membership(request);
  const created = await marketOperationsDb.create({
    profileId: request.profile_id,
    wallet: request.wallet,
    key,
    request,
    currency: request.currency
  });
  if (!created.created) return operationDto(created.operation);
  try {
    const prepared = await prepare(request, wallets);
    await marketOperationsDb.transition(
      created.operation.id,
      ['PREPARING'],
      'REVIEW',
      {
        prepared,
        reviewedTransaction: journal(prepared),
        expiresAt: prepared.validUntil
      }
    );
  } catch (error) {
    await marketOperationsDb.transition(
      created.operation.id,
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
    await marketOperationsDb.get(created.operation.id, request.profile_id)
  );
}

export async function continueBatchOperation(
  row: MarketOperationRow,
  request: MarketBatchPrepareRequest
) {
  if (row.rule_id || row.state !== 'REVIEW')
    throw new CustomApiCompliantException(
      409,
      'This batch cannot be prepared again in its current state.',
      'OPERATION_CHANGED'
    );
  const wallets = await membership(request);
  const prepared = await prepare(request, wallets);
  await marketOperationsDb.transition(row.id, ['REVIEW'], 'REVIEW', {
    expectedRevision: marketOperationRevision(row),
    prepared,
    reviewedTransaction: journal(prepared),
    expiresAt: prepared.validUntil
  });
  return operationDto(await marketOperationsDb.get(row.id, row.profile_id));
}

export async function beginBatchTransactionAttempt(
  row: MarketOperationRow,
  request: MarketBatchPrepareRequest,
  input: BeginMarketSendAttempt
) {
  if (operationSendAttempt(row)?.status === 'ACTIVE')
    return operationDto(await beginMarketSendAttempt(row, input));
  await membership(request);
  const prepared = operationPrepared(row);
  if (
    row.rule_id ||
    !prepared ||
    !isMarketBatchPrepared(prepared) ||
    row.state !== 'REVIEW' ||
    prepared.validUntil <= Date.now() ||
    Number(row.expires_at) <= Date.now()
  )
    throw new CustomApiCompliantException(
      409,
      'Refresh the complete batch before requesting the wallet.',
      'OPERATION_CHANGED'
    );
  await withMarketBatchDeadline(async (signal) => {
    if ((await marketChain().rpc.getCode(row.wallet)) !== '0x')
      throw new MarketValidationError(
        'UNSUPPORTED_ACTION',
        'This paying wallet is no longer a supported EOA.'
      );
    validateMarketBatchTransaction(
      prepared.intent,
      batchPreparedMaterials(prepared),
      prepared.mirrorTerms,
      prepared.transaction
    );
    assertMarketBatchActive(signal);
    const gas = await simulateMarketBatch(marketChain(), prepared.transaction);
    if (
      BigInt(gas.gas_reserve_wei) > BigInt(prepared.gas.gas_reserve_wei) ||
      BigInt(gas.max_fee_per_gas) > BigInt(prepared.gas.max_fee_per_gas) ||
      BigInt(gas.gas_limit) > BigInt(prepared.gas.gas_limit)
    )
      throw new CustomApiCompliantException(
        409,
        'The required gas increased. Review the complete batch again.',
        'OPERATION_CHANGED'
      );
  });
  return operationDto(await beginMarketSendAttempt(row, input));
}
