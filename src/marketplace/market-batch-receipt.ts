import { Interface } from 'ethers';
import {
  MarketBatchPrepared,
  MarketBatchSettlement
} from '@/marketplace/market-batch.types';
import type {
  MarketReceiptEvidence,
  MarketTransactionEvidence
} from '@/marketplace/market-reconciliation';
import { batchPreparedMaterials } from '@/marketplace/market-batch-materials';
import { validateMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';
import { rejectMarketBatch } from '@/marketplace/market-batch-validation';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  marketSpender
} from '@/marketplace/seaport.registry';
import { sameMarketAddress } from '@/marketplace/quote-validation';
import {
  decodeMarketOrderFulfilled,
  MARKET_SEAPORT_EVENTS,
  MarketFulfillmentEvent
} from '@/marketplace/seaport.events';

export const MARKET_BATCH_RECEIPT_EVENTS = new Interface([
  'event OrdersMatched(bytes32[] orderHashes)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

function sellerEvent(
  prepared: MarketBatchPrepared,
  index: number,
  event: MarketFulfillmentEvent
): void {
  const line = prepared.intent.items[index],
    order = prepared.reviewOrders[index];
  const scale = (amount: string) =>
    (
      (BigInt(amount) * BigInt(line.intent.quantity)) /
      BigInt(order.components.offer[0].startAmount)
    ).toString();
  const item = (entry: (typeof order.components.offer)[number]) => ({
    itemType: entry.itemType,
    token: entry.token.toLowerCase(),
    tokenId: entry.identifierOrCriteria,
    amount: scale(entry.startAmount)
  });
  if (
    !sameMarketAddress(event.offerer, order.components.offerer) ||
    !sameMarketAddress(event.zone, order.components.zone) ||
    !sameMarketAddress(event.recipient, prepared.intent.wallet) ||
    JSON.stringify(event.offer) !==
      JSON.stringify(order.components.offer.map(item)) ||
    JSON.stringify(event.consideration) !==
      JSON.stringify(
        order.components.consideration.map((entry) => ({
          ...item(entry),
          recipient: entry.recipient.toLowerCase()
        }))
      )
  )
    rejectMarketBatch(
      'A selected order receipt changed its exact fill or native payment terms.'
    );
}

function mirrorEvent(
  prepared: MarketBatchPrepared,
  event: MarketFulfillmentEvent
): void {
  const consideration = prepared.intent.items.flatMap((line) =>
    line.allocations.map((allocation) => ({
      itemType: line.intent.asset.standard === 'ERC721' ? 2 : 3,
      token: line.intent.asset.contract.toLowerCase(),
      tokenId: line.intent.asset.tokenId,
      amount: allocation.quantity,
      recipient: allocation.recipient.toLowerCase()
    }))
  );
  const offer = [
    {
      itemType: 0,
      token: MARKET_ZERO_ADDRESS,
      tokenId: '0',
      amount: prepared.intent.totalWei
    }
  ];
  if (
    !sameMarketAddress(event.offerer, prepared.intent.wallet) ||
    !sameMarketAddress(event.zone, MARKET_ZERO_ADDRESS) ||
    !sameMarketAddress(event.recipient, prepared.intent.wallet) ||
    JSON.stringify(event.offer) !== JSON.stringify(offer) ||
    JSON.stringify(event.consideration) !== JSON.stringify(consideration)
  )
    rejectMarketBatch(
      'The buyer mirror receipt does not contain every reviewed allocation.'
    );
}

function key(
  contract: string,
  tokenId: string,
  from: string,
  to: string,
  operator: string
): string {
  return `${contract.toLowerCase()}:${tokenId}:${from.toLowerCase()}:${to.toLowerCase()}:${operator.toLowerCase()}`;
}
function add(map: Map<string, bigint>, entry: string, quantity: bigint): void {
  map.set(entry, (map.get(entry) ?? BigInt(0)) + quantity);
}

function exactTransfers(
  prepared: MarketBatchPrepared,
  receipt: MarketReceiptEvidence
): void {
  const expected = new Map<string, bigint>(),
    actual = new Map<string, bigint>();
  const contracts = new Set(
    prepared.intent.items.map((line) =>
      line.intent.asset.contract.toLowerCase()
    )
  );
  prepared.intent.items.forEach((line, index) => {
    const order = prepared.reviewOrders[index].components;
    const operator =
      line.intent.asset.standard === 'ERC1155'
        ? marketSpender(order.conduitKey)
        : '';
    for (const allocation of line.allocations)
      add(
        expected,
        key(
          line.intent.asset.contract,
          line.intent.asset.tokenId,
          order.offerer,
          allocation.recipient,
          operator
        ),
        BigInt(allocation.quantity)
      );
  });
  for (const log of receipt.logs) {
    if (!contracts.has(log.address.toLowerCase())) continue;
    const topic = log.topics[0];
    if (
      !['Transfer', 'TransferSingle', 'TransferBatch'].some(
        (name) =>
          MARKET_BATCH_RECEIPT_EVENTS.getEvent(name)!.topicHash === topic
      )
    )
      continue;
    const event = MARKET_BATCH_RECEIPT_EVENTS.parseLog({
      topics: Array.from(log.topics),
      data: log.data
    });
    if (!event) rejectMarketBatch('An NFT transfer receipt is malformed.');
    const from = String(event.args.from),
      to = String(event.args.to);
    if (event.name === 'Transfer')
      add(
        actual,
        key(log.address, event.args.tokenId.toString(), from, to, ''),
        BigInt(1)
      );
    if (event.name === 'TransferSingle')
      add(
        actual,
        key(
          log.address,
          event.args.id.toString(),
          from,
          to,
          String(event.args.operator)
        ),
        BigInt(event.args.value)
      );
    if (event.name === 'TransferBatch') {
      const ids = event.args.ids as readonly bigint[],
        values = event.args[4] as readonly bigint[];
      if (ids.length !== values.length)
        rejectMarketBatch('An NFT transfer batch is malformed.');
      ids.forEach((id, index) =>
        add(
          actual,
          key(
            log.address,
            id.toString(),
            from,
            to,
            String(event.args.operator)
          ),
          values[index]
        )
      );
    }
  }
  if (
    actual.size !== expected.size ||
    Array.from(expected).some(([entry, amount]) => actual.get(entry) !== amount)
  )
    rejectMarketBatch(
      'The receipt does not prove every exact NFT delivery without additional transfers.'
    );
}

/** Canonical receipt/block safety is applied by the shared reconciler after this exact proof. */
export function validateMarketBatchReceipt(
  prepared: MarketBatchPrepared,
  transaction: MarketTransactionEvidence,
  receipt: MarketReceiptEvidence
): MarketBatchSettlement {
  const expected = prepared.transaction;
  if (
    receipt.status !== 1 ||
    receipt.blockNumber <= prepared.snapshot.block_number ||
    transaction.chainId !== BigInt(1) ||
    !sameMarketAddress(transaction.hash, receipt.hash) ||
    !sameMarketAddress(transaction.from, expected.from) ||
    !transaction.to ||
    !sameMarketAddress(transaction.to, MARKET_SEAPORT) ||
    transaction.data.toLowerCase() !== expected.data.toLowerCase() ||
    transaction.value !== BigInt(expected.value)
  )
    rejectMarketBatch(
      'The receipt does not belong to the exact reviewed batch transaction.'
    );
  validateMarketBatchTransaction(
    prepared.intent,
    batchPreparedMaterials(prepared),
    prepared.mirrorTerms,
    expected
  );
  const seaport = receipt.logs.filter((log) =>
    sameMarketAddress(log.address, MARKET_SEAPORT)
  );
  const fulfilled = seaport
    .filter(
      (log) =>
        log.topics[0] ===
        MARKET_SEAPORT_EVENTS.getEvent('OrderFulfilled')!.topicHash
    )
    .map(decodeMarketOrderFulfilled);
  if (fulfilled.length !== prepared.reviewOrders.length + 1)
    rejectMarketBatch(
      'Every selected order and the buyer mirror must fulfill exactly once.'
    );
  const sellerHashes = prepared.reviewOrders.map((order) =>
    order.orderHash.toLowerCase()
  );
  sellerHashes.forEach((hash, index) => {
    const events = fulfilled.filter((event) => event.orderHash === hash);
    if (events.length !== 1)
      rejectMarketBatch(
        'A selected seller order is missing or duplicated in the receipt.'
      );
    sellerEvent(prepared, index, events[0]);
  });
  const mirrors = fulfilled.filter(
    (event) => !sellerHashes.includes(event.orderHash)
  );
  if (mirrors.length !== 1)
    rejectMarketBatch('The buyer mirror receipt is missing or duplicated.');
  mirrorEvent(prepared, mirrors[0]);
  const matched = seaport.filter(
    (log) =>
      log.topics[0] ===
      MARKET_BATCH_RECEIPT_EVENTS.getEvent('OrdersMatched')!.topicHash
  );
  if (matched.length !== 1)
    rejectMarketBatch(
      'The receipt must contain exactly one complete OrdersMatched event.'
    );
  const matchedHashes = Array.from(
    MARKET_BATCH_RECEIPT_EVENTS.decodeEventLog(
      'OrdersMatched',
      matched[0].data,
      Array.from(matched[0].topics)
    ).orderHashes as readonly string[],
    (hash) => hash.toLowerCase()
  );
  // The unsigned mirror's hash uses the payer's counter at execution. Bind its
  // event contents and exact matched membership rather than a stale preview hash.
  if (
    JSON.stringify(matchedHashes) !==
    JSON.stringify([...sellerHashes, mirrors[0].orderHash])
  )
    rejectMarketBatch(
      'OrdersMatched does not contain exactly the reviewed seller orders and buyer mirror.'
    );
  exactTransfers(prepared, receipt);
  return {
    outcome: 'ALL_SELECTED',
    items: prepared.intent.items.map((line) => ({
      assetKey: line.assetKey,
      order: line.intent.order!,
      filledQuantity: line.intent.quantity,
      allocations: line.allocations
    })),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash
  };
}
