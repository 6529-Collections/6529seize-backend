import { MarketBatchIntent } from '@/marketplace/market-batch.types';
import { ValidatedMarketOrder } from '@/marketplace/provider.types';
import { rejectMarketBatch } from '@/marketplace/market-batch-validation';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';

export interface DecodedItem {
  itemType: bigint;
  token: string;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
  recipient?: string;
}
interface DecodedOrder {
  parameters: {
    offerer: string;
    offer: readonly DecodedItem[];
    consideration: readonly DecodedItem[];
  };
  numerator: bigint;
  denominator: bigint;
}
interface DecodedComponent {
  orderIndex: bigint;
  itemIndex: bigint;
}
interface DecodedFulfillment {
  offerComponents: readonly DecodedComponent[];
  considerationComponents: readonly DecodedComponent[];
}
interface InventoryEntry {
  item: DecodedItem;
  remaining: bigint;
}
type Ledger = Map<string, bigint>;

function add(ledger: Ledger, key: string, amount: bigint): void {
  ledger.set(key, (ledger.get(key) ?? BigInt(0)) + amount);
}
function flowKey(
  order: number,
  type: string,
  token: string,
  identifier: string,
  recipient: string
): string {
  return `${order}:${type}:${token.toLowerCase()}:${identifier}:${recipient.toLowerCase()}`;
}
function inventory(
  orders: readonly DecodedOrder[],
  side: 'offer' | 'consideration'
): Map<string, InventoryEntry> {
  const entries = new Map<string, InventoryEntry>();
  orders.forEach((order, orderIndex) => {
    if (
      order.denominator <= BigInt(0) ||
      order.numerator <= BigInt(0) ||
      order.numerator > order.denominator
    )
      rejectMarketBatch('Every order requires a positive exact fill fraction.');
    order.parameters[side].forEach((item, itemIndex) => {
      const product = item.startAmount * order.numerator;
      if (
        item.startAmount !== item.endAmount ||
        product <= BigInt(0) ||
        product % order.denominator !== BigInt(0)
      )
        rejectMarketBatch('Every batch item and fee must divide exactly.');
      entries.set(`${orderIndex}:${itemIndex}`, {
        item,
        remaining: product / order.denominator
      });
    });
  });
  return entries;
}
function component(
  entries: Map<string, InventoryEntry>,
  values: readonly DecodedComponent[]
): { entry: InventoryEntry; orderIndex: number } {
  if (values.length !== 1)
    rejectMarketBatch(
      'Batch mappings require one exact source and destination.'
    );
  const reference = values[0];
  const entry = entries.get(`${reference.orderIndex}:${reference.itemIndex}`);
  if (!entry || entry.remaining <= BigInt(0))
    rejectMarketBatch(
      'A batch mapping is missing, duplicated or already consumed.'
    );
  return { entry, orderIndex: Number(reference.orderIndex) };
}
function expectedLedger(
  intent: MarketBatchIntent,
  orders: ValidatedMarketOrder[]
): Ledger {
  const expected: Ledger = new Map();
  intent.items.forEach((line, index) => {
    for (const allocation of line.allocations)
      add(
        expected,
        flowKey(
          index,
          line.intent.asset.standard === 'ERC721' ? '2' : '3',
          line.intent.asset.contract,
          line.intent.asset.tokenId,
          allocation.recipient
        ),
        BigInt(allocation.quantity)
      );
    const fees = line.intent.fees.reduce(
      (sum, fee) => sum + BigInt(fee.amountWei),
      BigInt(0)
    );
    add(
      expected,
      flowKey(
        index,
        '0',
        MARKET_ZERO_ADDRESS,
        '0',
        orders[index].components.offerer
      ),
      BigInt(line.intent.maxTotalWei) - fees
    );
    for (const fee of line.intent.fees)
      add(
        expected,
        flowKey(index, '0', MARKET_ZERO_ADDRESS, '0', fee.recipient),
        BigInt(fee.amountWei)
      );
  });
  return expected;
}

/** Independent conservation model: no calls to the transaction/mapping builder. */
export function assertMarketBatchFlowLedger(
  intent: MarketBatchIntent,
  checked: ValidatedMarketOrder[],
  orders: readonly DecodedOrder[],
  fulfillments: readonly DecodedFulfillment[]
): void {
  if (
    orders.length !== intent.items.length + 1 ||
    checked.length !== intent.items.length
  )
    rejectMarketBatch(
      'All selected seller orders and the payer mirror are required.'
    );
  const offers = inventory(orders, 'offer');
  const considerations = inventory(orders, 'consideration');
  const actual: Ledger = new Map();
  for (const fulfillment of fulfillments) {
    const source = component(offers, fulfillment.offerComponents);
    const destination = component(
      considerations,
      fulfillment.considerationComponents
    );
    const offered = source.entry.item;
    const received = destination.entry.item;
    const native = offered.itemType === BigInt(0);
    const seller = native ? destination.orderIndex : source.orderIndex;
    if (
      offered.itemType !== received.itemType ||
      offered.token.toLowerCase() !== received.token.toLowerCase() ||
      offered.identifierOrCriteria !== received.identifierOrCriteria ||
      !received.recipient ||
      seller >= intent.items.length ||
      (native ? source.orderIndex : destination.orderIndex) !==
        intent.items.length ||
      (!native &&
        offered.itemType !== BigInt(2) &&
        offered.itemType !== BigInt(3))
    )
      rejectMarketBatch(
        'A batch mapping changes an asset, recipient or payment direction.'
      );
    const amount =
      source.entry.remaining < destination.entry.remaining
        ? source.entry.remaining
        : destination.entry.remaining;
    source.entry.remaining -= amount;
    destination.entry.remaining -= amount;
    add(
      actual,
      flowKey(
        seller,
        offered.itemType.toString(),
        offered.token,
        offered.identifierOrCriteria.toString(),
        received.recipient
      ),
      amount
    );
  }
  if (
    [
      ...Array.from(offers.values()),
      ...Array.from(considerations.values())
    ].some((entry) => entry.remaining !== BigInt(0))
  )
    rejectMarketBatch(
      'Every selected NFT, allocation and payment must be fully consumed.'
    );
  const expected = expectedLedger(intent, checked);
  if (
    actual.size !== expected.size ||
    Array.from(expected).some(([key, amount]) => actual.get(key) !== amount)
  )
    rejectMarketBatch(
      'Decoded NFT allocations and native payments differ from the reviewed intent.'
    );
}
