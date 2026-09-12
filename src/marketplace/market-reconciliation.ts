import { Interface } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import type { MarketPrepared } from '@/marketplace/market-preparation';
import type {
  MarketOperationRow,
  MarketOperationState,
  MarketOperationsDb
} from '@/marketplace/market-operations.db';
import { MarketValidationError } from '@/marketplace/provider.types';
import {
  validateMarketOrder,
  sameMarketAddress
} from '@/marketplace/quote-validation';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import {
  decodeMarketOrderFulfilled,
  MARKET_SEAPORT_EVENTS
} from '@/marketplace/seaport.events';
import {
  marketOrderComponentsSchema,
  parseMarketValue
} from '@/marketplace/seaport.schema';
import { prepareMarketCancel } from '@/marketplace/seaport.builder';
import { operationSendAttempt } from './market-operation-state';
import { CustomApiCompliantException } from '@/exceptions';
import {
  MarketOperationPrepared,
  isMarketBatchPrepared
} from '@/marketplace/market-operation.types';
import { MarketBatchSettlement } from '@/marketplace/market-batch.types';
import { validateMarketBatchReceipt } from '@/marketplace/market-batch-receipt';

export interface MarketSettlement {
  filledQuantity: string;
  remainingQuantity: string;
  transactionHash?: string;
  blockNumber?: number;
  blockHash?: string;
  safeBlockNumber?: number;
}
interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}
export interface MarketReceiptEvidence {
  hash: string;
  blockNumber: number;
  blockHash: string;
  status: number | null;
  logs: readonly ReceiptLog[];
}
export interface MarketTransactionEvidence {
  hash: string;
  from: string;
  to: string | null;
  data: string;
  value: bigint;
  chainId: bigint;
}
export interface MarketReconcileDependencies {
  rpc: Pick<
    JsonRpcProvider,
    'getTransaction' | 'getTransactionReceipt' | 'getBlock' | 'call'
  >;
  transition: MarketOperationsDb['transition'];
}
const nftEvents = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);
const seaportState = new Interface([
  'function getCounter(address) view returns (uint256)',
  'function getOrderStatus(bytes32) view returns (bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)'
]);
const signedStates: MarketOperationState[] = [
  'REVIEW',
  'APPROVAL',
  'AWAITING_SIGNATURE',
  'PUBLISHING',
  'LIVE',
  'UNKNOWN',
  'CANCEL_PENDING'
];
const submittedStates: MarketOperationState[] = [
  'SUBMITTED',
  'MINED',
  'UNKNOWN',
  'CANCEL_PENDING'
];
function mismatch(message: string): never {
  throw new MarketValidationError('ORDER_MISMATCH', message);
}

