import { Interface } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import type { MarketOperationPrepared } from '@/marketplace/market-operation.types';
import { isMarketBatchPrepared } from '@/marketplace/market-operation.types';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import type { MarketReceiptPayment } from '@/marketplace/market-receipt-evidence';
import { validateMarketOrder } from '@/marketplace/quote-validation';
import { marketReceiptRead } from '@/marketplace/market-receipt-evidence';
import type { MarketSettlement } from '@/marketplace/market-reconciliation';
import type { MarketPrepared } from '@/marketplace/market-preparation';

const state = new Interface([
  'function getOrderStatus(bytes32) view returns (bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)'
]);

/** Supplemental unavailability cannot erase evidence already verified for the
 * same canonical transaction. A newly proven inclusion in another block replaces it. */
export function mergeMarketReceiptSupplement(
  previous: MarketOperationPrepared,
  incoming: MarketOperationPrepared
): MarketOperationPrepared {
  const oldReceipt = previous.receipt;
  if (oldReceipt && incoming.receipt) {
    const samePrimary = incoming.receipt.transactions.some(
      (entry) =>
        entry.purpose === 'TRANSACTION' &&
        oldReceipt.transactions.some(
          (old) =>
            old.purpose === 'TRANSACTION' &&
            old.transactionHash === entry.transactionHash &&
            old.blockHash === entry.blockHash
        )
    );
    const incomingHashes = new Set(
      incoming.receipt.transactions.map((entry) => entry.transactionHash)
    );
    incoming = {
      ...incoming,
      receipt: {
        ...(samePrimary && oldReceipt.payment
          ? { payment: oldReceipt.payment }
          : {}),
        ...incoming.receipt,
        transactions: [
          ...oldReceipt.transactions.filter(
            (entry) =>
              entry.confirmation === 'CONFIRMED' &&
              !incomingHashes.has(entry.transactionHash)
          ),
          ...incoming.receipt.transactions.map((entry) => {
            const old = oldReceipt.transactions.find(
              (candidate) =>
                candidate.transactionHash === entry.transactionHash &&
                candidate.blockHash === entry.blockHash
            );
            return old
              ? {
                  ...old,
                  ...entry,
                  ...(old.safeBlockNumber === undefined
                    ? {}
                    : { safeBlockNumber: old.safeBlockNumber })
                }
              : entry;
          })
        ]
      }
    };
  }
  if (isMarketBatchPrepared(previous) && isMarketBatchPrepared(incoming)) {
    const old = previous.settlement,
      next = incoming.settlement;
    if (
      old &&
      next &&
      old.blockHash === next.blockHash &&
      old.transactionHash === next.transactionHash
    )
      incoming = {
        ...incoming,
        settlement: {
          ...old,
          ...next,
          items: next.items.map((item) => ({
            ...old.items.find(
              (candidate) =>
                candidate.order.orderHash === item.order.orderHash &&
                candidate.assetKey === item.assetKey
            ),
            ...item
          }))
        }
      };
  } else if (
    !isMarketBatchPrepared(previous) &&
    !isMarketBatchPrepared(incoming)
  ) {
    const old = (previous as MarketPrepared & { settlement?: MarketSettlement })
      .settlement;
    const next = (
      incoming as MarketPrepared & { settlement?: MarketSettlement }
    ).settlement;
    if (
      old &&
      next &&
      old.blockHash === next.blockHash &&
      old.transactionHash === next.transactionHash
    )
      incoming = {
        ...incoming,
        settlement: { ...old, ...next }
      } as MarketPrepared & { settlement: MarketSettlement };
  }
  return incoming;
}

/** Call only after exact receipt validation, never from an unsigned quote. */
export function settledMarketPayment(
  prepared: MarketOperationPrepared
): MarketReceiptPayment | undefined {
  try {
    return deriveSettledMarketPayment(prepared);
  } catch {
    // The exact fulfillment proof already determines settlement. Optional
    // presentation metadata must not reinterpret a confirmed transaction.
    return undefined;
  }
}