function exactNftTransfer(
  prepared: MarketPrepared,
  logs: readonly ReceiptLog[]
): void {
  const i = prepared.intent,
    c = prepared.reviewOrder!.components;
  const from = i.kind === 'BUY' ? c.offerer : i.wallet;
  const to = i.kind === 'BUY' ? i.recipient : c.consideration[0].recipient;
  let transferred = BigInt(0);
  for (const log of logs) {
    if (!sameMarketAddress(log.address, i.asset.contract)) continue;
    let event;
    try {
      event = nftEvents.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (
      !event ||
      !sameMarketAddress(String(event.args.from), from) ||
      !sameMarketAddress(String(event.args.to), to)
    )
      continue;
    if (
      i.asset.standard === 'ERC721' &&
      event.name === 'Transfer' &&
      event.args.tokenId.toString() === i.asset.tokenId
    )
      transferred += BigInt(1);
    if (
      i.asset.standard === 'ERC1155' &&
      event.name === 'TransferSingle' &&
      event.args.id.toString() === i.asset.tokenId
    )
      transferred += BigInt(event.args.value);
    if (i.asset.standard === 'ERC1155' && event.name === 'TransferBatch') {
      const ids = event.args.ids as bigint[],
        values = event.args[4] as bigint[];
      ids.forEach((id, index) => {
        if (id.toString() === i.asset.tokenId) transferred += values[index];
      });
    }
  }
  if (transferred !== BigInt(i.quantity))
    mismatch(
      'The receipt does not prove delivery of the exact NFT quantity to its reviewed destination.'
    );
}

/** Pure validation; canonical-block and safe-block checks belong to the reconciler. */
export function validateMarketReceipt(
  prepared: MarketPrepared,
  kind: string,
  transaction: MarketTransactionEvidence,
  receipt: MarketReceiptEvidence
): MarketSettlement {
  if (receipt.blockNumber <= prepared.snapshot.block_number)
    mismatch('The receipt predates the immutable preparation snapshot.');
  const expected = prepared.transaction;
  if (!expected || !prepared.reviewOrder)
    mismatch('The operation has no immutable transaction review.');
  if (
    transaction.chainId !== BigInt(1) ||
    !sameMarketAddress(transaction.hash, receipt.hash) ||
    !sameMarketAddress(transaction.from, expected.from) ||
    !transaction.to ||
    !sameMarketAddress(transaction.to, expected.to) ||
    transaction.data.toLowerCase() !== expected.data.toLowerCase() ||
    transaction.value !== BigInt(expected.value)
  )
    mismatch(
      'The submitted transaction differs from the reviewed transaction.'
    );
  if (receipt.status !== 1) mismatch('The transaction did not succeed.');
  const reviewed = prepared.reviewOrder;
  if (kind === 'CANCEL') {
    const c = parseMarketValue(
      marketOrderComponentsSchema,
      reviewed.components
    );
    const rebuilt = prepareMarketCancel(
      expected.from,
      {
        protocolAddress: reviewed.protocolAddress,
        orderHash: reviewed.orderHash
      },
      c
    );
    if (rebuilt.data.toLowerCase() !== expected.data.toLowerCase())
      mismatch('The cancellation review changed.');
    const matches = receipt.logs.filter((log) => {
      if (!sameMarketAddress(log.address, MARKET_SEAPORT)) return false;
      try {
        const event = MARKET_SEAPORT_EVENTS.decodeEventLog(
          'OrderCancelled',
          log.data,
          [...log.topics]
        );
        return (
          sameMarketAddress(event.orderHash, reviewed.orderHash) &&
          sameMarketAddress(event.offerer, c.offerer) &&
          sameMarketAddress(event.zone, c.zone)
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      mismatch(
        'The receipt does not prove cancellation of the reviewed order.'
      );
    return {
      filledQuantity: '0',
      remainingQuantity: prepared.intent.quantity,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash
    };
  }
  if (kind !== 'BUY' && kind !== 'ACCEPT')
    mismatch('This operation cannot settle through a fulfillment transaction.');
  const checked = validateMarketOrder(
    prepared.intent,
    reviewed.components,
    reviewed.protocolAddress
  );
  if (checked.orderHash !== reviewed.orderHash)
    mismatch('The immutable order review changed.');
  const c = checked.components;
  const events = receipt.logs
    .filter((log) => sameMarketAddress(log.address, MARKET_SEAPORT))
    .flatMap((log) => {
      try {
        const event = decodeMarketOrderFulfilled(log);
        return sameMarketAddress(event.orderHash, checked.orderHash)
          ? [event]
          : [];
      } catch {
        return [];
      }
    });
  if (events.length !== 1)
    mismatch('The receipt does not contain exactly one expected order fill.');
  const event = events[0],
    quantity = BigInt(prepared.intent.quantity);
  const original = BigInt(
    kind === 'BUY' ? c.offer[0].startAmount : c.consideration[0].startAmount
  );
  const scale = (amount: string) => {
    const n = BigInt(amount) * quantity;
    if (n % original !== BigInt(0)) mismatch('The fill fraction is not exact.');
    return (n / original).toString();
  };
  const offer = c.offer.map((item) => ({
    itemType: item.itemType,
    token: item.token.toLowerCase(),
    tokenId: item.identifierOrCriteria,
    amount: scale(item.startAmount)
  }));
  const consideration = c.consideration.map((item) => ({
    itemType: item.itemType,
    token: item.token.toLowerCase(),
    tokenId: item.identifierOrCriteria,
    amount: scale(item.startAmount),
    recipient: item.recipient.toLowerCase()
  }));
  if (
    !sameMarketAddress(event.offerer, c.offerer) ||
    !sameMarketAddress(event.zone, c.zone) ||
    !sameMarketAddress(event.recipient, prepared.intent.recipient) ||
    JSON.stringify(event.offer) !== JSON.stringify(offer) ||
    JSON.stringify(event.consideration) !== JSON.stringify(consideration)
  )
    mismatch(
      'The actual token or payment flows differ from the reviewed fill.'
    );
  exactNftTransfer(prepared, receipt.logs);
  return {
    filledQuantity: prepared.intent.quantity,
    remainingQuantity: '0',
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash
  };
}

function preparedFrom(row: MarketOperationRow): MarketOperationPrepared | null {
  let value = row.prepared_json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || !('intent' in value)) return null;
  return value as MarketOperationPrepared;
}
function kindFrom(row: MarketOperationRow): string | null {
  let value = row.request_json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof value.kind === 'string'
    ? value.kind
    : null;
}
async function persist(
  row: MarketOperationRow,
  deps: MarketReconcileDependencies,
  state: MarketOperationState,
  patch: Parameters<MarketOperationsDb['transition']>[3] = {}
): Promise<void> {
  if (
    state === row.state &&
    patch.prepared === undefined &&
    patch.liabilityWei === undefined &&
    patch.errorCode === undefined
  )
    return;
  await deps.transition(row.id, [row.state], state, patch);
}

async function reconcileSubmitted(
  row: MarketOperationRow,
  prepared: MarketOperationPrepared,
  kind: string,
  deps: MarketReconcileDependencies
): Promise<void> {
  const hash = row.transaction_hash!;
  const [transaction, receipt, safe] = await Promise.all([
    deps.rpc.getTransaction(hash),
    deps.rpc.getTransactionReceipt(hash),
    deps.rpc.getBlock('safe')
  ]);
  if (!transaction || !receipt) {
    return persist(
      row,
      deps,
      transaction && row.state !== 'MINED' ? 'SUBMITTED' : 'UNKNOWN'
    );
  }
  if (
    !sameMarketAddress(transaction.hash, hash) ||
    !sameMarketAddress(receipt.hash, hash)
  )
    return persist(row, deps, 'UNKNOWN', { errorCode: 'TRANSACTION_MISMATCH' });
  const canonical = await deps.rpc.getBlock(receipt.blockNumber);
  if (!canonical?.hash || !sameMarketAddress(canonical.hash, receipt.blockHash))
    return persist(row, deps, 'UNKNOWN', { errorCode: 'RECEIPT_REORG' });
  const safeIncluded = !!safe && safe.number >= receipt.blockNumber;
  // A failed transaction is only terminal once its canonical block is safe.
  if (receipt.status === 0) {
    const expected = prepared.transaction;
    if (
      !expected ||
      !transaction.to ||
      transaction.chainId !== BigInt(1) ||
      !sameMarketAddress(transaction.from, expected.from) ||
      !sameMarketAddress(transaction.to, expected.to) ||
      transaction.data.toLowerCase() !== expected.data.toLowerCase() ||
      transaction.value !== BigInt(expected.value)
    )
      return persist(row, deps, 'UNKNOWN', {
        errorCode: 'TRANSACTION_MISMATCH'
      });
    if (receipt.blockNumber <= prepared.snapshot.block_number)
      return persist(row, deps, 'UNKNOWN', {
        errorCode: 'TRANSACTION_PREDATES_REVIEW'
      });
    return persist(row, deps, safeIncluded ? 'FAILED' : 'MINED', {
      errorCode: 'TRANSACTION_REVERTED',
      ...(safeIncluded ? { liabilityWei: '0' } : {})
    });
  }
  let settlement: MarketSettlement | MarketBatchSettlement;
  try {
    if (isMarketBatchPrepared(prepared)) {
      if (kind !== 'BUY_BATCH')
        mismatch('The operation kind does not match its batch review.');
      settlement = validateMarketBatchReceipt(prepared, transaction, receipt);
    } else
      settlement = validateMarketReceipt(prepared, kind, transaction, receipt);
  } catch {
    return persist(row, deps, 'UNKNOWN', { errorCode: 'SETTLEMENT_MISMATCH' });
  }
  if (safeIncluded) settlement.safeBlockNumber = safe!.number;
  return persist(
    row,
    deps,
    safeIncluded ? (kind === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED') : 'MINED',
    {
      prepared: { ...prepared, settlement },
      ...(safeIncluded ? { liabilityWei: '0' } : {})
    }
  );
}

async function reconcileSigned(
  row: MarketOperationRow,
  prepared: MarketPrepared,
  deps: MarketReconcileDependencies
): Promise<void> {
  const signed = prepared.signedOrder?.order;
  if (!signed || !['LIST', 'OFFER'].includes(prepared.intent.kind)) return;
  const checked = validateMarketOrder(
    prepared.intent,
    signed.components,
    signed.protocolAddress
  );
  if (
    checked.orderHash !== signed.orderHash ||
    (row.order_hash && !sameMarketAddress(row.order_hash, signed.orderHash))
  )
    mismatch('The durable signed order changed.');
  const safe = await deps.rpc.getBlock('safe');
  if (!safe?.hash) return;
  const read = async (method: string, args: string[]) =>
    seaportState.decodeFunctionResult(
      method,
      await deps.rpc.call({
        to: MARKET_SEAPORT,
        data: seaportState.encodeFunctionData(method, args),
        blockTag: safe.number
      })
    );
  const [status, counter] = await Promise.all([
    read('getOrderStatus', [signed.orderHash]),
    read('getCounter', [signed.components.offerer])
  ]);
  const canonical = await deps.rpc.getBlock(safe.number);
  if (!canonical?.hash || canonical.hash !== safe.hash)
    return persist(row, deps, 'UNKNOWN', { errorCode: 'SAFE_BLOCK_CHANGED' });
  const filled = BigInt(status[2]),
    size = BigInt(status[3]),
    total = BigInt(prepared.intent.quantity);
  if (
    filled < BigInt(0) ||
    size < BigInt(0) ||
    filled > size ||
    (size === BigInt(0) && filled !== BigInt(0))
  )
    mismatch('Invalid safe order status.');
  const filledQuantity =
    size === BigInt(0) ? BigInt(0) : (total * filled) / size;
  if (size > BigInt(0) && (total * filled) % size !== BigInt(0))
    mismatch('The confirmed NFT fill quantity is not integral.');
  const settlement: MarketSettlement = {
    filledQuantity: filledQuantity.toString(),
    remainingQuantity: (total - filledQuantity).toString(),
    safeBlockNumber: safe.number
  };
  let state = row.state,
    liability: string | undefined;
  if (
    Boolean(status[1]) ||
    BigInt(counter[0]) > BigInt(signed.components.counter)
  ) {
    state = 'CANCELLED';
    liability = '0';
  } else if (size > BigInt(0) && filled === size) {
    state = 'CONFIRMED';
    liability = '0';
  } else if (BigInt(safe.timestamp) >= BigInt(signed.components.endTime)) {
    state = 'EXPIRED';
    liability = '0';
  } else if (filled > BigInt(0)) {
    state = 'LIVE';
    if (prepared.intent.kind === 'OFFER')
      liability = (
        (BigInt(prepared.intent.maxTotalWei) * (size - filled) +
          size -
          BigInt(1)) /
        size
      ).toString();
  }
  const previous = (
    prepared as MarketPrepared & { settlement?: MarketSettlement }
  ).settlement;
  // Safe-head advances alone do not create an unbounded stream of identical events.
  const changed =
    previous?.filledQuantity !== settlement.filledQuantity ||
    previous?.remainingQuantity !== settlement.remainingQuantity;
  return persist(row, deps, state, {
    ...(changed ? { prepared: { ...prepared, settlement } } : {}),
    ...(liability !== undefined && liability !== row.liability_wei
      ? { liabilityWei: liability }
      : {})
  });
}

/** No provider status, lost approval or temporary balance can release a signed liability. */
export async function reconcileMarketOperation(
  row: MarketOperationRow,
  dependencies?: MarketReconcileDependencies
): Promise<void> {
  // Approval sends have their own receipt/permission reconciler. An unknown
  // final send cannot be inferred from unrelated order status either.
  if (operationSendAttempt(row)?.status === 'ACTIVE') return;
  const prepared = preparedFrom(row),
    kind = kindFrom(row);
  if (!prepared || !kind) return;
  let deps = dependencies;
  if (!deps) {
    const [{ marketChain }, { marketOperationsDb }] = await Promise.all([
      import('@/marketplace/market-chain'),
      import('@/marketplace/market-operations.db')
    ]);
    deps = {
      rpc: marketChain().rpc,
      transition: marketOperationsDb.transition.bind(marketOperationsDb)
    };
  }
  try {
    if (row.transaction_hash && submittedStates.includes(row.state))
      await reconcileSubmitted(row, prepared, kind, deps);
    else if (
      signedStates.includes(row.state) &&
      !isMarketBatchPrepared(prepared)
    )
      await reconcileSigned(row, prepared, deps);
  } catch (error) {
    // A competing reconciliation may already have committed a newer state. Never
    // overwrite it or reinterpret RPC/provider failures as an economic release.
    if (error instanceof MarketValidationError) {
      try {
        await persist(row, deps, 'UNKNOWN', {
          errorCode: 'RECONCILIATION_MISMATCH'
        });
      } catch (persistError) {
        if (
          !(persistError instanceof CustomApiCompliantException) ||
          persistError.getStatusCode() !== 409 ||
          persistError.code !== 'OPERATION_CHANGED'
        )
          throw persistError;
        // Another reconciler advanced the row. The caller reads its current state.
      }
    }
  }
}