function deriveSettledMarketPayment(
  prepared: MarketOperationPrepared
): MarketReceiptPayment | undefined {
  if (isMarketBatchPrepared(prepared)) {
    const fills = prepared.intent.items.map((line, index) =>
      validateMarketOrder(
        line.intent,
        prepared.reviewOrders[index].components,
        prepared.reviewOrders[index].protocolAddress
      )
    );
    return {
      currency: prepared.intent.currency,
      totalWei: fills
        .reduce((total, fill) => total + BigInt(fill.totalWei), BigInt(0))
        .toString(),
      netWei: fills
        .reduce((total, fill) => total + BigInt(fill.netWei), BigInt(0))
        .toString(),
      // Preserve each proven source-order fee, including a repeated recipient.
      fees: fills.flatMap((fill) => fill.fees)
    };
  }
  if (
    !['BUY', 'ACCEPT'].includes(prepared.intent.kind) ||
    !prepared.reviewOrder
  )
    return undefined;
  const fill = validateMarketOrder(
    prepared.intent,
    prepared.reviewOrder.components,
    prepared.reviewOrder.protocolAddress
  );
  return {
    currency: prepared.intent.currency,
    totalWei: fill.totalWei,
    netWei: fill.netWei,
    fees: fill.fees,
    payoutWallet:
      prepared.intent.kind === 'ACCEPT'
        ? prepared.intent.wallet
        : prepared.reviewOrder.components.offerer
  };
}

function receiptSourceOrders(prepared: MarketOperationPrepared) {
  if (isMarketBatchPrepared(prepared)) return prepared.reviewOrders;
  if (prepared.reviewOrder && ['BUY', 'ACCEPT'].includes(prepared.intent.kind))
    return [prepared.reviewOrder];
  return [];
}

function exactSourceRemaining(
  original: bigint,
  requested: bigint,
  cancelled: boolean,
  filled: bigint,
  size: bigint
): string | undefined {
  // Receipt proof establishes a fill: an unfilled status cannot corroborate it.
  if (size <= BigInt(0) || filled <= BigInt(0) || filled > size)
    return undefined;
  const filledUnits = original * filled;
  if (filledUnits % size !== BigInt(0) || filledUnits / size < requested)
    return undefined;
  const numerator = original * (size - filled);
  if (numerator % size !== BigInt(0)) return undefined;
  return cancelled ? '0' : (numerator / size).toString();
}

/** Whole signed-order availability at a pinned safe block. A missing read must
 * not delay success or be replaced by this operation's remaining quantity. */
export async function settledMarketOrderRemaining(
  prepared: MarketOperationPrepared,
  rpc: Pick<JsonRpcProvider, 'call' | 'getBlock'>,
  safe: { number: number; hash: string | null }
): Promise<Map<string, string>> {
  const remaining = new Map<string, string>();
  if (!safe.hash) return remaining;
  const orders = receiptSourceOrders(prepared);
  if (!orders.length) return remaining;
  const deadline = Date.now() + 2000;
  try {
    for (let index = 0; index < orders.length; index++) {
      const order = orders[index];
      try {
        const status = state.decodeFunctionResult(
          'getOrderStatus',
          await marketReceiptRead(
            () =>
              rpc.call({
                to: MARKET_SEAPORT,
                data: state.encodeFunctionData('getOrderStatus', [
                  order.orderHash
                ]),
                blockTag: safe.number
              }),
            deadline
          )
        );
        const original = BigInt(
          prepared.intent.kind === 'ACCEPT'
            ? order.components.consideration[0].startAmount
            : order.components.offer[0].startAmount
        );
        const requested = BigInt(
          isMarketBatchPrepared(prepared)
            ? prepared.intent.items[index].intent.quantity
            : prepared.intent.quantity
        );
        const quantity = exactSourceRemaining(
          original,
          requested,
          Boolean(status[1]),
          BigInt(status[2]),
          BigInt(status[3])
        );
        if (quantity !== undefined)
          remaining.set(order.orderHash.toLowerCase(), quantity);
      } catch {
        // Supplemental order availability may arrive later than the receipt.
      }
    }
    const canonical = await marketReceiptRead(
      () => rpc.getBlock(safe.number),
      deadline
    );
    return canonical?.hash === safe.hash ? remaining : new Map();
  } catch {
    return new Map();
  }
}
